//! Enemy waves and bot AI.
//!
//! Bots fly the same aerodynamic model as the player (`aero.rs`): the AI only chooses a
//! direction to fly, a throttle setting and how hard it may pull, and an autopilot turns
//! that into stick inputs. So bots bleed energy in hard turns, can stall and must watch
//! the ground. Tactics: patrol, attack (lead / pure / lag pursuit), break turn against an
//! attacker on the tail, missile evasion with flares, and recovery when low or slow.

use std::f32::consts::PI;

use super::aero;
use super::Game;
use crate::config::*;
use crate::entities::*;
use crate::layout::{event, MAX_BOTS};
use crate::math::{clamp, V3, RIGHT, UP};

const BOT_BULLET_SPEED: f32 = 950.0;
const B2_TAIL_GUN_SPEED: f32 = 900.0;
const B2_TAIL_GUN_RANGE: f32 = 900.0;
const PURSUIT_RANGE: f32 = 9000.0;
/// Bots only hunt a player above this height (no strafing the runway).
const HUNT_MIN_ALTITUDE: f32 = 40.0;
/// Below this height, or when pulling out of the current dive would bottom out below
/// FLOOR_MARGIN, a bot gives up everything else and climbs.
const FLOOR: f32 = 250.0;
const FLOOR_MARGIN: f32 = 150.0;
/// Seconds a bot needs to roll wings level before it can pull.
const RECOVERY_REACTION: f32 = 1.5;
/// Steepest dive (sine of the path angle) a bomber will fly.
const B2_MAX_DIVE: f32 = 0.2;
const CEILING: f32 = 6000.0;
/// An incoming missile closer than this makes a bot evade.
const EVADE_RANGE: f32 = 4000.0;
/// An attacker on the tail closer than this makes a bot break.
const BREAK_RANGE: f32 = 1500.0;

/// The aircraft a bot hunts during one update.
#[derive(Clone, Copy)]
struct Quarry {
    track: Track,
    pos: V3,
    vel: V3,
    /// Airborne and high enough to be attacked.
    huntable: bool,
}

/// What the tactics layer asks of the autopilot.
struct Intent {
    dir: V3,
    throttle: f32,
    /// Largest stick deflection the autopilot may pull (how hard the bot turns).
    max_pull: f32,
    brake: bool,
}

/// Wraps an angle to [-PI, PI].
fn wrap(a: f32) -> f32 {
    (a + PI).rem_euclid(2.0 * PI) - PI
}

/// Turns a desired flight direction into stick inputs: roll the lift vector onto the
/// target, then pull. Bank is limited to `max_bank` (rad): beyond it the aircraft turns
/// in that bank and the flight controls' trim holds the turn level, so a bomber never
/// rolls inverted into a diving pull-through. Close to the nose it flies wings level and
/// fine-tunes pitch.
pub(super) fn autopilot(af: &Airframe, desired: V3, max_pull: f32, max_bank: f32) -> (f32, f32) {
    let local = af.q.conj().rotate(desired.norm());
    let ahead = -local.z;
    let off = local.x.hypot(local.y).atan2(ahead);
    // Extra bank needed to put the target straight above the canopy.
    let roll_err = local.x.atan2(local.y);
    let right = af.q.rotate(RIGHT);
    let up = af.q.rotate(UP);
    // Bank angle, positive to the right (the way a positive roll input turns).
    let bank = (-right.y).atan2(up.y);
    let wanted = wrap(bank + roll_err);
    let target_bank = clamp(wanted, -max_bank, max_bank);
    let w = clamp((off - 0.03) / 0.15, 0.0, 1.0);
    let roll_to_target = wrap(target_bank - bank) * 2.5;
    let roll = clamp(w * roll_to_target - (1.0 - w) * bank * 1.5, -1.0, 1.0);
    // Pull only as far as the lift vector already points at the target.
    let pull = clamp(off * 4.0, 0.0, max_pull) * roll_err.cos().max(0.0);
    let fine = clamp(local.y.atan2(ahead) * 4.0, -0.4, max_pull);
    (w * pull + (1.0 - w) * fine, roll)
}

/// Steepest bank the autopilot may fly: a bomber turns at the bank its G limit can hold
/// level; a fighter may roll past the vertical (split-S, over-the-top) only high up and
/// in a fight.
fn max_bank(b: &Bot) -> f32 {
    if b.is_b2() {
        return (1.0 / (b.stats().g_limit * 0.8)).acos();
    }
    let fighting = matches!(b.tactic, Tactic::Attack | Tactic::Break | Tactic::Evade);
    if fighting && b.pos.y > 1800.0 { PI } else { 1.45 }
}

/// Height lost while rolling level and pulling out of the current dive at the G the
/// airframe allows: a circle of radius v^2 / (g (n - 1)) plus the sink during the roll.
fn pull_out_height(b: &Bot) -> f32 {
    let v = b.vel.len().max(1.0);
    let sink = (-b.vel.y).max(0.0);
    let dive = (sink / v).min(1.0).asin();
    let n = b.stats().g_limit * 0.8;
    let radius = v * v / (GRAVITY * (n - 1.0).max(0.8));
    radius * (1.0 - dive.cos()) + sink * RECOVERY_REACTION
}

impl Game {
    pub(super) fn spawn_wave(&mut self) {
        self.wave += 1;
        let wave = self.wave as f32;
        let base = 2.0 + wave * 3.0;
        let count = ((base * self.density * self.mode_wave_scale()).round() as usize).clamp(1, MAX_BOTS);
        let center = self.wave_center();
        let diff = self.difficulty();
        let mut spawned = 0;
        for slot in 0..MAX_BOTS {
            if spawned == count {
                break;
            }
            if self.bots[slot].alive {
                continue;
            }
            let ang = self.rng.range(0.0, 2.0 * PI);
            let dist = self.rng.range(3500.0, 6500.0);
            let pos = V3::new(center.x + ang.cos() * dist, self.rng.range(900.0, 2400.0), center.z + ang.sin() * dist);
            let fwd = center.sub(pos).flat().norm();
            // Enemy mix: mostly fighters; from wave 3 one B-2 per dozen enemies.
            let ty = if self.wave >= 3 && spawned % 12 == 0 && self.mode == super::Mode::Waves {
                B2
            } else {
                BOT_FIGHTERS[(self.rng.next() * 3.0) as usize % 3]
            };
            let is_b2 = ty == B2;
            let speed = if is_b2 { 170.0 } else { self.rng.range(200.0, 240.0) + wave * 6.0 };
            let hp = diff.hp * if is_b2 { 120.0 } else { 40.0 + wave * 4.0 };
            let mut b = Bot::spawn(ty, pos, fwd, speed, hp);
            b.af.thrust_scale = diff.speed;
            if !is_b2 {
                let cap = if self.difficulty == 0 { BOT_MISSILES_EASY } else { BOT_MISSILES };
                b.missiles = (wave - 1.0).clamp(0.0, cap);
            }
            b.fire_cd = self.rng.range(0.5, 2.0);
            b.missile_cd = self.rng.range(4.0, 10.0);
            b.jink = self.rng.range(0.0, 10.0);
            b.break_side = if self.rng.next() < 0.5 { -1.0 } else { 1.0 };
            self.bots[slot] = b;
            spawned += 1;
        }
        self.event(event::WAVE, center, wave);
    }

    /// Wave skill: grows with the wave number, scaled by the difficulty.
    fn skill(&self) -> f32 {
        (0.55 + self.wave as f32 * 0.06).min(1.15) * self.difficulty().skill
    }

    pub(super) fn update_bots(&mut self, dt: f32) {
        let skill = self.skill();
        let mut shots: Vec<(V3, V3)> = Vec::new();
        for i in 0..MAX_BOTS {
            if !self.bots[i].alive {
                continue;
            }
            let mut b = self.bots[i];
            b.jink += dt;
            b.fire_cd -= dt;
            b.missile_cd -= dt;
            b.flare_cd -= dt;
            let quarry = self.pick_quarry(&b);
            let intent = self.decide(&mut b, i, &quarry, skill);
            let (pitch, roll) = autopilot(&b.af, intent.dir, intent.max_pull, max_bank(&b));
            let inp = Input { pitch, roll, throttle: intent.throttle, brake: intent.brake, ..Input::default() };
            let air = self.weather.air_at(b.pos.y);
            aero::fly(&mut b.af, &inp, air, 0.0, dt);
            if b.pos.y <= 0.0 {
                self.bots[i] = b;
                self.destroy_bot(i, b.pos.flat(), !b.friendly);
                continue;
            }
            if !b.friendly {
                self.bot_gunnery(&mut b, &quarry, skill, &mut shots);
                self.bot_missiles(&mut b, &quarry, skill, dt);
            }
            if b.tactic == Tactic::Evade {
                self.bot_flares(&mut b, i, skill);
            }
            self.bots[i] = b;
        }
        for (pos, vel) in shots {
            self.spawn_bullet(pos, vel, Owner::Bot);
        }
    }

    /// Enemy bots hunt the nearest of the player and the friendly aircraft.
    fn pick_quarry(&self, b: &Bot) -> Quarry {
        let p = &self.player;
        let mut best = Quarry {
            track: Track::Player,
            pos: p.pos,
            vel: p.velocity(),
            huntable: p.airborne() && p.pos.y > HUNT_MIN_ALTITUDE,
        };
        if b.friendly {
            best.huntable = false;
            return best;
        }
        let mut best_dist = if best.huntable { p.pos.sub(b.pos).len() } else { f32::MAX };
        for (j, f) in self.bots.iter().enumerate() {
            if f.alive && f.friendly {
                let d = f.pos.sub(b.pos).len();
                if d < best_dist {
                    best_dist = d;
                    best = Quarry { track: Track::Bot(j), pos: f.pos, vel: f.vel, huntable: true };
                }
            }
        }
        best
    }

    /// Nearest live missile tracking aircraft `me`, if close.
    fn incoming_missile(&self, me: Track, pos: V3) -> Option<V3> {
        self.missiles
            .iter()
            .filter(|m| m.life > 0.0 && m.track == me)
            .map(|m| m.pos)
            .filter(|mp| mp.sub(pos).len() < EVADE_RANGE)
            .min_by(|a, b| a.sub(pos).len().total_cmp(&b.sub(pos).len()))
    }

    /// The player sitting on this bot's tail with the nose on it.
    fn attacker_on_tail(&self, b: &Bot) -> Option<V3> {
        let p = &self.player;
        if b.friendly || !p.airborne() {
            return None;
        }
        let to_p = p.pos.sub(b.pos);
        let dist = to_p.len();
        let behind = to_p.norm().dot(b.fwd()) < -0.4;
        let nose_on = b.pos.sub(p.pos).norm().dot(p.fwd()) > 0.9;
        (dist < BREAK_RANGE && behind && nose_on).then_some(p.pos)
    }

    /// Tactics: choose what to do this step and express it as an autopilot intent.
    fn decide(&mut self, b: &mut Bot, i: usize, quarry: &Quarry, skill: f32) -> Intent {
        let fwd = b.fwd();
        let flat_fwd = fwd.flat().norm();
        let stall_tas = b.stats().stall_speed / b.density.sqrt();
        let pull = if b.is_b2() { 0.6 } else { clamp(0.55 + 0.4 * skill, 0.5, 1.0) };

        // 1. Stay out of the ground: nothing else matters.
        if b.pos.y < FLOOR || b.pos.y - pull_out_height(b) < FLOOR_MARGIN {
            b.tactic = Tactic::Recover;
            return Intent { dir: flat_fwd.add(UP.mul(1.2)), throttle: 1.0, max_pull: 1.0, brake: false };
        }
        // Too slow to turn: unload and dive for speed.
        if b.speed < stall_tas * 1.25 {
            b.tactic = Tactic::Recover;
            return Intent { dir: flat_fwd.add(UP.mul(-0.35)), throttle: 1.0, max_pull: 0.3, brake: false };
        }

        let me = Track::Bot(i);
        let mut intent = if let Some(mp) = self.incoming_missile(me, b.pos) {
            // 2. Missile inbound: beam it (fly across its line of sight) with a cool engine.
            if b.tactic != Tactic::Evade {
                b.tactic = Tactic::Evade;
                let los = b.pos.sub(mp);
                b.break_side = if los.cross(fwd).y >= 0.0 { 1.0 } else { -1.0 };
            }
            let los = b.pos.sub(mp).flat().norm();
            let beam = los.cross(UP).mul(b.break_side);
            let dive = if b.pos.y > 1500.0 { -0.25 } else { 0.0 };
            Intent { dir: beam.add(V3::new(0.0, dive, 0.0)), throttle: 0.45, max_pull: 1.0, brake: false }
        } else if let Some(attacker) = self.attacker_on_tail(b) {
            // 3. Gun threat behind: max-G break turn into the attacker.
            if b.tactic != Tactic::Break {
                b.tactic = Tactic::Break;
                let right = b.q.rotate(RIGHT);
                b.break_side = if attacker.sub(b.pos).dot(right) >= 0.0 { 1.0 } else { -1.0 };
            }
            let side = flat_fwd.cross(UP).mul(-b.break_side);
            // Reverse now and then so the attacker cannot settle in.
            let reverse = if (b.jink * 0.35).sin() > 0.92 { -1.0 } else { 1.0 };
            Intent { dir: side.mul(reverse).add(flat_fwd.mul(0.3)), throttle: 1.0, max_pull: 1.0, brake: false }
        } else if b.friendly {
            b.tactic = Tactic::Escort;
            Intent { dir: b.waypoint.sub(b.pos), throttle: 0.75, max_pull: 0.6, brake: false }
        } else if quarry.huntable && quarry.pos.sub(b.pos).len() < PURSUIT_RANGE {
            b.tactic = Tactic::Attack;
            self.pursuit(b, quarry, pull)
        } else {
            b.tactic = Tactic::Patrol;
            let dir = self.wander_dir(b, quarry.pos);
            Intent { dir, throttle: 0.7, max_pull: 0.5, brake: false }
        };

        // Altitude band.
        if b.pos.y > CEILING {
            intent.dir = intent.dir.norm();
            intent.dir.y = intent.dir.y.min(-0.2);
        }
        if b.is_b2() {
            intent.dir = intent.dir.norm();
            intent.dir.y = intent.dir.y.max(-B2_MAX_DIVE);
        }
        intent
    }

    /// Pursuit geometry: lead to bring the guns to bear, lag when closing too fast,
    /// pure-ish pursuit from afar.
    fn pursuit(&self, b: &Bot, q: &Quarry, pull: f32) -> Intent {
        let to_q = q.pos.sub(b.pos);
        let dist = to_q.len();
        let los = to_q.mul(1.0 / dist.max(1.0));
        let closure = b.vel.sub(q.vel).dot(los);
        // About to collide: pull off to the side and come around again.
        if dist < 250.0 && los.dot(b.fwd()) > 0.5 {
            let off = b.fwd().cross(UP).norm().add(V3::new(0.0, 0.3, 0.0));
            return Intent { dir: off, throttle: 1.0, max_pull: 1.0, brake: false };
        }
        if dist < 900.0 && closure > 120.0 {
            // Lag pursuit: aim behind the target and slow down to avoid an overshoot.
            let aim = q.pos.sub(q.vel.mul(0.6)).sub(b.pos);
            return Intent { dir: aim, throttle: 0.2, max_pull: pull, brake: true };
        }
        let t = if dist < 1800.0 { dist / BOT_BULLET_SPEED } else { (dist / 1100.0).min(2.0) };
        let mut aim = q.pos.add(q.vel.mul(t)).sub(b.pos).norm();
        if dist > 2500.0 {
            // Weave on the way in so the bot is not a trivial missile target.
            let weave = (b.jink * 0.9).sin() * 0.25;
            aim = aim.add(b.fwd().cross(UP).norm().mul(weave));
        }
        let throttle = if dist < 600.0 && closure > 0.0 { 0.5 } else { 1.0 };
        Intent { dir: aim, throttle, max_pull: pull, brake: false }
    }

    /// Direction toward the bot's patrol waypoint, picking a new one near the player when reached.
    fn wander_dir(&mut self, b: &mut Bot, around: V3) -> V3 {
        let needs_waypoint =
            b.pos.sub(b.waypoint).len() < 400.0 || b.waypoint.y == 0.0 || b.waypoint.y == b.pos.y;
        if needs_waypoint {
            let a = self.rng.range(0.0, 2.0 * PI);
            let r = self.rng.range(1500.0, 5000.0);
            b.waypoint = V3::new(around.x + a.cos() * r, self.rng.range(800.0, 2200.0), around.z + a.sin() * r);
        }
        b.waypoint.sub(b.pos).norm()
    }

    fn bot_gunnery(&mut self, b: &mut Bot, quarry: &Quarry, skill: f32, shots: &mut Vec<(V3, V3)>) {
        let to_q = quarry.pos.sub(b.pos);
        let dist = to_q.len();
        let diff = self.difficulty();
        let fwd = b.fwd();
        if quarry.huntable && dist < diff.gun_range && b.fire_cd <= 0.0 && !b.is_b2() {
            let aim = to_q.norm().dot(fwd);
            if aim > diff.aim_cone {
                b.fire_cd = 0.11 / skill;
                let spread = 0.012 / skill;
                let jitter = V3::new(
                    self.rng.range(-spread, spread),
                    self.rng.range(-spread, spread),
                    self.rng.range(-spread, spread),
                );
                let dir = fwd.add(jitter).norm();
                shots.push((b.pos.add(fwd.mul(10.0)), dir.mul(BOT_BULLET_SPEED).add(b.velocity())));
            } else {
                b.fire_cd = 0.1;
            }
        }
        // B-2 bots defend themselves with a tail gun burst.
        if b.is_b2() && quarry.huntable && dist < B2_TAIL_GUN_RANGE && b.fire_cd <= 0.0 {
            b.fire_cd = 0.25;
            let dir = to_q.norm();
            shots.push((b.pos.add(dir.mul(25.0)), dir.mul(B2_TAIL_GUN_SPEED)));
        }
    }

    /// Seeker lock while the quarry sits in the nose cone at missile range, then launch.
    fn bot_missiles(&mut self, b: &mut Bot, quarry: &Quarry, skill: f32, dt: f32) {
        let to_q = quarry.pos.sub(b.pos);
        let dist = to_q.len();
        let in_cone = to_q.norm().dot(b.fwd()) > BOT_LOCK_CONE_DEG.to_radians().cos();
        let in_range = (BOT_MISSILE_MIN_RANGE..BOT_MISSILE_MAX_RANGE).contains(&dist);
        let can_lock = quarry.huntable && b.missiles > 0.0 && in_cone && in_range;
        b.locking_player = can_lock && quarry.track == Track::Player;
        if !can_lock {
            b.lock = (b.lock - dt).max(0.0);
            return;
        }
        b.lock = (b.lock + dt * skill / BOT_LOCK_TIME).min(1.0);
        if b.lock < 1.0 || b.missile_cd > 0.0 {
            return;
        }
        let fwd = b.fwd();
        let pos = b.pos.add(fwd.mul(b.stats().radius)).add(b.q.rotate(UP).mul(-2.0));
        if self.launch_missile(pos, b.vel.add(fwd.mul(30.0)), quarry.track, Owner::Bot) {
            b.missiles -= 1.0;
            b.missile_cd = BOT_MISSILE_INTERVAL / skill;
            b.lock = 0.0;
            let at_player = if quarry.track == Track::Player { 1.0 } else { 0.0 };
            self.event(event::ENEMY_MISSILE, pos, at_player);
        }
    }

    /// Flares while evading; better pilots time them better.
    fn bot_flares(&mut self, b: &mut Bot, i: usize, skill: f32) {
        if b.flares <= 0.0 || b.flare_cd > 0.0 {
            return;
        }
        b.flare_cd = FLARE_INTERVAL * 2.0 / skill.max(0.3);
        if self.rng.next() > 0.35 + 0.4 * skill {
            return;
        }
        b.flares -= 1.0;
        self.drop_flare(b.pos, b.vel, b.engine, Track::Bot(i));
    }
}

//! Cannon rounds, guided missiles and flares.
//!
//! Missiles fly a point-mass model: a rocket motor that burns for a few seconds, drag
//! that grows with air density and speed squared, and fins whose authority falls with
//! dynamic pressure. Guidance is proportional navigation (turn N times as fast as the line
//! of sight rotates), so a missile leads a crossing target and a slow, late missile can be
//! out-turned. The seeker has a gimbal limit and can be seduced by flares.

use super::air::density_ratio;
use super::Game;
use crate::config::*;
use crate::entities::*;
use crate::layout::{event, MAX_BOTS, MAX_FLARES};
use crate::math::{clamp, segment_hits_sphere, V3, UP};

/// Bullets use a fatter hitbox against bots so the cannon feels fair at speed.
const BOT_HITBOX_SCALE: f32 = 2.2;

impl Game {
    /// Reuses the first free slot; the shot is dropped when the pool is full.
    pub(super) fn spawn_bullet(&mut self, pos: V3, vel: V3, owner: Owner) {
        if let Some(b) = self.bullets.iter_mut().find(|b| b.life <= 0.0) {
            *b = Bullet { pos, vel, life: BULLET_LIFE, owner };
        }
    }

    /// First live bot on the given side whose (scaled) hitbox the segment `a`-`b` passes through.
    fn bot_on_segment(&self, a: V3, b: V3, friendly: bool, radius: impl Fn(&Stats) -> f32) -> Option<usize> {
        (0..MAX_BOTS).find(|&i| {
            let bot = &self.bots[i];
            bot.alive && bot.friendly == friendly && segment_hits_sphere(a, b, bot.pos, radius(&STATS[bot.ty]))
        })
    }

    fn ground_on_segment(&self, a: V3, b: V3, radius: f32) -> Option<usize> {
        self.ground.iter().position(|g| g.alive && segment_hits_sphere(a, b, g.pos, radius))
    }

    pub(super) fn update_bullets(&mut self, dt: f32) {
        for bi in 0..self.bullets.len() {
            let b = self.bullets[bi];
            if b.life <= 0.0 {
                continue;
            }
            let end = b.pos.add(b.vel.mul(dt));
            let hit = match b.owner {
                Owner::Player => {
                    if let Some(i) = self.bot_on_segment(b.pos, end, false, |s| s.radius * BOT_HITBOX_SCALE) {
                        let at = self.bots[i].pos;
                        self.damage_bot(i, BULLET_DAMAGE, at);
                        true
                    } else if let Some(i) = self.ground_on_segment(b.pos, end, GROUND_TARGET_RADIUS) {
                        let at = self.ground[i].pos;
                        self.damage_ground(i, BULLET_DAMAGE, at);
                        true
                    } else {
                        false
                    }
                }
                Owner::Bot => {
                    let p = &self.player;
                    let dmg = self.difficulty().damage;
                    if p.alive && segment_hits_sphere(b.pos, end, p.pos, p.stats().radius) {
                        let at = p.pos;
                        self.damage_player(dmg, at, true);
                        true
                    } else if let Some(i) = self.bot_on_segment(b.pos, end, true, |s| s.radius * BOT_HITBOX_SCALE) {
                        let at = self.bots[i].pos;
                        self.damage_bot(i, dmg, at);
                        true
                    } else {
                        false
                    }
                }
            };
            let bl = &mut self.bullets[bi];
            bl.pos = end;
            bl.vel.y -= GRAVITY * dt;
            bl.life -= dt;
            if hit || bl.pos.y < 0.0 {
                bl.life = 0.0;
            }
        }
    }

    // ------------------------------------------------------------------ missiles

    /// Fires a missile; dropped when the pool is full. A missile fired without a track flies
    /// ballistic under its motor.
    pub(super) fn launch_missile(&mut self, pos: V3, vel: V3, track: Track, owner: Owner) -> bool {
        match self.missiles.iter_mut().find(|m| m.life <= 0.0) {
            Some(m) => {
                *m = Missile { pos, vel, life: MISSILE_LIFE, burn: MISSILE_BURN, track, owner };
                true
            }
            None => false,
        }
    }

    /// Position and velocity of what a seeker tracks, or None once it is gone.
    pub(super) fn track_state(&self, t: Track) -> Option<(V3, V3)> {
        match t {
            Track::None => None,
            Track::Bot(i) => {
                let b = &self.bots[i];
                b.alive.then_some((b.pos, b.vel))
            }
            Track::Player => {
                let p = &self.player;
                p.alive.then_some((p.pos, p.vel))
            }
            Track::Flare(i) => {
                let f = &self.flares[i];
                (f.life > 0.0).then_some((f.pos, f.vel))
            }
            Track::Ground(i) => {
                let g = &self.ground[i];
                g.alive.then_some((g.pos, V3::default()))
            }
        }
    }

    pub(super) fn update_missiles(&mut self, dt: f32) {
        for mi in 0..self.missiles.len() {
            let mut m = self.missiles[mi];
            if m.life <= 0.0 {
                continue;
            }
            m.life -= dt;
            let start = m.pos;
            self.missile_physics(&mut m, dt);
            let detonated = self.missile_fuse(&m, start);
            if detonated {
                m.life = 0.0;
            } else if m.pos.y < 0.0 {
                m.life = 0.0;
                self.event(event::GROUND_IMPACT, m.pos.flat(), 0.0);
            } else if m.life <= 0.0 {
                // Self-destruct at the end of its flight time.
                self.event(event::GROUND_IMPACT, m.pos, 0.0);
            }
            self.missiles[mi] = m;
        }
    }

    /// Guidance, motor, drag and gravity for one step.
    fn missile_physics(&self, m: &mut Missile, dt: f32) {
        let speed = m.vel.len().max(1.0);
        let dir = m.vel.mul(1.0 / speed);
        let density = density_ratio(m.pos.y);

        // Spent missiles (motor out and too slow) can no longer guide.
        if m.burn <= 0.0 && speed < MISSILE_MIN_SPEED {
            m.track = Track::None;
            m.life = m.life.min(2.0);
        }
        let mut lateral = V3::default();
        match self.track_state(m.track) {
            Some((tp, tv)) => {
                let r = tp.sub(m.pos);
                if r.norm().dot(dir) < MISSILE_GIMBAL_DEG.to_radians().cos() {
                    // Target left the seeker's field of view.
                    m.track = Track::None;
                } else {
                    // Proportional navigation: a = N * (omega x Vm), omega the line-of-sight rate.
                    let vr = tv.sub(m.vel);
                    let omega = r.cross(vr).mul(1.0 / r.dot(r).max(1.0));
                    lateral = omega.cross(m.vel).mul(MISSILE_NAV_GAIN).add(UP.mul(GRAVITY));
                }
            }
            None => m.track = Track::None,
        }
        // Fins only push sideways, and only as hard as the dynamic pressure allows.
        lateral = lateral.sub(dir.mul(lateral.dot(dir)));
        let eas = speed * density.sqrt();
        let max_a = MISSILE_MAX_G * GRAVITY * clamp((eas / MISSILE_FULL_G_SPEED).powi(2), 0.0, 1.0);
        let a = lateral.len();
        if a > max_a {
            lateral = lateral.mul(max_a / a);
        }
        let thrust = if m.burn > 0.0 {
            m.burn -= dt;
            MISSILE_THRUST
        } else {
            0.0
        };
        let drag = MISSILE_DRAG * density * speed * speed + MISSILE_INDUCED_DRAG * lateral.len();
        let acc = lateral.add(dir.mul(thrust - drag)).add(V3::new(0.0, -GRAVITY, 0.0));
        m.vel = m.vel.add(acc.mul(dt));
        m.pos = m.pos.add(m.vel.mul(dt));
    }

    /// Proximity fuse against the other side. Returns true when the missile detonated.
    fn missile_fuse(&mut self, m: &Missile, start: V3) -> bool {
        // The proximity fuse is armed by a seeker tracking a target; a missile that lost
        // its target (or chases a flare) only goes off on a near-direct hit.
        let fuse = if matches!(m.track, Track::None | Track::Flare(_)) { 8.0 } else { MISSILE_FUSE_RADIUS };
        match m.owner {
            Owner::Player => {
                if let Some(i) = self.bot_on_segment(start, m.pos, false, |s| s.radius + fuse) {
                    self.damage_bot(i, MISSILE_DAMAGE, m.pos);
                    return true;
                }
                if let Some(i) = self.ground_on_segment(start, m.pos, GROUND_TARGET_RADIUS + fuse) {
                    self.damage_ground(i, MISSILE_DAMAGE, m.pos);
                    return true;
                }
                false
            }
            Owner::Bot => {
                let p = &self.player;
                let dmg = BOT_MISSILE_DAMAGE[self.difficulty];
                if p.alive && segment_hits_sphere(start, m.pos, p.pos, p.stats().radius + fuse) {
                    self.damage_player(dmg, m.pos, true);
                    return true;
                }
                if let Some(i) = self.bot_on_segment(start, m.pos, true, |s| s.radius + fuse) {
                    self.damage_bot(i, dmg, m.pos);
                    return true;
                }
                false
            }
        }
    }

    // ------------------------------------------------------------------ flares

    /// Drops a flare from an aircraft (`from` is that aircraft as a seeker track) and gives
    /// every missile tracking it one chance to be seduced. Tail-on seekers looking at a hot
    /// engine are the hardest to fool.
    pub(super) fn drop_flare(&mut self, pos: V3, vel: V3, engine: f32, from: Track) {
        let Some(slot) = self.flares.iter().position(|f| f.life <= 0.0) else {
            return;
        };
        let kick = V3::new(self.rng.range(-10.0, 10.0), -25.0, self.rng.range(-10.0, 10.0));
        self.flares[slot] = Flare { pos, vel: vel.mul(0.6).add(kick), life: FLARE_LIFE };
        let heading = vel.norm();
        for mi in 0..self.missiles.len() {
            let m = self.missiles[mi];
            if m.life <= 0.0 || m.track != from {
                continue;
            }
            let to_missile = m.pos.sub(pos);
            if !(FLARE_MIN_RANGE..FLARE_RANGE).contains(&to_missile.len()) {
                continue;
            }
            // 1 when the missile sits right behind the aircraft, staring into the exhaust.
            let tail_on = to_missile.norm().dot(heading.mul(-1.0)).max(0.0);
            let chance = clamp(0.7 - 0.3 * tail_on - 0.3 * engine, FLARE_CHANCE_MIN, FLARE_CHANCE_MAX);
            if self.rng.next() < chance {
                self.missiles[mi].track = Track::Flare(slot);
                if from == Track::Player {
                    self.event(event::DECOYED, m.pos, 0.0);
                }
            }
        }
    }

    pub(super) fn update_flares(&mut self, dt: f32) {
        let drag = (-1.2 * dt).exp();
        for f in self.flares.iter_mut().take(MAX_FLARES) {
            if f.life <= 0.0 {
                continue;
            }
            f.life -= dt;
            f.vel = f.vel.mul(drag);
            f.vel.y -= GRAVITY * 0.6 * dt;
            f.pos = f.pos.add(f.vel.mul(dt));
            if f.pos.y < 0.0 {
                f.life = 0.0;
            }
        }
    }
}

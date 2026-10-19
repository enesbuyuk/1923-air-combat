//! Other pilots in an online room.
//!
//! Every client flies only its own aircraft; the others are mirrored into bot slots the AI
//! leaves alone (`Bot::remote`), posed from the network before each step and moved on by
//! their velocity between updates. Damage to them is never applied here:
//! - cannon hits are collected (`Bot::remote_damage`) for JS to send to their owner, so the
//!   shooter decides gun hits;
//! - missiles are flown by the target's own client (`launch_remote_missile`), so the target
//!   decides missile hits and its flares and evasion work against the real thing.
//!
//! Their rounds and missiles are shown here as `Owner::Remote` and hurt nobody.

use super::Game;
use crate::config::*;
use crate::entities::*;
use crate::layout::{event, remote, MAX_BOTS};
use crate::math::{Q, V3};

impl Game {
    /// Pose bot slot `slot` as another pilot from `remote_import`; a dead one is hidden.
    pub fn set_remote(&mut self, slot: usize, live: bool) {
        if slot >= MAX_BOTS {
            return;
        }
        let r = self.remote_import;
        let ty = (r[remote::TYPE].max(0.0) as usize).min(STATS.len() - 1);
        let pos = V3::new(r[remote::POS], r[remote::POS + 1], r[remote::POS + 2]);
        let vel = V3::new(r[remote::VEL], r[remote::VEL + 1], r[remote::VEL + 2]);
        let b = &mut self.bots[slot];
        if !live || r[remote::ALIVE] <= 0.0 {
            *b = Bot { remote: true, ..Bot::DEAD };
            return;
        }
        if !b.alive || !b.remote || b.ty != ty {
            *b = Bot { remote: true, ..Bot::spawn(ty, pos, crate::math::FORWARD, 0.0, 1.0) };
        }
        b.pos = pos;
        b.q = Q { x: r[remote::QUAT], y: r[remote::QUAT + 1], z: r[remote::QUAT + 2], w: r[remote::QUAT + 3] };
        b.vel = vel;
        b.speed = vel.len();
        b.engine = r[remote::ENGINE];
        b.gear_position = r[remote::GEAR];
        b.gear_down = b.gear_position > 0.5;
        b.flaps = r[remote::FLAPS];
        b.max_hp = r[remote::MAX_HP].max(1.0);
        b.hp = r[remote::HP];
        b.remote_gun = r[remote::GUN] > 0.0;
    }

    /// Frees a slot when its pilot leaves the room.
    pub fn clear_remote(&mut self, slot: usize) {
        if slot < MAX_BOTS {
            self.bots[slot] = Bot::DEAD;
        }
    }

    /// Cannon damage dealt to the pilot in `slot` since the last call.
    pub fn take_remote_damage(&mut self, slot: usize) -> f32 {
        match self.bots.get_mut(slot) {
            Some(b) if b.remote => std::mem::take(&mut b.remote_damage),
            _ => 0.0,
        }
    }

    /// Damage another pilot dealt to the player, as their client reported it; applied on
    /// the next step.
    pub fn remote_hit(&mut self, dmg: f32) {
        self.remote_hits += dmg.max(0.0);
    }

    /// What other pilots did between steps, with the events it raises.
    pub(super) fn apply_remote(&mut self) {
        let dmg = std::mem::take(&mut self.remote_hits);
        if dmg > 0.0 {
            let at = self.player.pos;
            self.damage_player(dmg, at, true);
        }
        if let Some(at) = self.remote_launch.take() {
            self.event(event::ENEMY_MISSILE, at, 1.0);
        }
    }

    /// A missile another pilot fired. Aimed at the player (`track` Player) it is real and
    /// flown here; anything else is only shown.
    pub fn launch_remote_missile(&mut self, pos: V3, vel: V3, track: Track) {
        let at_player = track == Track::Player;
        let owner = if at_player { Owner::Bot } else { Owner::Remote };
        if self.launch_missile(pos, vel, track, owner) && at_player {
            self.remote_launch = Some(pos);
        }
    }

    /// A flare from the pilot in `slot`; it may decoy missiles tracking them.
    pub fn remote_flare(&mut self, slot: usize) {
        let Some(b) = self.bots.get(slot).filter(|b| b.alive && b.remote) else { return };
        let (pos, vel, engine) = (b.pos, b.vel, b.engine);
        self.drop_flare(pos, vel, engine, Track::Bot(slot));
    }

    /// Between network updates the aircraft carries on along its velocity, and the guns
    /// fire (for show) while the trigger is held.
    pub(super) fn update_remote(&mut self, i: usize, dt: f32) {
        let mut b = self.bots[i];
        b.pos = b.pos.add(b.vel.mul(dt));
        b.fire_cd = (b.fire_cd - dt).max(-dt);
        if b.remote_gun && b.fire_cd <= 0.0 {
            let fwd = b.fwd();
            let dir = self.disperse(fwd);
            let muzzle = b.pos.add(fwd.mul(b.stats().radius + 1.0));
            self.spawn_rounds(muzzle, dir.mul(PLAYER_BULLET_SPEED).add(b.vel), Owner::Remote, ROUNDS_PER_SHOT);
            b.fire_cd += b.stats().gun_interval;
        }
        self.bots[i] = b;
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{airborne, run, F16};
    use crate::entities::{Input, Track};
    use crate::layout::remote;
    use crate::math::V3;

    /// Another pilot `ahead` metres in front of the player, flying the same way.
    fn with_pilot(ahead: f32) -> super::Game {
        let mut g = airborne(F16, 2000.0, 250.0, 0.7);
        let p = g.player.pos.add(V3::new(0.0, 0.0, -ahead));
        let r = &mut g.remote_import;
        r[remote::TYPE] = F16 as f32;
        r[remote::POS..remote::POS + 3].copy_from_slice(&[p.x, p.y, p.z]);
        r[remote::QUAT..remote::QUAT + 4].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
        r[remote::VEL..remote::VEL + 3].copy_from_slice(&[0.0, 0.0, -250.0]);
        r[remote::HP] = 100.0;
        r[remote::MAX_HP] = 100.0;
        r[remote::ALIVE] = 1.0;
        g.set_remote(3, true);
        g
    }

    #[test]
    fn cannon_hits_on_another_pilot_are_collected_not_applied() {
        let mut g = with_pilot(400.0);
        run(&mut g, 1.0, Input { throttle: 0.7, gun: true, ..Input::default() });
        let b = g.bots[3];
        assert!(b.alive && b.hp == 100.0, "remote pilot damaged locally");
        assert!(g.take_remote_damage(3) > 0.0, "no damage collected");
        assert_eq!(g.take_remote_damage(3), 0.0);
    }

    #[test]
    fn a_kill_reported_between_steps_reaches_js() {
        let mut g = with_pilot(1500.0);
        g.remote_hit(500.0);
        g.step(super::super::tests::DT);
        let n = g.out_stats[crate::layout::stats::EVENT_COUNT] as usize;
        let down = (0..n).any(|i| g.out_events[i * crate::layout::event::STRIDE] == crate::layout::event::PLAYER_DOWN);
        assert!(!g.player.alive && down, "no PLAYER_DOWN event");
    }

    #[test]
    fn another_pilots_missile_at_the_player_is_real() {
        let mut g = with_pilot(1500.0);
        let from = g.bots[3].pos;
        g.launch_remote_missile(from, V3::new(0.0, 0.0, 300.0), Track::Player);
        run(&mut g, 8.0, Input { throttle: 0.7, ..Input::default() });
        assert!(g.player.hp < g.player.stats().hp, "missile did no damage");
    }

    #[test]
    fn another_pilot_is_flown_by_nobody_but_the_network() {
        let mut g = with_pilot(3000.0);
        let before = g.bots[3].pos;
        run(&mut g, 1.0, Input { throttle: 0.7, ..Input::default() });
        let moved = g.bots[3].pos.sub(before);
        // `run` takes whole steps, a little short of the full second.
        assert!((-251.0..-240.0).contains(&moved.z) && moved.x.abs() < 1e-3, "moved {:?}", (moved.x, moved.z));
        assert_eq!(g.bots_alive(), 0, "counted as an enemy wave");
        g.clear_remote(3);
        assert!(!g.bots[3].alive && !g.bots[3].remote);
    }
}

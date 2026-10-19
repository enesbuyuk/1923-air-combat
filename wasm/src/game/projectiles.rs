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
use crate::math::{clamp, segment_distance, segment_hits_sphere, V3, UP};

/// A live bot's hitbox, packed tight so every round can test them all without walking
/// the full `Bot` records (cache-friendly broadphase).
#[derive(Clone, Copy, Default)]
struct Hull {
    pos: V3,
    radius: f32,
    friendly: bool,
    index: usize,
}

impl Game {
    /// Reuses the next free slot, round-robin from the last one; the shot is dropped when
    /// the pool is full.
    #[cfg(test)]
    pub(super) fn spawn_bullet(&mut self, pos: V3, vel: V3, owner: Owner) {
        self.spawn_rounds(pos, vel, owner, ROUNDS_PER_SHOT);
    }

    pub(super) fn spawn_rounds(&mut self, pos: V3, vel: V3, owner: Owner, rounds: f32) -> bool {
        let n = self.bullets.len();
        for k in 0..n {
            let i = (self.bullet_cursor + k) % n;
            if self.bullets[i].life <= 0.0 {
                self.bullets[i] = Bullet { pos, vel, life: BULLET_LIFE, owner, rounds };
                self.bullet_cursor = (i + 1) % n;
                return true;
            }
        }
        false
    }

    /// First live bot on the given side whose hull the segment `a`-`b` passes through.
    fn bot_on_segment(&self, hulls: &[Hull], a: V3, b: V3, friendly: bool) -> Option<usize> {
        hulls
            .iter()
            .find(|h| h.friendly == friendly && self.bots[h.index].alive && segment_hits_sphere(a, b, h.pos, h.radius))
            .map(|h| h.index)
    }

    fn ground_on_segment(&self, a: V3, b: V3, radius: f32) -> Option<usize> {
        self.ground.iter().position(|g| g.alive && segment_hits_sphere(a, b, g.pos, radius))
    }

    pub(super) fn update_bullets(&mut self, dt: f32) {
        // Bots do not move while the rounds fly this substep: pack their hulls once.
        let mut hulls = [Hull::default(); MAX_BOTS];
        let mut count = 0;
        for (i, b) in self.bots.iter().enumerate().filter(|(_, b)| b.alive) {
            hulls[count] = Hull { pos: b.pos, radius: b.stats().radius, friendly: b.friendly, index: i };
            count += 1;
        }
        let hulls = &hulls[..count];
        for bi in 0..self.bullets.len() {
            let b = self.bullets[bi];
            if b.life <= 0.0 {
                continue;
            }
            let end = b.pos.add(b.vel.mul(dt));
            if end.y < self.environment.height(end.x, end.z) || !self.environment.clear_line(b.pos, end) {
                self.bullets[bi].life = 0.0;
                continue;
            }
            let damage = BULLET_DAMAGE * b.rounds / ROUNDS_PER_SHOT;
            let hit = match b.owner {
                Owner::Player => {
                    if let Some(i) = self.bot_on_segment(hulls, b.pos, end, false) {
                        let at = self.bots[i].pos;
                        self.damage_bot(i, damage, at);
                        true
                    } else if let Some(i) = self.ground_on_segment(b.pos, end, GROUND_TARGET_RADIUS) {
                        let at = self.ground[i].pos;
                        self.damage_ground(i, damage, at);
                        true
                    } else {
                        false
                    }
                }
                Owner::Bot => {
                    let p = &self.player;
                    let dmg = damage;
                    if p.alive && segment_hits_sphere(b.pos, end, p.pos, p.stats().radius) {
                        let at = p.pos;
                        self.damage_player(dmg, at, true);
                        true
                    } else if let Some(i) = self.bot_on_segment(hulls, b.pos, end, true) {
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
            let v = bl.vel.len();
            bl.vel = bl.vel.mul(1.0 - (BULLET_DRAG * density_ratio(end.y) * v * dt).min(0.5));
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
        self.launch_weapon(pos, vel, track, owner, false)
    }
    pub(super) fn launch_radar_missile(&mut self, pos: V3, vel: V3, track: Track, owner: Owner) -> bool {
        self.launch_weapon(pos, vel, track, owner, true)
    }
    fn launch_weapon(&mut self, pos: V3, vel: V3, track: Track, owner: Owner, radar: bool) -> bool {
        match self.missiles.iter_mut().find(|m| m.life <= 0.0) {
            Some(m) => {
                *m = Missile { pos, vel, life: MISSILE_LIFE, burn: MISSILE_BURN, track, owner, radar };
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
            let blocked = m.pos.y < self.environment.height(m.pos.x, m.pos.z) || !self.environment.clear_line(start, m.pos);
            let detonated = !blocked && self.missile_fuse(&m, start);
            if detonated {
                m.life = 0.0;
            } else if blocked {
                m.life = 0.0;
                self.event(event::GROUND_IMPACT, m.pos, 0.0);
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
                if r.norm().dot(dir) < MISSILE_GIMBAL_DEG.to_radians().cos() || !self.environment.clear_line(m.pos, tp) {
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

    /// Proximity fuse against one target (`radius` its size): it fires at the point of
    /// closest approach within `fuse` of the skin, or on contact, and returns the warhead's
    /// damage share there. While the missile is still closing it waits for a closer pass.
    fn fuse_hit(start: V3, end: V3, target: V3, radius: f32, fuse: f32) -> Option<f32> {
        let ab = end.sub(start);
        let l2 = ab.dot(ab);
        let t = if l2 > 0.0 { clamp(target.sub(start).dot(ab) / l2, 0.0, 1.0) } else { 0.0 };
        let miss = (segment_distance(start, end, target) - radius).max(0.0);
        if miss > fuse || (t >= 1.0 && miss > 0.0) {
            return None;
        }
        Some(1.0 - (1.0 - MISSILE_EDGE_DAMAGE) * clamp(miss / fuse, 0.0, 1.0))
    }

    /// First live bot on the given side the missile's fuse goes off against.
    fn bot_fuse(&self, start: V3, end: V3, friendly: bool, fuse: f32) -> Option<(usize, f32)> {
        (0..MAX_BOTS).find_map(|i| {
            let b = &self.bots[i];
            if !b.alive || b.friendly != friendly {
                return None;
            }
            Self::fuse_hit(start, end, b.pos, b.stats().radius, fuse).map(|k| (i, k))
        })
    }

    /// Proximity fuse against the other side. Returns true when the missile detonated.
    fn missile_fuse(&mut self, m: &Missile, start: V3) -> bool {
        // The proximity fuse is armed by a seeker tracking a target; a missile that lost
        // its target (or chases a flare) only goes off on a near-direct hit.
        let fuse = if matches!(m.track, Track::None | Track::Flare(_)) { 3.0 } else { MISSILE_FUSE_RADIUS };
        match m.owner {
            Owner::Player => {
                if let Some((i, k)) = self.bot_fuse(start, m.pos, false, fuse) {
                    self.damage_bot(i, MISSILE_DAMAGE * k, m.pos);
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
                let dmg = MISSILE_DAMAGE;
                if p.alive {
                    if let Some(k) = Self::fuse_hit(start, m.pos, p.pos, p.stats().radius, fuse) {
                        self.damage_player(dmg * k, m.pos, true);
                        return true;
                    }
                }
                if let Some((i, k)) = self.bot_fuse(start, m.pos, true, fuse) {
                    self.damage_bot(i, dmg * k, m.pos);
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
            if m.life <= 0.0 || m.track != from || m.radar {
                continue;
            }
            let to_missile = m.pos.sub(pos);
            if !(FLARE_MIN_RANGE..FLARE_RANGE).contains(&to_missile.len()) {
                continue;
            }
            // 1 when the missile sits right behind the aircraft, staring into the exhaust.
            let tail_on = to_missile.norm().dot(heading.mul(-1.0)).max(0.0);
            let chance = clamp(FLARE_CHANCE_MAX - 0.2 * tail_on - 0.2 * engine, FLARE_CHANCE_MIN, FLARE_CHANCE_MAX);
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
            if f.pos.y < self.environment.height(f.pos.x, f.pos.z) {
                f.life = 0.0;
            }
        }
    }
}

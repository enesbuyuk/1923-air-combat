//! Player aircraft: ground roll, flight (see `aero.rs`), touchdown, ground crew service
//! and the player's weapons and countermeasures.

use super::aero::{self, lift_coefficient, lift_scale, spool_engine, thrust};
use super::air::{density_ratio, drag_coefficient, ground_effect, speed_of_sound};
use super::Game;
use crate::config::*;
use crate::entities::*;
use crate::layout::event;
use crate::math::{clamp, Q, V3, RIGHT, UP};

impl Game {
    pub(super) fn update_player(&mut self, dt: f32) {
        if !self.player.alive {
            self.tick_respawn(dt);
            return;
        }
        if self.player.on_ground {
            self.ground_roll(dt);
            self.ground_crew(dt);
        } else {
            self.fly(dt);
            if !self.player.alive {
                return;
            }
        }
        self.steer_back_inside_world(dt);
        let p = &mut self.player;
        p.gun_cd -= dt;
        p.missile_cd -= dt;
        p.flare_cd -= dt;
        self.fire_gun();
        self.update_lock(dt);
        self.fire_missile();
        self.drop_player_flare();
    }

    fn tick_respawn(&mut self, dt: f32) {
        self.player.respawn -= dt;
        if self.player.respawn <= 0.0 {
            self.player = Player::on_runway(self.player.ty);
            self.reset_lock();
        }
    }

    /// Taxi / takeoff roll: nosewheel steering, no roll, nose rotation above Vr, and
    /// liftoff once the wing carries the weight.
    fn ground_roll(&mut self, dt: f32) {
        let inp = self.input;
        let air = self.weather.air_at(GEAR_HEIGHT);
        let bump = self.weather.roll;
        let p = &mut self.player;
        let s = p.stats();
        p.throttle = clamp(inp.throttle, 0.0, 1.0);
        spool_engine(&mut p.af, dt);
        aero::burn_fuel(&mut p.af, dt);
        p.density = density_ratio(p.pos.y);
        let mass = p.mass();

        let right = p.heading.cross(UP).norm();
        // Headwind adds airspeed, tailwind takes it away.
        let airspeed = (p.speed - air.dot(p.heading)).max(0.0);
        let ge = ground_effect(GEAR_HEIGHT);
        let cl = lift_coefficient(p.rot, s.alpha_max);
        let lift_g = cl * lift_scale(&s, airspeed, p.density, mass) * (1.0 + GROUND_EFFECT_LIFT * ge);
        // Share of the weight still on the wheels (friction and brakes act through it).
        let wheels = clamp(1.0 - lift_g, 0.0, 1.0);

        let steer_authority = clamp(p.speed / 15.0, 0.0, 1.0);
        let mut steer = (-inp.yaw * 0.7 - inp.roll * 0.25) * steer_authority * dt;
        // Crosswind pushes on the tail, so the aircraft weathervanes into the wind.
        steer += air.dot(right) * 0.006 * clamp(airspeed / 30.0, 0.0, 1.0) * dt;
        let heading = Q::axis_angle(UP, steer).rotate(p.heading).norm();
        p.heading = heading;

        let k_drag = drag_coefficient(&s);
        let induced = lift_g * GRAVITY * cl * INDUCED_DRAG * (1.0 - 0.5 * ge);
        let drag = p.density * (k_drag * airspeed * airspeed + LINEAR_DRAG * airspeed) / mass + induced;
        let mut accel = thrust(&p.af) - drag - ROLLING_FRICTION * wheels;
        if inp.brake {
            accel -= WHEEL_BRAKE * wheels;
        }
        p.speed = (p.speed + accel * dt).max(0.0);
        p.vel = heading.mul(p.speed);
        p.pos = p.pos.add(p.vel.mul(dt));
        p.pos.y = GEAR_HEIGHT;

        // Raise the nose gradually above Vr; otherwise lower it gently
        // (also de-rotates after touchdown).
        if p.speed > s.rotate_speed && inp.pitch > 0.2 {
            p.rot = (p.rot + ROTATE_RATE * inp.pitch * dt).min(MAX_ROTATION);
        } else {
            p.rot = (p.rot - DEROTATE_RATE * dt).max(0.0);
        }
        let target = Q::look(Q::axis_angle(right, p.rot).rotate(heading), UP);
        // Ease toward the target attitude so touchdown roll/pitch never snaps.
        p.q = p.q.nlerp(target, 1.0 - (-6.0 * dt).exp());
        p.alpha = p.rot;
        p.beta = 0.0;
        p.mach = airspeed / speed_of_sound(p.pos.y);

        if lift_g > 1.02 && p.rot > 0.0 {
            // Lift off with a level velocity; the extra lift starts the climb smoothly.
            p.q = target;
            p.on_ground = false;
            p.pos.y = GEAR_HEIGHT + 0.05;
            p.rot = 0.0;
        }
        p.pitch_vel = 0.0;
        p.roll_vel = 0.0;
        p.bump = bump;
        p.gload = 1.0;
        p.stall = false;
    }

    /// Stopped on the airfield long enough: the ground crew rearms, refuels and repairs.
    fn ground_crew(&mut self, dt: f32) {
        let p = &mut self.player;
        let near_base = p.pos.sub(RUNWAY_CENTER).flat().len() < REARM_RADIUS;
        if !(near_base && p.speed < 3.0 && p.throttle < 0.3 && p.needs_service()) {
            p.parked = 0.0;
            return;
        }
        let before = p.parked;
        p.parked += dt;
        if before < REARM_TIME && p.parked >= REARM_TIME {
            p.rearm();
            let pos = p.pos;
            self.event(event::REARMED, pos, 0.0);
        }
    }

    fn fly(&mut self, dt: f32) {
        let air = self.weather.air_at(self.player.pos.y);
        let inp = self.input;
        aero::fly(&mut self.player.af, &inp, air, self.weather.roll, dt);
        if self.player.pos.y <= GEAR_HEIGHT {
            let sink_rate = self.player.vel.y;
            self.touch_down(sink_rate);
        }
    }

    /// The wheels reached the ground: land (possibly hard) or crash.
    fn touch_down(&mut self, sink_rate: f32) {
        let p = &mut self.player;
        let fwd = p.fwd();
        let upv = p.q.rotate(UP);
        let survivable = sink_rate > -MAX_SINK_RATE && upv.y > MIN_LANDING_UP && fwd.y > MIN_LANDING_NOSE;
        if !survivable {
            let pos = p.pos.flat();
            self.kill_player(pos);
            self.event(event::GROUND_IMPACT, pos, 1.0);
            return;
        }
        let hard = (-sink_rate - HARD_LANDING_SINK).max(0.0) * HARD_LANDING_DAMAGE;
        p.on_ground = true;
        p.pos.y = GEAR_HEIGHT;
        // Keep the touchdown attitude; the ground roll eases the nose down and wings level.
        // The wheels roll where the nose points, so any crab angle is lost here.
        p.heading = fwd.flat().norm();
        p.speed = p.vel.dot(p.heading).max(0.0);
        p.vel = p.heading.mul(p.speed);
        p.rot = clamp(fwd.y.asin(), 0.0, MAX_ROTATION);
        let pos = p.pos;
        self.event(event::LANDED, pos, hard);
        if hard > 0.0 {
            self.damage_player(hard, pos, false);
            if !self.player.alive {
                self.event(event::GROUND_IMPACT, pos.flat(), 1.0);
            }
        }
    }

    /// Soft world boundary: turn the aircraft and its flight path back toward the base.
    fn steer_back_inside_world(&mut self, dt: f32) {
        let p = &mut self.player;
        let horiz = p.pos.flat();
        if horiz.len() <= WORLD_LIMIT {
            return;
        }
        // A flat turn about the vertical, so flying straight out never loops over the top.
        let back = horiz.mul(-1.0).norm();
        let track = p.vel.flat().norm();
        let angle = clamp(track.dot(back), -1.0, 1.0).acos().min(0.5 * dt);
        let side = if track.cross(back).y >= 0.0 { 1.0 } else { -1.0 };
        let turn = Q::axis_angle(UP, side * angle);
        p.q = turn.mul(p.q).normalize();
        p.vel = turn.rotate(p.vel);
        p.heading = turn.rotate(p.heading).flat().norm();
    }

    fn fire_gun(&mut self) {
        let p = &mut self.player;
        if !(self.input.gun && p.gun_cd <= 0.0 && p.ammo > 0.0 && !p.on_ground) {
            return;
        }
        let s = p.stats();
        p.gun_cd = s.gun_interval;
        p.ammo -= 1.0;
        let fwd = p.fwd();
        let right = p.q.rotate(RIGHT);
        // Alternate between the two muzzles.
        let side = if (self.time * 40.0) as i32 % 2 == 0 { 1.0 } else { -1.0 };
        let muzzle = p.pos.add(fwd.mul(s.radius)).add(right.mul(side * 1.2));
        let pvel = p.velocity();
        let dir = self.gun_assist_dir(muzzle, fwd, pvel);
        let vel = dir.mul(PLAYER_BULLET_SPEED).add(pvel);
        self.spawn_bullet(muzzle, vel, Owner::Player);
    }

    fn fire_missile(&mut self) {
        let p = &mut self.player;
        if !(self.input.missile && p.missile_cd <= 0.0 && p.missiles > 0.0 && !p.on_ground) {
            return;
        }
        p.missile_cd = MISSILE_INTERVAL;
        p.missiles -= 1.0;
        let fwd = p.fwd();
        let down = p.q.rotate(V3::new(0.0, -1.0, 0.0));
        let pos = p.pos.add(down.mul(2.5)).add(fwd.mul(4.0));
        let vel = p.velocity().add(fwd.mul(40.0));
        let track = if self.lock_progress >= 1.0 { self.lock } else { Track::None };
        self.launch_missile(pos, vel, track, Owner::Player);
        self.event(event::MISSILE_LAUNCH, pos, track.code());
    }

    fn drop_player_flare(&mut self) {
        let p = &mut self.player;
        if !(self.input.flare && p.flare_cd <= 0.0 && p.flares > 0.0 && !p.on_ground) {
            return;
        }
        p.flare_cd = FLARE_INTERVAL;
        p.flares -= 1.0;
        let (pos, vel, engine) = (p.pos, p.vel, p.engine);
        self.drop_flare(pos, vel, engine, Track::Player);
        self.event(event::FLARE, pos, 0.0);
    }

    /// Aim assist: if a target sits within a small cone ahead, steer the shot onto
    /// its lead point (target motion + bullet drop), so near-misses still connect.
    fn gun_assist_dir(&self, muzzle: V3, fwd: V3, pvel: V3) -> V3 {
        let cone = GUN_ASSIST_CONE_DEG.to_radians().cos();
        let mut best: Option<(f32, V3)> = None;
        let bots = self.bots.iter().filter(|b| b.alive && !b.friendly).map(|b| (b.pos, b.velocity()));
        let ground = self.ground.iter().filter(|g| g.alive).map(|g| (g.pos, V3::default()));
        for (pos, vel) in bots.chain(ground) {
            let d = pos.sub(muzzle);
            let dist = d.len();
            if dist > GUN_ASSIST_RANGE {
                continue;
            }
            let c = d.norm().dot(fwd);
            if c <= cone || best.is_some_and(|(bc, _)| c <= bc) {
                continue;
            }
            // Iterate time-to-go a few times to converge on the intercept point.
            let rel_vel = vel.sub(pvel);
            let mut tgo = dist / PLAYER_BULLET_SPEED;
            let mut aim = d;
            for _ in 0..3 {
                aim = pos.add(rel_vel.mul(tgo)).sub(muzzle);
                aim.y += 0.5 * GRAVITY * tgo * tgo;
                tgo = aim.len() / PLAYER_BULLET_SPEED;
            }
            best = Some((c, aim.norm()));
        }
        best.map_or(fwd, |(_, aim)| aim)
    }

    /// Missile seeker: track the enemy (aircraft or ground target) closest to the nose
    /// within the cone; holding the same target for LOCK_TIME completes the lock.
    fn update_lock(&mut self, dt: f32) {
        let p = &self.player;
        if !p.airborne() {
            self.reset_lock();
            return;
        }
        let fwd = p.fwd();
        let mut best = Track::None;
        let mut best_dot = LOCK_CONE_DEG.to_radians().cos();
        let bots = self.bots.iter().enumerate().filter(|(_, b)| b.alive && !b.friendly).map(|(i, b)| (Track::Bot(i), b.pos));
        let ground = self.ground.iter().enumerate().filter(|(_, g)| g.alive).map(|(i, g)| (Track::Ground(i), g.pos));
        for (track, pos) in bots.chain(ground) {
            let d = pos.sub(p.pos);
            if d.len() > LOCK_RANGE {
                continue;
            }
            let c = d.norm().dot(fwd);
            if c > best_dot {
                best_dot = c;
                best = track;
            }
        }
        if best != self.lock {
            self.lock = best;
            self.lock_progress = 0.0;
        } else if best != Track::None {
            self.lock_progress = (self.lock_progress + dt / LOCK_TIME).min(1.0);
        }
    }
}

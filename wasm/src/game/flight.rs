//! Player aircraft: ground roll, flight (see `aero.rs`), touchdown, ground crew service
//! and the player's weapons and countermeasures.

use super::aero::{self, lift_coefficient, lift_scale, spool_engine, thrust};
use super::air::{density_ratio, drag_coefficient, ground_effect, speed_of_sound};
use super::Game;
use super::configuration;
use crate::environment::Surface;
use crate::config::*;
use crate::entities::*;
use crate::layout::event;
use crate::math::{clamp, Q, V3, RIGHT, UP};

/// Height of the aircraft origin with the main wheels on the runway at a nose-up pitch
/// (`sin_pitch`): the origin sits ahead of the main wheels, so rotating on them lifts it.
pub fn wheels_down_height(sin_pitch: f32) -> f32 {
    GEAR_HEIGHT + MAIN_GEAR_ARM * sin_pitch.max(0.0)
}

/// Attitude of an aircraft on its wheels rolling along `heading`, nose up by `pitch`.
fn strut_attitude(heading: V3, pitch: f32) -> Q {
    let right = heading.cross(UP).norm();
    Q::look(Q::axis_angle(right, pitch).rotate(heading), UP)
}

impl Game {
    pub(super) fn update_player(&mut self, dt: f32) {
        if !self.player.alive {
            self.tick_respawn(dt);
            return;
        }
        let from = self.player.pos;
        self.player.ground_height = self.environment.height(from.x, from.z);
        if self.player.on_ground {
            self.ground_roll(dt);
            if self.player.alive { self.ground_crew(dt); }
        } else {
            self.fly(dt);
            if !self.player.alive {
                return;
            }
        }
        if self.player.alive {
            if let Some((at, nx, nz, depth)) = self.obstacle_contact(from, &self.player.af) {
                self.building_hit(at, nx, nz, depth);
            }
        }
        self.update_world_boundary(dt);
        if !self.player.alive {
            return;
        }
        let p = &mut self.player;
        p.gun_cd = (p.gun_cd - dt).max(-dt);
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
        let surface = self.environment.surface(self.player.pos.x, self.player.pos.z);
        if surface == Surface::Water { let at = self.player.pos; self.kill_player(at); return; }
        let air = self.weather.air_at(self.player.pos.y);
        let bump = self.weather.roll;
        let p = &mut self.player;
        let s = p.stats();
        p.throttle = clamp(inp.throttle, 0.0, 1.0);
        spool_engine(&mut p.af, dt);
        aero::burn_fuel(&mut p.af, dt);
        p.density = density_ratio(p.pos.y);
        configuration::update(&mut p.af, dt);
        let mass = p.mass();

        let right = p.heading.cross(UP).norm();
        // Headwind adds airspeed, tailwind takes it away.
        let airspeed = (p.speed - air.dot(p.heading)).max(0.0);
        let ge = ground_effect(GEAR_HEIGHT, s.span);
        let cl = lift_coefficient(p.rot + configuration::camber(&p.af), s.alpha_max);
        let dump = LIFT_DUMP * clamp((LIFT_DUMP_THROTTLE - p.throttle) / 0.2, 0.0, 1.0);
        let lift_g = cl * lift_scale(&s, airspeed, p.density, mass) * configuration::lift_factor(&p.af) * (1.0 + GROUND_EFFECT_LIFT * ge) * (1.0 - dump);
        // Share of the weight still on the wheels (friction and brakes act through it).
        let wheels = clamp(1.0 - lift_g, 0.0, 1.0);

        let steer_authority = clamp(p.speed / 15.0, 0.0, 1.0) * clamp(35.0 / p.speed.max(1.0), 0.0, 1.0);
        let mut steer = (-inp.yaw * 0.7 - inp.roll * 0.25) * steer_authority * dt;
        // Crosswind pushes on the tail, so the aircraft weathervanes into the wind.
        steer += air.dot(right) * 0.006 * clamp(airspeed / 30.0, 0.0, 1.0) * dt;
        let heading = Q::axis_angle(UP, steer).rotate(p.heading).norm();
        p.heading = heading;

        let k_drag = drag_coefficient(&s);
        let induced = lift_g * GRAVITY * cl * INDUCED_DRAG * (1.0 - 0.5 * ge);
        let drag = p.density * ((k_drag + configuration::drag(&p.af)) * airspeed * airspeed + LINEAR_DRAG * airspeed) / mass + induced;
        let (rolling, brake) = if surface == Surface::Soil { (2.4, 2.5) } else { (ROLLING_FRICTION, WHEEL_BRAKE) };
        let h0 = self.environment.height(p.pos.x - heading.x * 2.0, p.pos.z - heading.z * 2.0);
        let h1 = self.environment.height(p.pos.x + heading.x * 2.0, p.pos.z + heading.z * 2.0);
        let mut accel = thrust(&p.af) - drag - rolling * wheels - GRAVITY * (h1 - h0) / 4.0;
        if inp.brake {
            accel -= brake * wheels;
        }
        let speed_before = p.speed;
        p.speed = (p.speed + accel * dt).max(0.0);
        p.vel = heading.mul(p.speed);
        p.pos = p.pos.add(p.vel.mul(dt));

        // Raise the nose gradually above Vr; otherwise lower it gently
        // (also de-rotates after touchdown).
        let nose_up = p.rot > 0.0;
        let rotating = airspeed * p.density.sqrt() > s.rotate_speed && inp.pitch > 0.2;
        let (pitch_before, y_before) = (p.rot + p.gear_pitch, p.pos.y);
        if rotating {
            p.rot = (p.rot + ROTATE_RATE * inp.pitch * dt).min(MAX_ROTATION);
        } else {
            p.rot = (p.rot - DEROTATE_RATE * dt).max(0.0);
        }
        if nose_up && p.rot == 0.0 {
            // The nosewheel meets the runway and its strut takes the swing.
            p.gear_pitch_vel -= DEROTATE_RATE;
        }
        // Oleo struts as damped springs. The heave extends as the wing takes the weight off
        // the wheels; on the nosewheel, braking dips the nose and thrust squats it.
        let target = GEAR_EXTEND * (1.0 - wheels);
        p.gear_vel += (-GEAR_SPRING * (p.gear - target) - GEAR_DAMPING * p.gear_vel) * dt;
        p.gear += p.gear_vel * dt;
        if p.gear < -GEAR_TRAVEL {
            // Bottomed out.
            p.gear = -GEAR_TRAVEL;
            p.gear_vel = p.gear_vel.max(0.0);
        }
        let nosewheel = if p.rot > 0.0 { 0.0 } else { wheels };
        let pitch_target = GEAR_PITCH_PER_ACCEL * (p.speed - speed_before) / dt * nosewheel;
        p.gear_pitch_vel += (-GEAR_PITCH_SPRING * (p.gear_pitch - pitch_target) - GEAR_PITCH_DAMPING * p.gear_pitch_vel) * dt;
        p.gear_pitch += p.gear_pitch_vel * dt;
        let ground = self.environment.height(p.pos.x, p.pos.z);
        let rough = if surface == Surface::Soil { 0.025 * (p.pos.x * 0.7 + p.pos.z * 0.9).sin() * (p.speed / 30.0).min(1.0) } else { 0.0 };
        p.pos.y = ground + wheels_down_height(p.rot.sin()) + p.gear + rough;
        p.ground_height = ground;
        // The struts and the rotation move the origin up and down.
        p.vel.y = (p.pos.y - y_before) / dt;
        // The touchdown attitude eases out so roll and pitch never snap, while the rotation
        // and the struts move the airframe directly: the nose never lags behind them.
        p.settle = p.settle.nlerp(Q::IDENTITY, 1.0 - (-6.0 * dt).exp());
        p.q = strut_attitude(heading, p.rot + p.gear_pitch).mul(p.settle).normalize();
        p.alpha = p.rot;
        p.beta = 0.0;
        p.mach = airspeed / speed_of_sound(p.pos.y);
        p.omega = V3::default();
        p.surf = V3::default();

        // Lift off once the wing carries the weight, the pilot is rotating and the struts
        // have extended. Nothing jumps: the airframe keeps its attitude and height, the
        // pitch rate of the rotation and the climb rate the extending struts gave it.
        if lift_g > 1.02 && rotating && p.gear >= 0.0 {
            p.on_ground = false;
            p.omega = V3::new((p.rot + p.gear_pitch - pitch_before) / dt, 0.0, 0.0);
            p.vel.y = p.vel.y.max(0.0);
            // In the air `speed` is the airspeed.
            p.speed = airspeed;
            p.rot = 0.0;
            p.gear = 0.0;
            p.gear_vel = 0.0;
            p.gear_pitch = 0.0;
            p.gear_pitch_vel = 0.0;
            p.settle = Q::IDENTITY;
        }
        p.bump = bump;
        p.gload = 1.0;
        p.stall = false;
        // Fast off-runway rolling loads the undercarriage instead of behaving like asphalt.
        if surface == Surface::Soil && p.speed > 35.0 {
            let damage = (p.speed - 35.0) * 0.08 * dt;
            p.hp -= damage;
            p.gear_health = (p.gear_health - damage * 0.015).max(0.0);
        }
        if self.environment.surface(p.pos.x, p.pos.z) == Surface::Water || p.hp <= 0.0 {
            let at = p.pos; self.kill_player(at);
        }
    }

    /// Stopped in a hangar long enough: the ground crew rearms, refuels and repairs.
    fn ground_crew(&mut self, dt: f32) {
        let p = &mut self.player;
        if !(in_hangar(p.pos.x, p.pos.z) && p.speed < 3.0 && p.throttle < 0.3 && p.needs_service()) {
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
        self.overspeed(dt);
        if !self.player.alive {
            return;
        }
        // Only a descending aircraft touches down: right after liftoff the wheels may still
        // sit level with the runway while the climb begins.
        let ground = self.environment.height(self.player.pos.x, self.player.pos.z);
        let sink_rate = self.player.vel.y - (ground - self.player.ground_height) / dt;
        let contact = if self.player.gear_position > 0.95 { wheels_down_height(self.player.fwd().y) } else { 0.8 };
        if sink_rate < 0.0 && self.player.pos.y - ground <= contact || self.player.pos.y < ground {
            self.touch_down(sink_rate);
        }
    }

    /// Past the structural speed limit the airframe comes apart; quietly, without a hit
    /// event per step (the HUD shows OVERSPEED).
    fn overspeed(&mut self, dt: f32) {
        let p = &mut self.player;
        let excess = p.overspeed();
        if excess <= 0.0 {
            return;
        }
        p.hp -= OVERSPEED_DAMAGE * excess * dt;
        if p.hp <= 0.0 {
            let pos = p.pos;
            self.kill_player(pos);
        }
    }

    /// The wheels reached the ground: land (possibly hard) or crash.
    fn touch_down(&mut self, sink_rate: f32) {
        let surface = self.environment.surface(self.player.pos.x, self.player.pos.z);
        let ground = self.environment.height(self.player.pos.x, self.player.pos.z);
        let p = &mut self.player;
        let fwd = p.fwd();
        let upv = p.q.rotate(UP);
        // Tyres meet the runway at ground speed, independent of wind and air density.
        let tyres = p.vel.flat().len() < MAX_TOUCHDOWN * p.stats().stall_speed;
        let survivable = surface != Surface::Water && p.gear_position > 0.97 && p.gear_health > 0.25
            && sink_rate > -MAX_SINK_RATE && upv.y > MIN_LANDING_UP && fwd.y > MIN_LANDING_NOSE && tyres;
        if !survivable {
            let pos = V3::new(p.pos.x, ground, p.pos.z);
            self.kill_player(pos);
            self.event(event::GROUND_IMPACT, pos, 1.0);
            return;
        }
        let hard = (-sink_rate - HARD_LANDING_SINK).max(0.0) * HARD_LANDING_DAMAGE;
        p.on_ground = true;
        // Keep the touchdown attitude; the ground roll eases the nose down and wings level.
        // The wheels roll where the nose points, so any crab angle is lost here.
        p.heading = fwd.flat().norm();
        p.speed = p.vel.dot(p.heading).max(0.0);
        p.vel = p.heading.mul(p.speed);
        p.rot = clamp(fwd.y.asin(), 0.0, MAX_ROTATION);
        p.pos.y = ground + wheels_down_height(p.rot.sin());
        p.ground_height = ground;
        p.settle = strut_attitude(p.heading, p.rot).conj().mul(p.q).normalize();
        // The struts soak up the sink rate and rebound.
        p.gear = 0.0;
        p.gear_vel = sink_rate.min(0.0);
        p.gear_pitch = 0.0;
        p.gear_pitch_vel = 0.0;
        let pos = p.pos;
        p.gear_health = (p.gear_health - hard * 0.02).max(0.0);
        self.event(event::LANDED, pos, hard);
        if hard > 0.0 {
            self.damage_player(hard, pos, false);
            if !self.player.alive {
                self.event(event::GROUND_IMPACT, pos.flat(), 1.0);
            }
        }
    }

    /// Mission boundary: warn the pilot and allow time to return under their own control.
    fn update_world_boundary(&mut self, dt: f32) {
        let p = &mut self.player;
        let horiz = p.pos.flat();
        if horiz.len() <= WORLD_LIMIT {
            p.outside = 0.0;
            return;
        }
        p.outside += dt;
        if p.outside >= OUT_OF_BOUNDS_TIME {
            let pos = p.pos;
            self.kill_player(pos);
        }
    }

    fn fire_gun(&mut self) {
        let p = &mut self.player;
        if !(self.input.gun && p.gun_cd <= 0.0 && p.ammo > 0.0 && !p.on_ground) {
            return;
        }
        let s = p.stats();
        let rounds = p.ammo.min(ROUNDS_PER_SHOT);
        let fwd = p.fwd();
        let right = p.q.rotate(RIGHT);
        // Alternate between the two muzzles.
        let side = if (self.time * 40.0) as i32 % 2 == 0 { 1.0 } else { -1.0 };
        let muzzle = p.pos.add(fwd.mul(s.radius)).add(right.mul(side * 1.2));
        let pvel = p.velocity();
        let dir = self.disperse(fwd);
        let vel = dir.mul(PLAYER_BULLET_SPEED).add(pvel);
        if self.spawn_rounds(muzzle, vel, Owner::Player, rounds) {
            self.player.ammo -= rounds;
            self.player.gun_cd += s.gun_interval;
        }
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

    /// Random dispersion of one round inside GUN_DISPERSION around `dir`.
    pub(super) fn disperse(&mut self, dir: V3) -> V3 {
        self.spray(dir, GUN_DISPERSION)
    }

    /// Random offset of up to `spread` rad around `dir`, uniform over the disc.
    pub(super) fn spray(&mut self, dir: V3, spread: f32) -> V3 {
        let side = dir.cross(UP).norm();
        let up = side.cross(dir);
        let a = self.rng.range(0.0, std::f32::consts::TAU);
        let r = spread * self.rng.next().sqrt();
        dir.add(side.mul(a.cos() * r)).add(up.mul(a.sin() * r)).norm()
    }

    /// Missile seeker: track the enemy (aircraft or ground target) closest to the nose
    /// within the cone; holding the same target for LOCK_TIME completes the lock.
    fn update_lock(&mut self, dt: f32) {
        let p = &self.player;
        if !p.airborne() || p.max_missiles == 0.0 {
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
            if !self.detectable(&p.af, pos, matches!(track, Track::Ground(_))) { continue; }
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

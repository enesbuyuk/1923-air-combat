//! Aerodynamic flight model shared by the player and the bots.
//!
//! The aircraft has a real velocity vector: thrust, drag, lift and side force act on it,
//! and the nose only steers it through the angle of attack. Lift scales with air density
//! and airspeed squared, so turns are limited by speed (corner speed) and by the G limit,
//! and every hard pull bleeds energy through induced drag. Accelerations are divided by
//! the mass, which falls as fuel burns: a light aircraft turns and climbs better.
//! Too slow to hold 1 G at maximum lift, the wing stalls: lift falls away, the nose drops
//! and a slipping aircraft drops a wing; it flies again once the speed comes back.
//!
//! The airframe is a rigid body with six degrees of freedom. Aerodynamic moments (static
//! stability, damping, dihedral, control surfaces, stall break and autorotation) and the
//! gyroscopic coupling of its principal moments of inertia (Euler's equations) turn it; a
//! fly-by-wire flight control computer moves rate-limited control surfaces by inverting a
//! model of the unstalled airframe. Position, velocity, attitude and body rates advance
//! together with a fourth-order Runge-Kutta step.

use super::air::{density_ratio, drag_coefficient, ground_effect, speed_of_sound, wave_drag};
use crate::config::*;
use crate::entities::{Airframe, Input};
use crate::math::{clamp, Q, V3, FORWARD, RIGHT, UP};

/// Lift coefficient relative to its maximum: linear up to `alpha_max`, then the wing stalls.
pub fn lift_coefficient(alpha: f32, alpha_max: f32) -> f32 {
    let a = alpha.abs();
    let c = if a <= alpha_max { a / alpha_max } else { (1.0 - (a - alpha_max) * 2.0).max(0.6) };
    c * alpha.signum()
}

/// How far the wing is into the stall, 0..1. `avail` is the lift (in G) the wing makes at
/// `alpha_max`: below 1 G with the AoA near the maximum the flow breaks down, and dragging
/// the AoA past the maximum stalls it at any speed.
pub fn stall_depth(alpha: f32, alpha_max: f32, avail: f32) -> f32 {
    let a = alpha.abs() / alpha_max;
    let near_max = clamp((a - 0.8) / 0.2, 0.0, 1.0);
    let slow = clamp((1.0 - avail) / STALL_RANGE, 0.0, 1.0);
    let past = clamp((a - 1.0) / STALL_OVERSHOOT, 0.0, 1.0);
    (near_max * slow).max(past)
}

/// Lift (in G) per unit of relative lift coefficient: 1 at the stall speed and nominal mass.
pub fn lift_scale(s: &Stats, airspeed: f32, density: f32, mass: f32) -> f32 {
    let eas = airspeed * density.sqrt();
    (eas / s.stall_speed).powi(2) / mass
}

/// Pitch and roll authority left as the air loads stiffen the control surfaces at high
/// equivalent airspeed (`eas`, m/s): 1 up to CONTROL_STIFF_SPEED, then falling.
pub fn control_stiffness(s: &Stats, eas: f32) -> f32 {
    let fast = clamp((eas / s.max_speed - CONTROL_STIFF_SPEED) / (1.0 - CONTROL_STIFF_SPEED), 0.0, 1.0);
    1.0 - (1.0 - CONTROL_STIFF_AUTHORITY) * fast
}

/// Afterburner share of the engine output, 0 in dry power.
pub fn afterburner(s: &Stats, engine: f32) -> f32 {
    if s.afterburner { clamp((engine - AFTERBURNER_DETENT) / (1.0 - AFTERBURNER_DETENT), 0.0, 1.0) } else { 0.0 }
}

/// Thrust multiplier from altitude (density ratio `density`, ISA).
pub fn thrust_lapse(density: f32) -> f32 {
    let trop = density_ratio(TROPOPAUSE);
    if density >= trop { density.powf(THRUST_LAPSE) } else { trop.powf(THRUST_LAPSE) * (density / trop).powf(STRATOSPHERE_LAPSE) }
}

/// Afterburner ram-air gain at `mach`.
pub fn ram_gain(s: &Stats, engine: f32, mach: f32) -> f32 {
    1.0 + RAM_THRUST * afterburner(s, engine) * mach * mach
}

/// Thrust acceleration (m/s^2).
pub fn thrust(af: &Airframe) -> f32 {
    let s = af.stats();
    let health = 0.3 + 0.7 * af.engine_health;
    s.thrust * af.engine * thrust_lapse(af.density) * ram_gain(&s, af.engine, af.mach) * health * af.thrust_scale / af.mass()
}

/// Engine spool: output follows the throttle with a lag, slowest from idle. A dry tank
/// flames the engine out.
pub fn spool_engine(af: &mut Airframe, dt: f32) {
    let s = af.stats();
    let lever = if af.fuel > 0.0 { af.throttle } else { 0.0 };
    let rate = if lever > af.engine { s.spool * (0.35 + 0.65 * af.engine) } else { s.spool * 1.5 };
    af.engine += (lever - af.engine) * (1.0 - (-rate * dt).exp());
}

/// Fuel flow grows with the square of engine output (afterburner); a holed tank leaks.
pub fn burn_fuel(af: &mut Airframe, dt: f32) {
    if !af.burns_fuel {
        return;
    }
    let s = af.stats();
    let e = af.engine;
    let share = if !s.afterburner {
        IDLE_FUEL_FLOW_DRY + (1.0 - IDLE_FUEL_FLOW_DRY) * e
    } else if e <= AFTERBURNER_DETENT {
        IDLE_FUEL_FLOW + (DRY_FUEL_FLOW - IDLE_FUEL_FLOW) * e / AFTERBURNER_DETENT
    } else {
        DRY_FUEL_FLOW + (1.0 - DRY_FUEL_FLOW) * afterburner(&s, e)
    };
    let flow = share / s.endurance;
    af.fuel = (af.fuel - (flow + af.fuel_leak) * dt).max(0.0);
}

// ---------------------------------------------------------------------------
// Rigid body
// ---------------------------------------------------------------------------

/// The state the integrator advances: position, velocity, attitude and body rates.
#[derive(Clone, Copy)]
struct Body {
    pos: V3,
    vel: V3,
    q: Q,
    w: V3,
}

/// Time derivative of a `Body`.
#[derive(Clone, Copy)]
struct Rate {
    vel: V3,
    acc: V3,
    q: Q,
    ang: V3,
}

impl Body {
    fn advance(&self, d: &Rate, h: f32) -> Body {
        Body {
            pos: self.pos.add(d.vel.mul(h)),
            vel: self.vel.add(d.acc.mul(h)),
            q: self.q.add_scaled(d.q, h).normalize(),
            w: self.w.add(d.ang.mul(h)),
        }
    }
}

/// Everything held constant over one step: airframe, engine, atmosphere at the start
/// height, wind and control surface positions.
struct Env {
    s: Stats,
    mass: f32,
    thrust: f32,
    density: f32,
    sound: f32,
    k_drag: f32,
    air: V3,
    surf: V3,
    brake: bool,
    /// Control surface effectiveness left after combat damage.
    ctrl: f32,
}

/// Airflow and loads at one state.
struct Loads {
    /// Aerodynamic and thrust acceleration (world frame, m/s^2), gravity excluded.
    accel: V3,
    v: f32,
    alpha: f32,
    beta: f32,
    /// Lift (G) per unit of relative lift coefficient: dynamic pressure over wing loading.
    q_lift: f32,
    /// Lift (G) the wing would make at `alpha_max`, ground effect included.
    avail: f32,
    /// Stall depth 0..1 (see `stall_depth`).
    depth: f32,
    dir: V3,
    lift_dir: V3,
    side_dir: V3,
    mach: f32,
}

/// Airflow, forces and stall state of the aircraft in state `b`.
fn loads(b: &Body, e: &Env) -> Loads {
    let s = &e.s;
    let va = b.vel.sub(e.air);
    let v = va.len().max(1.0);
    let dir = va.mul(1.0 / v);
    let body = b.q.conj().rotate(dir);
    let alpha = (-body.y).atan2(-body.z);
    let beta = body.x.atan2(-body.z);
    let ge = ground_effect(b.pos.y, s.span);
    let q_lift = lift_scale(s, v, e.density, e.mass);
    let avail = q_lift * (1.0 + GROUND_EFFECT_LIFT * ge);
    let depth = stall_depth(alpha, s.alpha_max, avail);

    let fwd = b.q.rotate(FORWARD);
    let right = b.q.rotate(RIGHT);
    let cl = lift_coefficient(alpha, s.alpha_max);
    // Separated flow over a stalled wing carries less lift.
    let lift_g = cl * avail * (1.0 - STALL_LIFT_LOSS * depth);
    let lift_dir = right.cross(dir).norm();
    let side_g = clamp(-SIDE_FORCE * q_lift * beta, -1.5, 1.5);
    let side_dir = dir.cross(lift_dir);

    let mach = v / e.sound;
    let mut parasitic = e.k_drag * v * v * wave_drag(mach) + LINEAR_DRAG * v;
    if e.brake {
        // Speed brake
        parasitic += 0.05 * v + 1.5 * e.k_drag * v * v;
    }
    // Induced drag grows with lift times lift coefficient: a hard pull bleeds energy.
    let induced = lift_g.abs() * GRAVITY * cl.abs() * INDUCED_DRAG * (1.0 - 0.5 * ge);
    // Past the stall the wing is mostly drag.
    let post_stall = q_lift * GRAVITY * 0.5 * (alpha.abs() - s.alpha_max).max(0.0);
    let drag = e.density * parasitic / e.mass + induced + post_stall;

    let accel = lift_dir.mul(lift_g * GRAVITY).add(side_dir.mul(side_g * GRAVITY)).add(dir.mul(-drag)).add(fwd.mul(e.thrust));
    Loads { accel, v, alpha, beta, q_lift, avail, depth, dir, lift_dir, side_dir, mach }
}

/// Aerodynamic angular acceleration (body frame) at body rates `w` with the control
/// surfaces at `surf`. `full` adds what the flight control computer's model of the
/// airframe leaves out: the stall (separated flow, nose-down break, wing drop,
/// autorotation) and combat damage to the control surfaces.
fn aero_moment(e: &Env, l: &Loads, w: V3, surf: V3, full: bool) -> V3 {
    let s = &e.s;
    let qd = l.q_lift;
    // Damping moments scale with density times airspeed rather than its square.
    let qv = l.q_lift * s.stall_speed / l.v;
    let (depth, health) = if full { (l.depth, e.ctrl) } else { (0.0, 1.0) };
    let elevator = ELEVATOR_POWER * (1.0 - STALL_PITCH_AUTHORITY * depth) * health;
    let ailerons = ROLL_POWER * (1.0 - STALL_AILERON_LOSS * depth) * health;
    let rudder = RUDDER_POWER * health;
    let mut m = V3::new(
        s.pitch_rate * (qd * (-PITCH_STIFFNESS * l.alpha + elevator * surf.x) - PITCH_DAMPING * qv * w.x),
        s.yaw_rate * (qd * (-YAW_STIFFNESS * l.beta + rudder * surf.y) - YAW_DAMPING * qv * w.y),
        s.roll_rate * (qd * (DIHEDRAL * l.beta + ailerons * surf.z) - ROLL_DAMPING * (1.0 - depth) * qv * w.z),
    );
    if depth > 0.0 {
        // Stall break: the nose pitches down toward the airflow.
        m.x -= STALL_PITCH_MOMENT * qd.min(2.0) * depth * l.alpha.signum();
        // A slipping (or ruddered) stall drops the wing on the side the nose yaws toward; a
        // coordinated one keeps the wings level. The down-going wing stalls deeper and keeps
        // the roll going (autorotation): squared, so a light buffet never spins.
        let slip = clamp(l.beta / WING_DROP_BETA + surf.y, -1.0, 1.0);
        let spin = clamp(w.z / SPIN_ROLL_RATE + surf.y, -1.0, 1.0) * depth * depth;
        let roll_to = WING_DROP * depth * slip + SPIN_ROLL_RATE * spin;
        let yaw_to = WING_DROP_YAW * depth * slip + SPIN_YAW * spin;
        m.z += AUTOROTATION * depth * (roll_to - w.z);
        m.y += AUTOROTATION * depth * (yaw_to - w.y);
    }
    m
}

/// Gyroscopic (inertia) coupling -I^-1 (w x I w) for the principal moments `i`.
fn gyroscopic(w: V3, i: V3) -> V3 {
    V3::new(-w.y * w.z * (i.z - i.y) / i.x, -w.z * w.x * (i.x - i.z) / i.y, -w.x * w.y * (i.y - i.x) / i.z)
}

fn rate(b: &Body, e: &Env) -> Rate {
    let l = loads(b, e);
    let ang = aero_moment(e, &l, b.w, e.surf, true).add(gyroscopic(b.w, e.s.inertia));
    Rate { vel: b.vel, acc: l.accel.add(V3::new(0.0, -GRAVITY, 0.0)), q: b.q.derivative(b.w), ang }
}

/// Classic fourth-order Runge-Kutta step of the rigid body.
fn rk4(b: &Body, e: &Env, dt: f32) -> Body {
    let k1 = rate(b, e);
    let k2 = rate(&b.advance(&k1, 0.5 * dt), e);
    let k3 = rate(&b.advance(&k2, 0.5 * dt), e);
    let k4 = rate(&b.advance(&k3, dt), e);
    let sum = |a: V3, b: V3, c: V3, d: V3| a.add(b.mul(2.0)).add(c.mul(2.0)).add(d);
    let avg = Rate {
        vel: sum(k1.vel, k2.vel, k3.vel, k4.vel).mul(1.0 / 6.0),
        acc: sum(k1.acc, k2.acc, k3.acc, k4.acc).mul(1.0 / 6.0),
        q: k1.q.add_scaled(k2.q, 2.0).add_scaled(k3.q, 2.0).add_scaled(k4.q, 1.0),
        ang: sum(k1.ang, k2.ang, k3.ang, k4.ang).mul(1.0 / 6.0),
    };
    let avg = Rate { q: Q { x: avg.q.x / 6.0, y: avg.q.y / 6.0, z: avg.q.z / 6.0, w: avg.q.w / 6.0 }, ..avg };
    b.advance(&avg, dt)
}

// ---------------------------------------------------------------------------
// Flight control computer
// ---------------------------------------------------------------------------

/// Fly-by-wire: turns the stick into body-rate commands (AoA / G limiter, auto-trim, turn
/// coordination, rolls about the flight path) and inverts the nominal airframe model for
/// the surface deflections that give the wanted angular acceleration (nonlinear dynamic
/// inversion). The model knows nothing of the stall or of damage, and the surfaces only
/// move so far, so a slow or stalled aircraft runs out of authority.
fn flight_controls(af: &Airframe, inp: &Input, e: &Env, l: &Loads) -> V3 {
    let s = &e.s;
    let w = af.omega;
    let (alpha, beta, q_lift, avail) = (l.alpha, l.beta, l.q_lift, l.avail);

    // Gain schedule on equivalent airspeed: soft just above the stall, then the air loads
    // stiffen the surfaces at high speed.
    let eas = l.v * e.density.sqrt();
    let eff = clamp(eas / (s.stall_speed * 1.6), 0.15, 1.0);
    let stiff = control_stiffness(s, eas);
    let pitch_auth = clamp((eas - s.stall_speed) / (s.stall_speed * 1.5), 0.15, 1.0);
    let stab = 0.4 + 0.6 * eff;

    // With the stick centred the flight controls trim for the load factor that keeps the
    // flight path straight (in a bank up to 60 deg too), so the nose rides a few degrees
    // above the path at low speed. Near knife-edge there is nothing to trim with.
    let alpha_1g = s.alpha_max / q_lift;
    let dir = l.dir;
    let right = af.q.rotate(RIGHT);
    let cos_path = (1.0 - dir.y * dir.y).max(0.0).sqrt();
    // Bank relative to the flight path: lift direction against the path's own vertical.
    let path_up = UP.sub(dir.mul(dir.y)).norm();
    let cos_bank = if cos_path > 0.05 { right.cross(dir).norm().dot(path_up) } else { 1.0 };
    let n_path = if cos_bank.abs() >= 0.5 { cos_path / cos_bank } else { 4.0 * cos_path * cos_bank };
    // Thrust tilted up by the AoA already carries part of the weight.
    let n_trim = n_path - e.thrust * alpha.sin() / GRAVITY;
    // AoA / G limiter. Near the 1 G stall speed a hard pull drags the AoA a little past it,
    // onto the back of the lift curve.
    let overshoot = inp.pitch.max(0.0) * clamp((1.0 + STALL_RANGE - avail) / STALL_RANGE, 0.0, 1.0);
    let a_hi = s.alpha_max.min(s.g_limit * alpha_1g) * (1.0 + STALL_OVERSHOOT * overshoot);
    let a_lo = (-0.5 * s.alpha_max).max(-NEG_G_LIMIT * alpha_1g);
    let mut alpha_trim = clamp(n_trim * alpha_1g, a_lo, a_hi);
    // Slow, the stick still holds the AoA it asks for: stick back keeps a stalled wing
    // stalled (and a spin spinning) until it is released.
    // Takeoff and landing gains, 0 (off) to 1 (low and slow): see LOW_GAIN_HEIGHT.
    let low = if af.low_gains {
        let height = clamp(1.0 - (af.pos.y - GEAR_HEIGHT) / LOW_GAIN_HEIGHT, 0.0, 1.0);
        height * clamp((LOW_GAIN_SPEED + LOW_GAIN_FADE - eas / s.stall_speed) / LOW_GAIN_FADE, 0.0, 1.0)
    } else {
        0.0
    };
    let slow_hold = clamp((1.0 - pitch_auth) / 0.85, 0.0, 1.0) * inp.pitch.max(0.0) * (1.0 - low);
    alpha_trim += (a_hi - alpha_trim) * slow_hold;

    // How fast the airflow itself turns about the body pitch and yaw axes: holding the AoA
    // and sideslip in a turn needs the nose to follow it.
    let acc = l.accel.add(V3::new(0.0, -GRAVITY, 0.0));
    let path_pitch = acc.dot(l.lift_dir) / l.v;
    let path_yaw = -acc.dot(l.side_dir) / l.v;

    let stick_rate = s.pitch_rate * pitch_auth * stiff;
    let stick_rate = stick_rate + (stick_rate.min(ROTATE_RATE) - stick_rate) * low;
    let mut cmd_pitch = inp.pitch * stick_rate + PITCH_STABILITY * stab * (alpha_trim - alpha);
    cmd_pitch = cmd_pitch.min(path_pitch + FCS_ALPHA_LIMIT_GAIN * (a_hi - alpha)).max(path_pitch + FCS_ALPHA_LIMIT_GAIN * (a_lo - alpha));
    // Under load the flight controls limit the roll rate.
    let roll_auth = 1.0 - ROLL_LOAD_REDUCTION * clamp(alpha.abs() / s.alpha_max, 0.0, 1.0);
    let cmd_roll = -inp.roll * s.roll_rate * eff * stiff * roll_auth;
    // Rudder pedals ask for sideslip; centred, the yaw channel coordinates the turn and the
    // roll about the flight path (body yaw rate = roll rate * tan AoA).
    let beta_cmd = -inp.yaw * PEDAL_BETA;
    let cmd_yaw = path_yaw + cmd_roll * alpha.tan() - YAW_STABILITY * stab * (beta - beta_cmd);
    let cmd = V3::new(cmd_pitch, cmd_yaw, cmd_roll);

    let gain = V3::new(FCS_PITCH_GAIN * s.pitch_rate, FCS_YAW_GAIN, ROLL_RESPONSE * s.roll_rate);
    let wanted = cmd.sub(w).scale(gain);
    let model = aero_moment(e, l, w, V3::default(), false).add(gyroscopic(w, s.inertia));
    let power = V3::new(s.pitch_rate * ELEVATOR_POWER, s.yaw_rate * RUDDER_POWER, s.roll_rate * ROLL_POWER).mul(q_lift);
    let need = wanted.sub(model);
    V3::new(clamp(need.x / power.x, -1.0, 1.0), clamp(need.y / power.y, -1.0, 1.0), clamp(need.z / power.z, -1.0, 1.0))
}

/// Moves an actuator from `at` toward `to` by at most `max`.
fn actuate(at: f32, to: f32, max: f32) -> f32 {
    at + clamp(to - at, -max, max)
}

/// One flight step. `air` is the wind at the aircraft, `roll_bump` the turbulence bank
/// offset (see `Weather::roll`). The caller handles ground contact.
pub fn fly(af: &mut Airframe, inp: &Input, air: V3, roll_bump: f32, dt: f32) {
    let s = af.stats();
    af.throttle = clamp(inp.throttle, 0.0, 1.0);
    spool_engine(af, dt);
    burn_fuel(af, dt);
    af.density = density_ratio(af.pos.y);
    let mut e = Env {
        s,
        mass: af.mass(),
        thrust: thrust(af),
        density: af.density,
        sound: speed_of_sound(af.pos.y),
        k_drag: drag_coefficient(&s),
        air,
        surf: af.surf,
        brake: inp.brake,
        ctrl: 0.35 + 0.65 * af.control_health,
    };
    let body = Body { pos: af.pos, vel: af.vel, q: af.q, w: af.omega };

    // The flight control computer samples the state once per step; the actuators then
    // move the surfaces at their rate limit and hold them through the step.
    let u = flight_controls(af, inp, &e, &loads(&body, &e));
    let max = SURFACE_RATE * dt;
    af.surf = V3::new(actuate(af.surf.x, u.x, max), actuate(af.surf.y, u.y, max), actuate(af.surf.z, u.z, max));
    e.surf = af.surf;

    let next = rk4(&body, &e, dt);
    af.pos = next.pos;
    af.vel = next.vel;
    af.omega = next.w;
    // Turbulence nudges the bank angle; only the change of the disturbance is applied, so
    // the wings return when the air calms.
    af.q = next.q.mul(Q::axis_angle(V3::new(0.0, 0.0, 1.0), roll_bump - af.bump)).normalize();
    af.bump = roll_bump;
    // Numerical safety net; drag holds the real limit well below this.
    let ceiling = s.max_speed * 3.0;
    if af.vel.len() > ceiling {
        af.vel = af.vel.norm().mul(ceiling);
    }

    let l = loads(&Body { pos: af.pos, vel: af.vel, q: af.q, w: af.omega }, &e);
    af.speed = af.vel.sub(air).len();
    af.alpha = l.alpha;
    af.beta = l.beta;
    af.mach = l.mach;
    // Felt load: aerodynamic force along the seat axis.
    af.gload = l.accel.dot(af.q.rotate(UP)) / GRAVITY;
    // Stalled: the wing cannot hold 1 G at this speed, or the AoA is past the limit.
    af.stall = l.avail < 1.0 || l.alpha.abs() > s.alpha_max * 1.05;
}

#[cfg(test)]
pub fn gyroscopic_for_tests(w: V3, i: V3) -> V3 {
    gyroscopic(w, i)
}

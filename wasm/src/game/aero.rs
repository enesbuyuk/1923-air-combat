//! Aerodynamic flight model shared by the player and the bots.
//!
//! The aircraft has a real velocity vector: thrust, drag, lift and side force act on it,
//! and the nose only steers it through the angle of attack. Lift scales with air density
//! and airspeed squared, so turns are limited by speed (corner speed) and by the G limit,
//! and every hard pull bleeds energy through induced drag. Accelerations are divided by
//! the mass, which falls as fuel burns: a light aircraft turns and climbs better.

use super::air::{density_ratio, drag_coefficient, ground_effect, speed_of_sound, wave_drag};
use crate::config::*;
use crate::entities::{Airframe, Input};
use crate::math::{clamp, Q, V3, RIGHT, UP};

/// Lift coefficient relative to its maximum: linear up to `alpha_max`, then the wing stalls.
pub fn lift_coefficient(alpha: f32, alpha_max: f32) -> f32 {
    let a = alpha.abs();
    let c = if a <= alpha_max { a / alpha_max } else { (1.0 - (a - alpha_max) * 2.0).max(0.6) };
    c * alpha.signum()
}

/// Lift (in G) per unit of relative lift coefficient: 1 at the stall speed and nominal mass.
pub fn lift_scale(s: &Stats, airspeed: f32, density: f32, mass: f32) -> f32 {
    let eas = airspeed * density.sqrt();
    (eas / s.stall_speed).powi(2) / mass
}

/// Thrust acceleration (m/s^2).
pub fn thrust(af: &Airframe) -> f32 {
    let s = af.stats();
    let health = 0.3 + 0.7 * af.engine_health;
    s.thrust * af.engine * af.density.powf(THRUST_LAPSE) * health * af.thrust_scale / af.mass()
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
    let flow = (IDLE_FUEL_FLOW + (1.0 - IDLE_FUEL_FLOW) * af.engine * af.engine) / s.endurance;
    af.fuel = (af.fuel - (flow + af.fuel_leak) * dt).max(0.0);
}

/// One flight step. `air` is the wind at the aircraft, `roll_bump` the turbulence bank
/// offset (see `Weather::roll`). The caller handles ground contact.
pub fn fly(af: &mut Airframe, inp: &Input, air: V3, roll_bump: f32, dt: f32) {
    let s = af.stats();
    af.throttle = clamp(inp.throttle, 0.0, 1.0);
    spool_engine(af, dt);
    burn_fuel(af, dt);
    let h = af.pos.y;
    af.density = density_ratio(h);
    let ge = ground_effect(h);
    let mass = af.mass();
    // Damaged flight controls lose authority.
    let ctrl = 0.35 + 0.65 * af.control_health;

    // Airflow relative to the aircraft.
    let va = af.vel.sub(air);
    let v = va.len().max(1.0);
    let dir = va.mul(1.0 / v);
    let q_lift = lift_scale(&s, v, af.density, mass);
    let body = af.q.conj().rotate(dir);
    let alpha = (-body.y).atan2(-body.z);
    let beta = body.x.atan2(-body.z);

    // Control surfaces lose authority with dynamic pressure.
    let eas = v * af.density.sqrt();
    let eff = clamp(eas / (s.stall_speed * 1.6), 0.15, 1.0);
    // Elevator authority grows with airspeed: sluggish just above stall
    // (right after liftoff), full only at combat speed.
    let pitch_auth = clamp((eas - s.stall_speed) / (s.stall_speed * 1.5), 0.15, 1.0);
    let target_rate = inp.pitch * s.pitch_rate * pitch_auth * ctrl;
    // Pitch inertia: heavier aircraft (lower pitch_rate) respond more slowly.
    let k = 1.0 - (-2.5 * s.pitch_rate * dt).exp();
    af.pitch_vel += (target_rate - af.pitch_vel) * k;
    // Roll inertia: the roll rate builds up and dies away instead of starting at once.
    let target_roll = -inp.roll * s.roll_rate * eff * ctrl;
    let k = 1.0 - (-ROLL_RESPONSE * s.roll_rate * dt).exp();
    af.roll_vel += (target_roll - af.roll_vel) * k;

    // With the stick centred the flight controls trim for the load factor that keeps
    // the flight path straight (in a bank up to 60 deg too), so the nose rides a few
    // degrees above the path at low speed. Near knife-edge there is nothing to trim with.
    let alpha_1g = s.alpha_max / q_lift;
    let right = af.q.rotate(RIGHT);
    let cos_path = (1.0 - dir.y * dir.y).max(0.0).sqrt();
    // Bank relative to the flight path: lift direction against the path's own vertical.
    let path_up = UP.sub(dir.mul(dir.y)).norm();
    let cos_bank = if cos_path > 0.05 { right.cross(dir).norm().dot(path_up) } else { 1.0 };
    let n_path = if cos_bank.abs() >= 0.5 { cos_path / cos_bank } else { 4.0 * cos_path * cos_bank };
    // Thrust tilted up by the AoA already carries part of the weight.
    let n_trim = n_path - thrust(af) * alpha.sin() / GRAVITY;
    // AoA / G limiter.
    let a_hi = s.alpha_max.min(s.g_limit * alpha_1g);
    let a_lo = (-0.5 * s.alpha_max).max(-NEG_G_LIMIT * alpha_1g);
    let alpha_trim = clamp(n_trim * alpha_1g, a_lo, a_hi);

    // Weathervane stability: pitch toward the trim AoA, yaw out of any sideslip.
    let stab = 0.4 + 0.6 * eff;
    let pitch_stab = clamp(PITCH_STABILITY * stab * (alpha_trim - alpha), -2.0, 2.0);
    let mut d_pitch = (af.pitch_vel + pitch_stab) * dt;
    if d_pitch > a_hi - alpha {
        d_pitch = (a_hi - alpha).max(-1.5 * dt);
    } else if d_pitch < a_lo - alpha {
        d_pitch = (a_lo - alpha).min(1.5 * dt);
    }
    let yaw_stab = clamp(YAW_STABILITY * stab * beta, -2.0, 2.0);
    let d_yaw = (-inp.yaw * s.yaw_rate * eff * ctrl - yaw_stab) * dt;
    // Turbulence nudges the bank angle; the flight controls hold attitude, so only the
    // change of the disturbance is applied and the wings return when the air calms.
    let d_roll = af.roll_vel * dt + (roll_bump - af.bump);
    af.bump = roll_bump;
    let qp = Q::axis_angle(RIGHT, d_pitch);
    let qr = Q::axis_angle(V3::new(0.0, 0.0, 1.0), d_roll);
    let qy = Q::axis_angle(UP, d_yaw);
    af.q = af.q.mul(qp).mul(qr).mul(qy).normalize();

    // Forces on the new attitude.
    let fwd = af.fwd();
    let right = af.q.rotate(RIGHT);
    let upv = af.q.rotate(UP);
    let body = af.q.conj().rotate(dir);
    let alpha = (-body.y).atan2(-body.z);
    let beta = body.x.atan2(-body.z);
    let cl = lift_coefficient(alpha, s.alpha_max);
    let lift_g = cl * q_lift * (1.0 + GROUND_EFFECT_LIFT * ge);
    let lift_dir = right.cross(dir).norm();
    let side_g = clamp(-SIDE_FORCE * q_lift * beta, -1.5, 1.5);
    let side_dir = dir.cross(lift_dir);

    af.mach = v / speed_of_sound(h);
    let k_drag = drag_coefficient(&s);
    let mut parasitic = k_drag * v * v * wave_drag(af.mach) + LINEAR_DRAG * v;
    if inp.brake {
        // Speed brake
        parasitic += 0.05 * v + 1.5 * k_drag * v * v;
    }
    // Induced drag grows with lift times lift coefficient: a hard pull bleeds energy.
    let induced = lift_g.abs() * GRAVITY * cl.abs() * INDUCED_DRAG * (1.0 - 0.5 * ge);
    // Past the stall the wing is mostly drag.
    let post_stall = q_lift * GRAVITY * 0.5 * (alpha.abs() - s.alpha_max).max(0.0);
    let drag = af.density * parasitic / mass + induced + post_stall;

    let aero = lift_dir
        .mul(lift_g * GRAVITY)
        .add(side_dir.mul(side_g * GRAVITY))
        .add(dir.mul(-drag))
        .add(fwd.mul(thrust(af)));
    // Semi-implicit Euler: the new velocity moves the aircraft.
    af.vel = af.vel.add(aero.add(V3::new(0.0, -GRAVITY, 0.0)).mul(dt));
    // Numerical safety net; drag holds the real limit well below this.
    let ceiling = s.max_speed * 1.6;
    if af.vel.len() > ceiling {
        af.vel = af.vel.norm().mul(ceiling);
    }
    af.speed = af.vel.sub(air).len();
    af.alpha = alpha;
    af.beta = beta;
    // Felt load: aerodynamic force along the seat axis.
    af.gload = aero.dot(upv) / GRAVITY;
    // Stalled: the wing cannot hold 1 G at this speed, or the AoA is past the limit.
    af.stall = q_lift * (1.0 + GROUND_EFFECT_LIFT * ge) < 1.0 || alpha.abs() > s.alpha_max * 1.05;

    af.pos = af.pos.add(af.vel.mul(dt));
}

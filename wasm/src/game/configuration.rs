//! Physical landing gear and high-lift configuration, shared by every aircraft.
use crate::config::*;
use crate::entities::Airframe;
use crate::math::clamp;

pub fn update(af: &mut Airframe, dt: f32) {
    let eas = af.speed * af.density.sqrt();
    // Excess air loads progressively damage and eventually jam the actuators.
    if eas > GEAR_SPEED_LIMIT && af.gear_position > 0.02 {
        af.gear_health = (af.gear_health - (eas / GEAR_SPEED_LIMIT - 1.0) * dt * 0.8).max(0.0);
    }
    let flap_limit = FLAP_SPEED_LIMIT + (1.0 - af.flaps) * 35.0;
    if eas > flap_limit && af.flaps > 0.02 {
        af.flap_health = (af.flap_health - (eas / flap_limit - 1.0) * dt).max(0.0);
    }
    if af.gear_health > 0.1 {
        let target = if af.gear_down { 1.0 } else { 0.0 };
        af.gear_position += clamp(target - af.gear_position, -dt / GEAR_TRANSIT, dt / GEAR_TRANSIT);
    }
    if af.flap_health > 0.1 {
        af.flaps += clamp(af.flap_command - af.flaps, -dt / FLAP_TRANSIT, dt / FLAP_TRANSIT);
    }
}

pub fn lift_factor(af: &Airframe) -> f32 { 1.0 + FLAP_LIFT_GAIN * af.flaps * af.flap_health }
pub fn camber(af: &Airframe) -> f32 { FLAP_CAMBER * af.flaps * af.flap_health * af.stats().alpha_max }
pub fn drag(af: &Airframe) -> f32 { GEAR_DRAG * af.gear_position + FLAP_DRAG * af.flaps * af.flaps }

/// The same damage probabilities and severity for player and AI airframes.
pub fn system_damage(af: &mut Airframe, damage: f32, roll: f32, severity: f32) -> f32 {
    let scale = (damage / 10.0).min(3.0);
    let amount = damage * SYSTEM_DAMAGE_PER_HP * severity;
    if roll < ENGINE_HIT_CHANCE * scale {
        af.engine_health = (af.engine_health - amount).max(0.0); 1.0
    } else if roll < (ENGINE_HIT_CHANCE + CONTROL_HIT_CHANCE) * scale {
        af.control_health = (af.control_health - amount).max(0.0); 2.0
    } else if roll < (ENGINE_HIT_CHANCE + CONTROL_HIT_CHANCE + TANK_HIT_CHANCE) * scale {
        af.fuel_leak += damage * LEAK_PER_HP; 3.0
    } else { 0.0 }
}

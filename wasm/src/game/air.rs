//! Atmosphere (ISA density, speed of sound, compressibility) and weather
//! (steady wind, gusts, low-level turbulence).

use super::Game;
use crate::config::*;
use crate::math::{clamp, Rng, V3};

/// Air density relative to sea level (ISA troposphere and lower stratosphere).
pub fn density_ratio(h: f32) -> f32 {
    let h = h.max(0.0);
    if h < 11000.0 {
        (1.0 - 2.25577e-5 * h).powf(4.2559)
    } else {
        0.2971 * (-(h - 11000.0) / 6341.6).exp()
    }
}

pub fn speed_of_sound(h: f32) -> f32 {
    let t = (288.15 - 0.0065 * h.max(0.0)).max(216.65);
    20.05 * t.sqrt()
}

/// Drag multiplier from compressibility: flat below Mach 0.8, peaks just past Mach 1, then eases.
pub fn wave_drag(mach: f32) -> f32 {
    if mach < 0.8 {
        1.0
    } else if mach < 1.05 {
        let t = (mach - 0.8) / 0.25;
        1.0 + WAVE_DRAG * t * t
    } else {
        1.0 + WAVE_DRAG * (1.0 - 0.3 * clamp((mach - 1.05) / 0.5, 0.0, 1.0))
    }
}

/// Parasitic drag coefficient that makes full sea-level thrust balance drag at max speed.
pub fn drag_coefficient(s: &Stats) -> f32 {
    let v = s.max_speed;
    (s.thrust - LINEAR_DRAG * v) / (v * v * wave_drag(v / speed_of_sound(0.0)))
}

/// Ground effect strength: 1 on the surface, 0 at GROUND_EFFECT_HEIGHT and above.
pub fn ground_effect(h: f32) -> f32 {
    let k = clamp(1.0 - h / GROUND_EFFECT_HEIGHT, 0.0, 1.0);
    k * k
}

/// Zero-mean, unit-variance noise sample.
fn noise(rng: &mut Rng) -> f32 {
    (rng.next() - 0.5) * 3.464
}

pub struct Weather {
    /// Steady wind at 10 m (the direction the air moves toward).
    pub wind: V3,
    /// Current gust on top of the steady wind.
    pub gust: V3,
    /// Bank disturbance (rad) from turbulence and stall buffet.
    pub roll: f32,
    /// Raw noise driving `gust` and `roll`; low-passed so the result is smooth, not jittery.
    gust_drive: V3,
    roll_drive: f32,
}

impl Weather {
    pub fn new(rng: &mut Rng) -> Weather {
        let a = rng.range(0.0, std::f32::consts::TAU);
        let speed = rng.range(WIND_MIN, WIND_MAX);
        Weather { wind: V3::new(a.cos() * speed, 0.0, a.sin() * speed), gust: V3::default(), roll: 0.0, gust_drive: V3::default(), roll_drive: 0.0 }
    }

    /// Air velocity at height `h`: the wind strengthens with height through the boundary layer.
    pub fn air_at(&self, h: f32) -> V3 {
        let shear = clamp((h.max(1.0) / 10.0).powf(0.14), 0.5, 1.8);
        self.wind.mul(shear).add(self.gust)
    }
}

impl Game {
    /// Advances the gusts (Ornstein-Uhlenbeck noise) around the player's height.
    pub(super) fn update_weather(&mut self, dt: f32) {
        let h = self.player.pos.y;
        let stalled = self.player.stall && self.player.airborne();
        let w = &mut self.weather;
        let low = (1.0 - h / TURBULENCE_HEIGHT).max(0.0);
        let strength = GUST_BASE + GUST_LOW * low * (0.5 + w.wind.len() / WIND_MAX);
        let k = (-dt / GUST_TIME).exp();
        let amp = strength * (1.0 - k * k).sqrt();
        let rng = &mut self.rng;
        w.gust_drive = V3::new(
            w.gust_drive.x * k + amp * noise(rng),
            w.gust_drive.y * k + amp * 0.6 * noise(rng),
            w.gust_drive.z * k + amp * noise(rng),
        );
        // Second-order filter: the gust follows the drive smoothly instead of stepping each tick.
        let s = 1.0 - (-dt / GUST_SMOOTH).exp();
        w.gust = w.gust.add(w.gust_drive.sub(w.gust).mul(s));
        // Bank bumps: quicker than the gusts; a stalled wing buffets hard.
        let kr = (-dt / ROLL_TIME).exp();
        let roll_amp = ROLL_BUMP * strength + if stalled { 0.08 } else { 0.0 };
        w.roll_drive = w.roll_drive * kr + roll_amp * (1.0 - kr * kr).sqrt() * noise(rng);
        let sr = 1.0 - (-dt / ROLL_SMOOTH).exp();
        w.roll += (w.roll_drive - w.roll) * sr;
    }
}

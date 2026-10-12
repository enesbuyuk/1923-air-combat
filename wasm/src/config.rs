//! Tuning data: aircraft performance, difficulty presets, physics and airfield constants.

use crate::math::V3;

// ---------------------------------------------------------------------------
// Aircraft (index = aircraft type, shared with JS)
// ---------------------------------------------------------------------------

pub const B2: usize = 2;

#[derive(Clone, Copy)]
pub struct Stats {
    pub max_speed: f32,
    pub thrust: f32,
    pub pitch_rate: f32,
    pub roll_rate: f32,
    pub yaw_rate: f32,
    pub hp: f32,
    pub missiles: f32,
    pub gun_interval: f32,
    /// Vr: minimum speed (m/s) at which the nose can be raised for takeoff.
    pub rotate_speed: f32,
    /// 1 G stall speed (equivalent airspeed, m/s) at `alpha_max`.
    pub stall_speed: f32,
    /// Collision radius (m).
    pub radius: f32,
    /// Structural / flight-control G limit.
    pub g_limit: f32,
    /// Angle of attack (rad) at maximum lift; the flight controls stop the nose here.
    pub alpha_max: f32,
    /// Engine spool rate (1/s): how fast thrust follows the throttle.
    pub spool: f32,
    /// Seconds a full tank lasts at full throttle.
    pub endurance: f32,
    pub flares: f32,
}

/// 0 = F-16, 1 = F-22 Raptor, 2 = B-2 Spirit, 3 = KAAN.
/// `max_speed` is the sea-level top speed at full throttle; thinner air up high allows more.
pub const STATS: [Stats; 4] = [
    Stats { max_speed: 400.0, thrust: 16.0, pitch_rate: 1.0, roll_rate: 2.6, yaw_rate: 0.45, hp: 100.0, missiles: 6.0, gun_interval: 0.05, rotate_speed: 72.0, stall_speed: 55.0, radius: 9.0, g_limit: 9.0, alpha_max: 0.44, spool: 1.0, endurance: 480.0, flares: 30.0 },
    Stats { max_speed: 450.0, thrust: 19.0, pitch_rate: 1.15, roll_rate: 2.5, yaw_rate: 0.55, hp: 120.0, missiles: 8.0, gun_interval: 0.05, rotate_speed: 75.0, stall_speed: 48.0, radius: 10.0, g_limit: 9.0, alpha_max: 0.52, spool: 1.1, endurance: 540.0, flares: 30.0 },
    Stats { max_speed: 260.0, thrust: 9.0, pitch_rate: 0.5, roll_rate: 0.9, yaw_rate: 0.25, hp: 320.0, missiles: 16.0, gun_interval: 0.10, rotate_speed: 80.0, stall_speed: 60.0, radius: 22.0, g_limit: 2.5, alpha_max: 0.30, spool: 0.6, endurance: 1500.0, flares: 60.0 },
    Stats { max_speed: 430.0, thrust: 18.0, pitch_rate: 1.1, roll_rate: 2.5, yaw_rate: 0.50, hp: 115.0, missiles: 8.0, gun_interval: 0.05, rotate_speed: 74.0, stall_speed: 50.0, radius: 10.0, g_limit: 9.0, alpha_max: 0.48, spool: 1.0, endurance: 540.0, flares: 30.0 },
];

/// Fighter types an enemy wave draws from (the B-2 is added separately).
pub const BOT_FIGHTERS: [usize; 3] = [0, 1, 3];

// ---------------------------------------------------------------------------
// Difficulty (0 easy, 1 medium, 2 hard). Medium is the original tuning.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct Difficulty {
    /// Multiplies the wave-based skill: turn rate, fire rate and aim spread.
    pub skill: f32,
    pub hp: f32,
    pub speed: f32,
    /// Hull damage per enemy cannon round.
    pub damage: f32,
    pub gun_range: f32,
    /// Cosine of the cone the player must be in before a bot opens fire.
    pub aim_cone: f32,
}

pub const DIFFICULTY: [Difficulty; 3] = [
    Difficulty { skill: 0.65, hp: 0.75, speed: 0.9, damage: 2.0, gun_range: 1000.0, aim_cone: 0.992 },
    Difficulty { skill: 1.0, hp: 1.0, speed: 1.0, damage: 3.5, gun_range: 1300.0, aim_cone: 0.985 },
    Difficulty { skill: 1.35, hp: 1.35, speed: 1.1, damage: 5.0, gun_range: 1600.0, aim_cone: 0.975 },
];
pub const DEFAULT_DIFFICULTY: usize = 1;

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

pub const GRAVITY: f32 = 9.81;
/// Height of the aircraft origin above the ground while on its wheels.
pub const GEAR_HEIGHT: f32 = 2.2;
/// Takeoff rotation: nose comes up at ROTATE_RATE (rad/s) up to MAX_ROTATION (tail strike
/// angle); the aircraft lifts off once the wing makes more than its weight in lift.
pub const ROTATE_RATE: f32 = 0.12;
pub const MAX_ROTATION: f32 = 0.22;
/// Nose-lowering rate (rad/s) after touchdown or an aborted rotation.
pub const DEROTATE_RATE: f32 = 0.1;
/// Below this height the ground boosts lift and cuts induced drag.
pub const GROUND_EFFECT_HEIGHT: f32 = 25.0;
/// Extra lift fraction right at the surface.
pub const GROUND_EFFECT_LIFT: f32 = 0.15;
pub const ROLLING_FRICTION: f32 = 0.6;
pub const WHEEL_BRAKE: f32 = 18.0;

// Aerodynamics (accelerations are per unit mass, so thrust/drag are in m/s^2).
/// Induced drag per unit lift at maximum lift coefficient.
pub const INDUCED_DRAG: f32 = 0.3;
/// Speed-proportional drag (trim, gear, intakes); keeps an idle aircraft slowing down.
pub const LINEAR_DRAG: f32 = 0.02;
/// Peak transonic drag rise on top of the subsonic drag (x1 = double drag).
pub const WAVE_DRAG: f32 = 1.5;
/// Side force (in G per radian of sideslip) at the stall speed.
pub const SIDE_FORCE: f32 = 0.3;
/// Weathervane stability (1/s): how fast the nose aligns with the airflow.
pub const PITCH_STABILITY: f32 = 3.0;
pub const YAW_STABILITY: f32 = 2.5;
/// Negative load factor the G limiter allows when pushing the nose down.
pub const NEG_G_LIMIT: f32 = 5.0;
/// Thrust ~ density^THRUST_LAPSE.
pub const THRUST_LAPSE: f32 = 0.7;

// Weather.
pub const WIND_MIN: f32 = 2.0;
pub const WIND_MAX: f32 = 9.0;
/// Gust correlation time (s).
pub const GUST_TIME: f32 = 1.5;
/// Gust strength (m/s) everywhere, plus the low-level boost below TURBULENCE_HEIGHT.
pub const GUST_BASE: f32 = 0.3;
pub const GUST_LOW: f32 = 0.8;
/// Smoothing time (s) of the gust and bank-bump filters (removes high-frequency jitter).
pub const GUST_SMOOTH: f32 = 0.6;
pub const ROLL_SMOOTH: f32 = 0.35;
/// Bank-bump correlation time (s) and strength (rad per m/s of gust).
pub const ROLL_TIME: f32 = 0.8;
pub const ROLL_BUMP: f32 = 0.015;
pub const TURBULENCE_HEIGHT: f32 = 500.0;
/// Fixed simulation substeps per `step` call.
pub const SUBSTEPS: u32 = 2;
pub const MAX_STEP: f32 = 0.05;

// Touchdown limits: steeper, faster or more banked than this is a crash.
pub const MAX_SINK_RATE: f32 = 18.0;
/// Sink rate (m/s) above which a landing damages the hull.
pub const HARD_LANDING_SINK: f32 = 8.0;
pub const HARD_LANDING_DAMAGE: f32 = 7.0;
/// Minimum up-vector y (~40 deg of bank).
pub const MIN_LANDING_UP: f32 = 0.75;
/// Minimum forward-vector y (~20 deg nose down).
pub const MIN_LANDING_NOSE: f32 = -0.35;

// ---------------------------------------------------------------------------
// Airfield and world
// ---------------------------------------------------------------------------

/// Main runway 18/36 (OSM geometry). Takeoff on 36, heading ~000 true.
pub const RUNWAY_HEADING_DEG: f32 = -0.2;
pub const RUNWAY_CENTER: V3 = V3::new(-40.0, 0.0, 27.5);
pub const RUNWAY_LENGTH: f32 = 1415.0;
pub const RUNWAY_WIDTH: f32 = 30.0;
/// Distance from the runway threshold to the spawn point.
pub const RUNWAY_SPAWN_INSET: f32 = 60.0;
/// Horizontal radius beyond which the player is steered back toward base.
pub const WORLD_LIMIT: f32 = 14000.0;
/// Above this speed (m/s) hitting a building is fatal; below it the aircraft just scrapes.
pub const BUILDING_CRASH_SPEED: f32 = 40.0;

pub fn runway_dir() -> V3 {
    let h = RUNWAY_HEADING_DEG.to_radians();
    V3::new(h.sin(), 0.0, -h.cos())
}

// ---------------------------------------------------------------------------
// Weapons and scoring
// ---------------------------------------------------------------------------

pub const PLAYER_AMMO: f32 = 1200.0;
pub const PLAYER_BULLET_SPEED: f32 = 1100.0;
pub const BULLET_LIFE: f32 = 1.6;
pub const BULLET_DAMAGE: f32 = 9.0;
/// Half-angle (deg) of the cone in which cannon aim assist engages.
pub const GUN_ASSIST_CONE_DEG: f32 = 10.0;
pub const GUN_ASSIST_RANGE: f32 = 1600.0;

pub const MISSILE_INTERVAL: f32 = 0.6;
/// Maximum flight time; the missile self-destructs after it.
pub const MISSILE_LIFE: f32 = 20.0;
/// Rocket motor: burn time (s) and thrust (m/s^2). After burnout the missile coasts.
pub const MISSILE_BURN: f32 = 2.6;
pub const MISSILE_THRUST: f32 = 260.0;
/// Parasitic drag per unit density (m^-1): decel = k * density * v^2.
pub const MISSILE_DRAG: f32 = 5.5e-5;
/// Share of the lateral acceleration lost to induced drag.
pub const MISSILE_INDUCED_DRAG: f32 = 0.12;
/// Fin authority: MISSILE_MAX_G at MISSILE_FULL_G_SPEED (sea-level equivalent), less when slower.
pub const MISSILE_MAX_G: f32 = 30.0;
pub const MISSILE_FULL_G_SPEED: f32 = 600.0;
/// Proportional navigation constant.
pub const MISSILE_NAV_GAIN: f32 = 4.0;
/// Seeker gimbal limit (deg); a target further off the missile's nose is lost.
pub const MISSILE_GIMBAL_DEG: f32 = 60.0;
/// Below this speed (m/s) after burnout the missile can no longer guide and is spent.
pub const MISSILE_MIN_SPEED: f32 = 220.0;
pub const MISSILE_DAMAGE: f32 = 150.0;
/// Added to the target's radius for the proximity fuse.
pub const MISSILE_FUSE_RADIUS: f32 = 25.0;

// Countermeasures.
pub const FLARE_INTERVAL: f32 = 0.25;
pub const FLARE_LIFE: f32 = 3.0;
/// Chance range that one flare seduces a missile tracking the aircraft that dropped it.
pub const FLARE_CHANCE_MIN: f32 = 0.12;
pub const FLARE_CHANCE_MAX: f32 = 0.8;
/// A flare only works on missiles between these distances (m): too close and the seeker
/// already sees the aircraft and the flare as one.
pub const FLARE_RANGE: f32 = 5000.0;
pub const FLARE_MIN_RANGE: f32 = 350.0;

// Enemy missiles and radar warning.
/// Missiles per enemy fighter: none in the first wave, one more each wave up to the
/// maximum (one on easy).
pub const BOT_MISSILES: f32 = 2.0;
pub const BOT_MISSILES_EASY: f32 = 1.0;
pub const BOT_MISSILE_MIN_RANGE: f32 = 900.0;
pub const BOT_MISSILE_MAX_RANGE: f32 = 4000.0;
pub const BOT_LOCK_CONE_DEG: f32 = 15.0;
/// Seconds a bot needs to lock the player at skill 1.
pub const BOT_LOCK_TIME: f32 = 2.0;
/// Minimum gap (s) between two launches of the same bot.
pub const BOT_MISSILE_INTERVAL: f32 = 8.0;
/// Hull damage of an enemy missile hit at difficulty easy, medium, hard.
pub const BOT_MISSILE_DAMAGE: [f32; 3] = [45.0, 60.0, 75.0];

// Fuel and system damage.
/// Mass relative to the nominal (half-tank) mass: 1 + FUEL_MASS * (fuel - 0.5).
pub const FUEL_MASS: f32 = 0.2;
/// Fuel flow at idle as a share of the full-throttle flow.
pub const IDLE_FUEL_FLOW: f32 = 0.2;
/// Fuel the player starts (and is refuelled) with.
pub const START_FUEL: f32 = 1.0;
/// Per hull point of damage: chance and amount of engine / flight-control / fuel-tank damage.
pub const ENGINE_HIT_CHANCE: f32 = 0.25;
pub const CONTROL_HIT_CHANCE: f32 = 0.2;
pub const TANK_HIT_CHANCE: f32 = 0.15;
pub const SYSTEM_DAMAGE_PER_HP: f32 = 0.012;
/// Fuel leak (share of the tank per second) per hull point of tank damage.
pub const LEAK_PER_HP: f32 = 0.00012;
/// Roll response (1/s per rad/s of roll rate): how quickly the roll rate follows the stick.
pub const ROLL_RESPONSE: f32 = 3.0;
/// Seconds stopped on the airfield before the ground crew has rearmed, refuelled and repaired.
pub const REARM_TIME: f32 = 4.0;
/// Horizontal distance (m) from the runway centre within which the ground crew can reach.
pub const REARM_RADIUS: f32 = 1200.0;

/// Half-angle (deg) of the seeker cone and the seconds needed to lock.
pub const LOCK_CONE_DEG: f32 = 30.0;
pub const LOCK_RANGE: f32 = 5000.0;
pub const LOCK_TIME: f32 = 0.6;

pub const RESPAWN_TIME: f32 = 4.0;
pub const DEATH_PENALTY: f32 = 250.0;
pub const FIGHTER_SCORE: f32 = 100.0;
pub const B2_SCORE: f32 = 500.0;
pub const WAVE_SCORE_BONUS: f32 = 10.0;
/// Delay before the very first wave.
pub const FIRST_WAVE_DELAY: f32 = 3.0;

/// Hit radius (m) of a ground target (SAM site).
pub const GROUND_TARGET_RADIUS: f32 = 18.0;

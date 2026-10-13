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
    /// Wingspan (m): sets the depth of the ground effect cushion.
    pub span: f32,
    /// Structural / flight-control G limit.
    pub g_limit: f32,
    /// Angle of attack (rad) at maximum lift; the flight controls stop the nose here.
    pub alpha_max: f32,
    /// Engine spool rate (1/s): how fast thrust follows the throttle.
    pub spool: f32,
    /// Seconds a full tank lasts at full throttle.
    pub endurance: f32,
    pub flares: f32,
    /// Afterburning engine: thrust above AFTERBURNER_DETENT gains ram air with Mach, and
    /// fuel flow steps up.
    pub afterburner: bool,
    /// Cannon rounds carried (Simulator); 0 for an aircraft without a gun.
    pub rounds: f32,
    /// Carries air-to-air missiles (Simulator); the B-2 does not.
    pub air_to_air: bool,
    /// Moments of inertia about the body pitch, yaw and roll axes, relative to pitch. Their
    /// ratios set the gyroscopic (inertia) coupling between the axes.
    pub inertia: V3,
}

/// F-16 class: long fuselage, short wing (pitch 75674, yaw 85552, roll 12875 slug ft^2).
const INERTIA_FIGHTER: V3 = V3::new(1.0, 1.13, 0.17);
/// Flying wing: the span outweighs the length.
const INERTIA_FLYING_WING: V3 = V3::new(1.0, 2.5, 1.5);

/// 0 = F-16, 1 = F-22 Raptor, 2 = B-2 Spirit, 3 = KAAN.
/// `max_speed` is the sea-level top speed at full throttle; thinner air up high allows more.
pub const STATS: [Stats; 4] = [
    Stats { max_speed: 400.0, thrust: 11.0, pitch_rate: 1.0, roll_rate: 3.5, yaw_rate: 0.45, hp: 100.0, missiles: 6.0, gun_interval: 0.05, rotate_speed: 72.0, stall_speed: 55.0, radius: 9.0, span: 9.96, g_limit: 9.0, alpha_max: 0.44, spool: 1.0, endurance: 480.0, flares: 30.0, afterburner: true, rounds: 511.0, air_to_air: true, inertia: INERTIA_FIGHTER },
    Stats { max_speed: 450.0, thrust: 12.0, pitch_rate: 1.15, roll_rate: 3.3, yaw_rate: 0.55, hp: 120.0, missiles: 8.0, gun_interval: 0.05, rotate_speed: 75.0, stall_speed: 48.0, radius: 10.0, span: 13.6, g_limit: 9.0, alpha_max: 0.52, spool: 1.1, endurance: 540.0, flares: 30.0, afterburner: true, rounds: 480.0, air_to_air: true, inertia: INERTIA_FIGHTER },
    Stats { max_speed: 260.0, thrust: 4.0, pitch_rate: 0.5, roll_rate: 0.9, yaw_rate: 0.25, hp: 320.0, missiles: 16.0, gun_interval: 0.10, rotate_speed: 80.0, stall_speed: 60.0, radius: 22.0, span: 52.4, g_limit: 2.5, alpha_max: 0.30, spool: 0.6, endurance: 12000.0, flares: 60.0, afterburner: false, rounds: 0.0, air_to_air: false, inertia: INERTIA_FLYING_WING },
    Stats { max_speed: 430.0, thrust: 10.5, pitch_rate: 1.1, roll_rate: 3.3, yaw_rate: 0.50, hp: 115.0, missiles: 8.0, gun_interval: 0.05, rotate_speed: 74.0, stall_speed: 50.0, radius: 10.0, span: 14.0, g_limit: 9.0, alpha_max: 0.48, spool: 1.0, endurance: 540.0, flares: 30.0, afterburner: true, rounds: 450.0, air_to_air: true, inertia: INERTIA_FIGHTER },
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
    /// Hull damage per enemy cannon round.
    pub damage: f32,
    pub gun_range: f32,
    /// Cosine of the cone the player must be in before a bot opens fire.
    pub aim_cone: f32,
}

pub const DIFFICULTY: [Difficulty; 3] = [
    Difficulty { skill: 0.65, hp: 0.75, damage: 2.0, gun_range: 1000.0, aim_cone: 0.992 },
    Difficulty { skill: 1.0, hp: 1.0, damage: 3.5, gun_range: 1300.0, aim_cone: 0.985 },
    Difficulty { skill: 1.35, hp: 1.35, damage: 5.0, gun_range: 1600.0, aim_cone: 0.975 },
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
/// Below this many wingspans the ground boosts lift and cuts induced drag.
pub const GROUND_EFFECT_SPANS: f32 = 1.5;
/// Extra lift fraction right at the surface.
pub const GROUND_EFFECT_LIFT: f32 = 0.15;
pub const ROLLING_FRICTION: f32 = 0.6;
/// Wheel brakes with anti-skid on a dry runway, about 0.5 g (m/s^2).
pub const WHEEL_BRAKE: f32 = 5.0;
/// Landing gear oleo: spring (1/s^2) and damping (1/s) of the heave, about 2 Hz at 40% of
/// critical damping, travel (m) before the strut bottoms, and how far it extends (m) once
/// the wing carries the weight.
pub const GEAR_SPRING: f32 = 160.0;
pub const GEAR_DAMPING: f32 = 10.0;
pub const GEAR_TRAVEL: f32 = 0.35;
pub const GEAR_EXTEND: f32 = 0.15;
/// Pitch of the airframe on its struts: spring, damping and nose dip (rad) per m/s^2 of
/// braking (the nose squats up under thrust).
pub const GEAR_PITCH_SPRING: f32 = 120.0;
pub const GEAR_PITCH_DAMPING: f32 = 9.0;
pub const GEAR_PITCH_PER_ACCEL: f32 = 0.0015;
/// Distance (m) the origin sits ahead of the main wheels: rotating on them lifts the origin.
pub const MAIN_GEAR_ARM: f32 = 1.2;

// Aerodynamics (accelerations are per unit mass, so thrust/drag are in m/s^2).
/// Induced drag per unit lift at maximum lift coefficient.
pub const INDUCED_DRAG: f32 = 0.3;
/// Speed-proportional drag (trim, gear, intakes); keeps an idle aircraft slowing down.
pub const LINEAR_DRAG: f32 = 0.004;
/// Peak transonic drag rise on top of the subsonic drag (x1 = double drag).
pub const WAVE_DRAG: f32 = 1.5;
/// Side force (in G per radian of sideslip) at the stall speed.
pub const SIDE_FORCE: f32 = 0.3;
/// Flight control computer: how fast (1/s) it brings the AoA to the trim AoA and the
/// sideslip to the pedal command.
pub const PITCH_STABILITY: f32 = 3.0;
pub const YAW_STABILITY: f32 = 2.5;
/// Negative load factor the G limiter allows when pushing the nose down.
pub const NEG_G_LIMIT: f32 = 5.0;
/// Thrust ~ density^THRUST_LAPSE in the troposphere; above the tropopause (cold air no
/// longer helps) it falls faster than the density, which sets the service ceiling.
pub const THRUST_LAPSE: f32 = 0.7;
pub const TROPOPAUSE: f32 = 11000.0;
/// Thrust ~ (density / tropopause density)^STRATOSPHERE_LAPSE above the tropopause.
pub const STRATOSPHERE_LAPSE: f32 = 1.4;
/// Engine output above which the afterburner is lit.
pub const AFTERBURNER_DETENT: f32 = 0.8;
/// Afterburner thrust gain from ram air: x(1 + RAM_THRUST * Mach^2) at full afterburner.
pub const RAM_THRUST: f32 = 0.2;
/// Stall break. Too slow to hold 1 G with the wing near maximum lift, the aircraft is
/// stalled; STALL_RANGE is the shortfall in G (from 1) at which the stall is fully developed.
pub const STALL_RANGE: f32 = 0.3;
/// Lift share lost in a fully developed stall (the flow separates from the wing).
pub const STALL_LIFT_LOSS: f32 = 0.25;
/// Elevator effectiveness lost in a fully developed stall (the tail sits in the wake).
pub const STALL_PITCH_AUTHORITY: f32 = 0.6;
/// How far (share of alpha_max) a hard pull can drag the AoA past the limiter when slow.
pub const STALL_OVERSHOOT: f32 = 0.12;
/// Wing drop: roll rate (rad/s) and yaw rate (rad/s) a fully developed stall drives toward at
/// WING_DROP_BETA (rad) of sideslip. A coordinated stall (no slip) keeps the wings level.
pub const WING_DROP: f32 = 1.0;
pub const WING_DROP_YAW: f32 = 0.15;
pub const WING_DROP_BETA: f32 = 0.05;

// Rigid-body dynamics (aero.rs). Every aerodynamic moment is an angular acceleration
// (rad/s^2) at the dynamic pressure of the 1 G stall speed, per unit of the aircraft's
// rated rate on that axis, so a heavy bomber is slow on every axis. Moments grow with the
// dynamic pressure; the damping ones with density times airspeed.
/// Pitch: static stability per rad of AoA (relaxed, as on a fly-by-wire fighter), pitch
/// damping per rad/s of pitch rate, and full-elevator control power.
pub const PITCH_STIFFNESS: f32 = 1.0;
pub const PITCH_DAMPING: f32 = 1.2;
pub const ELEVATOR_POWER: f32 = 2.0;
/// Roll: full-aileron control power, roll damping, and the dihedral effect (roll away
/// from the sideslip) per rad of sideslip.
pub const ROLL_POWER: f32 = 1.6;
pub const ROLL_DAMPING: f32 = 1.0;
pub const DIHEDRAL: f32 = 0.5;
/// Yaw: weathercock stability per rad of sideslip, yaw damping and rudder power.
pub const YAW_STIFFNESS: f32 = 6.0;
pub const YAW_DAMPING: f32 = 1.0;
pub const RUDDER_POWER: f32 = 1.2;
/// Control surface actuators: full travel per second (about 60 deg/s on a 25 deg elevator).
pub const SURFACE_RATE: f32 = 5.0;
/// Nose-down moment of a fully developed stall (rad/s^2 at the stall dynamic pressure).
pub const STALL_PITCH_MOMENT: f32 = 0.5;
/// Aileron effectiveness lost in a fully developed stall (separated flow over the wing).
pub const STALL_AILERON_LOSS: f32 = 0.85;
/// Autorotation (1/s): how hard a stalled wing drives the roll toward the wing-drop and
/// spin rates while its own roll damping is gone.
pub const AUTOROTATION: f32 = 3.0;

// Flight control computer (dynamic inversion of the nominal airframe).
/// Bandwidth (1/s per rad/s of rated rate) the pitch and roll rates track the commands
/// with, and the yaw bandwidth (1/s).
pub const FCS_PITCH_GAIN: f32 = 2.5;
pub const FCS_YAW_GAIN: f32 = 4.0;
/// AoA limiter bandwidth (1/s): pitch rate allowed per rad of margin to the limit.
pub const FCS_ALPHA_LIMIT_GAIN: f32 = 6.0;
/// Sideslip (rad) full rudder pedal asks for at combat speed.
pub const PEDAL_BETA: f32 = 0.15;

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
/// Simulator: each simulated cannon shot stands for this many real rounds (6000 rpm M61).
pub const ROUNDS_PER_SHOT: f32 = 5.0;
/// M61 Vulcan 20 mm muzzle velocity (m/s).
pub const PLAYER_BULLET_SPEED: f32 = 1050.0;
/// Bullet drag per unit density (1/m): decel = k * density * v^2, so a 20 mm round falls
/// from ~1050 to ~700 m/s in its first second.
pub const BULLET_DRAG: f32 = 5e-4;
/// Gun dispersion: half-angle (rad) of the random cone each round leaves the muzzle in.
pub const GUN_DISPERSION: f32 = 0.004;
/// Bodies closer than this share of the summed collision radii collide.
pub const MIDAIR_RADIUS: f32 = 0.6;
pub const BULLET_LIFE: f32 = 1.6;
pub const BULLET_DAMAGE: f32 = 9.0;
/// Half-angle (deg) of the cone in which cannon aim assist engages.
pub const GUN_ASSIST_CONE_DEG: f32 = 10.0;
pub const GUN_ASSIST_RANGE: f32 = 1600.0;

pub const MISSILE_INTERVAL: f32 = 0.6;
/// Maximum flight time; the missile self-destructs after it.
pub const MISSILE_LIFE: f32 = 20.0;
/// Rocket motor: burn time (s) and thrust (m/s^2), about AIM-9X: ~750 m/s added over
/// five seconds. After burnout the missile coasts.
pub const MISSILE_BURN: f32 = 5.0;
pub const MISSILE_THRUST: f32 = 150.0;
/// Parasitic drag per unit density (m^-1): decel = k * density * v^2.
pub const MISSILE_DRAG: f32 = 5.5e-5;
/// Share of the lateral acceleration lost to induced drag.
pub const MISSILE_INDUCED_DRAG: f32 = 0.12;
/// Fin authority: MISSILE_MAX_G at MISSILE_FULL_G_SPEED (sea-level equivalent), less when slower.
pub const MISSILE_MAX_G: f32 = 40.0;
pub const MISSILE_FULL_G_SPEED: f32 = 600.0;
/// Proportional navigation constant.
pub const MISSILE_NAV_GAIN: f32 = 4.0;
/// Seeker gimbal limit (deg); a target further off the missile's nose is lost.
pub const MISSILE_GIMBAL_DEG: f32 = 90.0;
/// Below this speed (m/s) after burnout the missile can no longer guide and is spent.
pub const MISSILE_MIN_SPEED: f32 = 220.0;
pub const MISSILE_DAMAGE: f32 = 150.0;
/// Added to the target's radius for the proximity fuse. The warhead's damage falls with
/// the miss distance past the target's radius, down to MISSILE_EDGE_DAMAGE at the fuse edge.
pub const MISSILE_FUSE_RADIUS: f32 = 12.0;
pub const MISSILE_EDGE_DAMAGE: f32 = 0.3;

// Countermeasures.
pub const FLARE_INTERVAL: f32 = 0.25;
pub const FLARE_LIFE: f32 = 3.0;
/// Chance range that one flare seduces a missile tracking the aircraft that dropped it.
/// Modern imaging seekers reject most flares.
pub const FLARE_CHANCE_MIN: f32 = 0.05;
pub const FLARE_CHANCE_MAX: f32 = 0.4;
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
/// Fuel flow as a share of the full-throttle flow (`endurance` is seconds at full
/// throttle): at idle, and at full dry (military) power of an afterburning engine. Lighting
/// the afterburner multiplies the flow several times over.
pub const IDLE_FUEL_FLOW: f32 = 0.07;
pub const DRY_FUEL_FLOW: f32 = 0.27;
/// Idle flow of an engine without afterburner, as a share of its full-power flow.
pub const IDLE_FUEL_FLOW_DRY: f32 = 0.25;
/// Fuel the player starts (and is refuelled) with.
pub const START_FUEL: f32 = 1.0;
/// Per hull point of damage: chance and amount of engine / flight-control / fuel-tank damage.
pub const ENGINE_HIT_CHANCE: f32 = 0.25;
pub const CONTROL_HIT_CHANCE: f32 = 0.2;
pub const TANK_HIT_CHANCE: f32 = 0.15;
pub const SYSTEM_DAMAGE_PER_HP: f32 = 0.012;
/// Fuel leak (share of the tank per second) per hull point of tank damage.
pub const LEAK_PER_HP: f32 = 0.00012;
/// Roll bandwidth of the flight control computer (1/s per rad/s of rated roll rate): how
/// quickly the roll rate follows the stick.
/// About a 0.3 s roll mode on a fighter, over a second on a bomber.
pub const ROLL_RESPONSE: f32 = 0.95;
/// Share of the roll rate the flight controls take away at the maximum AoA: rolling while
/// pulling hard is much slower than a 1 G roll.
pub const ROLL_LOAD_REDUCTION: f32 = 0.6;
/// Above this equivalent airspeed (share of `max_speed`) the air loads on the control
/// surfaces stiffen them: pitch and roll authority fall off toward CONTROL_STIFF_AUTHORITY
/// at `max_speed`. Corner speed, not top speed, is where an aircraft turns and rolls best.
pub const CONTROL_STIFF_SPEED: f32 = 0.6;
pub const CONTROL_STIFF_AUTHORITY: f32 = 0.45;
/// Spin: the down-going wing of a stalled aircraft meets the air at a higher AoA, stalls
/// deeper and keeps the roll going (autorotation). SPIN_ROLL_RATE (rad/s) is the rate the
/// spin drives toward, SPIN_YAW the yaw rate it drags along. Unloading the wing (stick
/// forward) or opposite rudder stops it.
pub const SPIN_ROLL_RATE: f32 = 1.6;
pub const SPIN_YAW: f32 = 0.6;
/// Structural speed limit (equivalent airspeed, share of `max_speed`). Beyond it the
/// airframe takes OVERSPEED_DAMAGE hull points per second per m/s of excess.
pub const OVERSPEED_LIMIT: f32 = 1.08;
pub const OVERSPEED_DAMAGE: f32 = 0.6;
/// Seconds stopped in a hangar before the ground crew has rearmed, refuelled and repaired
/// (Arcade / Simulator).
pub const REARM_TIME: f32 = 4.0;
pub const SIM_REARM_TIME: f32 = 90.0;

// Simulator realism.
/// Touchdown limits: sink rate (m/s) that breaks the gear, sink rate that damages it,
/// minimum up-vector y (~20 deg of bank) and the touchdown speed (share of the stall
/// speed) the tyres survive.
pub const SIM_MAX_SINK_RATE: f32 = 6.0;
pub const SIM_HARD_LANDING_SINK: f32 = 3.0;
pub const SIM_MIN_LANDING_UP: f32 = 0.94;
pub const SIM_MAX_TOUCHDOWN: f32 = 2.0;
/// Seconds outside WORLD_LIMIT before the aircraft is lost (no magic turn back).
pub const SIM_OUT_OF_BOUNDS_TIME: f32 = 30.0;
/// Hull damage of an enemy missile hit: a warhead at the fuse is a kill.
pub const SIM_MISSILE_DAMAGE: f32 = 150.0;

/// A service hangar on the airfield: centre (x, z) and the heading of its open front
/// (rad about +y; 0 faces +z). Mirrored in `web/js/world.js` (HANGARS).
pub struct Hangar {
    pub x: f32,
    pub z: f32,
    pub heading: f32,
}

const HALF_PI: f32 = std::f32::consts::FRAC_PI_2;
pub const HANGARS: [Hangar; 5] = [
    Hangar { x: 110.0, z: -470.0, heading: -HALF_PI },
    Hangar { x: 110.0, z: 520.0, heading: -HALF_PI },
    Hangar { x: -180.0, z: -400.0, heading: HALF_PI },
    Hangar { x: -190.0, z: 0.0, heading: HALF_PI },
    Hangar { x: -180.0, z: 470.0, heading: HALF_PI },
];
/// Service bay of a hangar in its own frame (x across, z towards the open front), metres:
/// the floor between the side walls, from the back wall out over the front apron.
pub const HANGAR_BAY_HALF_WIDTH: f32 = 30.0;
pub const HANGAR_BAY_BACK: f32 = -44.0;
pub const HANGAR_BAY_FRONT: f32 = 46.0;

/// Whether (x, z) lies in the service bay of one of the hangars.
pub fn in_hangar(x: f32, z: f32) -> bool {
    HANGARS.iter().any(|h| {
        let (s, c) = h.heading.sin_cos();
        let (dx, dz) = (x - h.x, z - h.z);
        let lx = dx * c - dz * s;
        let lz = dx * s + dz * c;
        lx.abs() < HANGAR_BAY_HALF_WIDTH && (HANGAR_BAY_BACK..HANGAR_BAY_FRONT).contains(&lz)
    })
}

/// Half-angle (deg) of the seeker cone and the seconds needed to lock.
pub const LOCK_CONE_DEG: f32 = 30.0;
pub const LOCK_RANGE: f32 = 8000.0;
pub const LOCK_TIME: f32 = 0.6;

/// Long enough for the live crash view (2 s) plus the kill cam replay (replay.js).
pub const RESPAWN_TIME: f32 = 7.5;
pub const DEATH_PENALTY: f32 = 250.0;
pub const FIGHTER_SCORE: f32 = 100.0;
pub const B2_SCORE: f32 = 500.0;
pub const WAVE_SCORE_BONUS: f32 = 10.0;
/// Delay before the very first wave.
pub const FIRST_WAVE_DELAY: f32 = 3.0;

/// Hit radius (m) of a ground target (SAM site).
pub const GROUND_TARGET_RADIUS: f32 = 18.0;

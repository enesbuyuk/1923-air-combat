//! Output buffer layout shared with JS. Every field here is mirrored in `web/js/layout.js`;
//! change both together.

pub const MAX_BOTS: usize = 48;
pub const MAX_BULLETS: usize = 1024;
pub const MAX_MISSILES: usize = 24;
pub const MAX_EVENTS: usize = 64;
pub const MAX_FLARES: usize = 64;
pub const MAX_GROUND: usize = 12;

/// Player record (one).
pub mod player {
    pub const STRIDE: usize = 60;
    pub const POS: usize = 0; // x, y, z
    pub const QUAT: usize = 3; // x, y, z, w
    pub const SPEED: usize = 7;
    pub const THROTTLE: usize = 8;
    pub const HP: usize = 9;
    pub const MAX_HP: usize = 10;
    pub const ALIVE: usize = 11;
    pub const ON_GROUND: usize = 12;
    pub const AMMO: usize = 13;
    pub const MISSILES: usize = 14;
    pub const VERTICAL_SPEED: usize = 15;
    pub const G_LOAD: usize = 16;
    pub const TYPE: usize = 17;
    pub const STALL: usize = 18;
    pub const RESPAWN: usize = 19;
    pub const STALL_SPEED: usize = 20;
    pub const ROTATE_SPEED: usize = 21;
    pub const OUT_OF_BOUNDS: usize = 22;
    pub const MAX_SPEED: usize = 23;
    pub const ENGINE: usize = 24; // engine output 0..1 (THROTTLE is the lever)
    pub const ALPHA: usize = 25; // angle of attack, rad
    pub const BETA: usize = 26; // sideslip, rad
    pub const MACH: usize = 27;
    pub const WIND: usize = 28; // x, y, z air velocity at the aircraft
    pub const FUEL: usize = 31; // share of a full tank
    pub const FLARES: usize = 32;
    pub const MAX_FLARES: usize = 33;
    pub const ENGINE_HEALTH: usize = 34; // 0..1
    pub const CONTROL_HEALTH: usize = 35; // 0..1
    pub const FUEL_LEAK: usize = 36; // share of the tank per second
    pub const SERVICE: usize = 37; // ground crew progress 0..1 while parked
    pub const MAX_MISSILES: usize = 38;
    pub const VEL: usize = 39; // x, y, z
    pub const IN_HANGAR: usize = 42; // 1 in a hangar's service bay
    pub const OVERSPEED: usize = 43; // equivalent airspeed past the structural limit, m/s
    pub const GEAR: usize = 45;
    pub const GEAR_HEALTH: usize = 46;
    pub const FLAPS: usize = 47;
    pub const FLAP_HEALTH: usize = 48;
    pub const AGL: usize = 49;
    pub const SURFACE: usize = 50;
    pub const GEAR_COMMAND: usize = 51;
    pub const FLAP_COMMAND: usize = 52;
    pub const EAS: usize = 53;
    pub const GEAR_LIMIT: usize = 54;
    pub const FLAP_LIMIT: usize = 55;
    pub const LOST_IN: usize = 44; // Simulator: seconds left to return inside the area, -1 none
}

/// Bot records (MAX_BOTS).
pub mod bot {
    pub const STRIDE: usize = 24;
    pub const POS: usize = 0;
    pub const QUAT: usize = 3;
    pub const HP: usize = 7;
    pub const ALIVE: usize = 8;
    pub const TYPE: usize = 9;
    pub const SPEED: usize = 10;
    pub const FRIENDLY: usize = 11;
    pub const TACTIC: usize = 12; // entities::Tactic
    pub const MAX_HP: usize = 13;
    pub const ENGINE: usize = 14;
    pub const DETECTED: usize = 15;
    pub const CONTACT_POS: usize = 16;
    pub const GEAR: usize = 19;
    pub const FUEL: usize = 20;
    pub const AMMO: usize = 21;
    pub const FLAPS: usize = 22;
    pub const REMOTE: usize = 23; // 1 for another pilot in an online room
}

/// Pose of another pilot in an online room, written by JS before `set_remote`.
pub mod remote {
    pub const LEN: usize = 18;
    pub const TYPE: usize = 0;
    pub const POS: usize = 1; // x, y, z
    pub const QUAT: usize = 4; // x, y, z, w
    pub const VEL: usize = 8; // x, y, z
    pub const ENGINE: usize = 11;
    pub const GEAR: usize = 12;
    pub const FLAPS: usize = 13;
    pub const HP: usize = 14;
    pub const MAX_HP: usize = 15;
    pub const ALIVE: usize = 16;
    pub const GUN: usize = 17; // 1 while the trigger is held
}

/// Bullet records (MAX_BULLETS).
pub mod bullet {
    pub const STRIDE: usize = 10;
    pub const POS: usize = 0;
    pub const VEL: usize = 3;
    pub const LIFE: usize = 6;
    pub const ROUNDS: usize = 8;
    pub const OWNER: usize = 7; // 0 player, 1 bot, 2 remote pilot
}

/// Missile records (MAX_MISSILES).
pub mod missile {
    pub const STRIDE: usize = 12;
    pub const POS: usize = 0;
    pub const VEL: usize = 3;
    pub const LIFE: usize = 6;
    pub const TARGET: usize = 7; // Track::code: bot index, -1 none, -2 player, -3 flare, -(100 + i) ground target i
    pub const OWNER: usize = 8; // 0 player, 1 enemy, 2 remote pilot
    pub const RADAR: usize = 10;
    pub const BURN: usize = 9; // 1 while the motor burns
}

/// Flare records (MAX_FLARES).
pub mod flare {
    pub const STRIDE: usize = 4;
    pub const POS: usize = 0;
    pub const LIFE: usize = 3;
}

/// Ground target records (MAX_GROUND).
pub mod ground {
    pub const STRIDE: usize = 10;
    pub const POS: usize = 0;
    pub const HP: usize = 3;
    pub const ALIVE: usize = 4;
    pub const DETECTED: usize = 6;
    pub const CONTACT_POS: usize = 7;
    pub const LOCK: usize = 5; // its radar lock on the player, 0..1
}

/// Event records (count in `stats::EVENT_COUNT`); cleared on every step.
pub mod event {
    pub const STRIDE: usize = 5;
    pub const TYPE: usize = 0;
    pub const POS: usize = 1;
    pub const EXTRA: usize = 4;

    pub const BOT_DESTROYED: f32 = 1.0; // extra: aircraft type
    pub const BOT_HIT: f32 = 2.0; // extra: bot index
    pub const PLAYER_HIT: f32 = 3.0; // extra: damage
    pub const PLAYER_DOWN: f32 = 4.0;
    pub const MISSILE_LAUNCH: f32 = 5.0; // extra: target index or -1
    pub const WAVE: f32 = 6.0; // extra: wave number
    pub const LANDED: f32 = 7.0; // extra: hard-landing damage
    pub const GROUND_IMPACT: f32 = 8.0; // extra: 1 aircraft, 0 missile
    pub const ENEMY_MISSILE: f32 = 9.0; // extra: 1 when aimed at the player
    pub const REARMED: f32 = 10.0;
    pub const SYSTEM_DAMAGE: f32 = 11.0; // extra: 1 engine, 2 flight controls, 3 fuel tank
    pub const FLARE: f32 = 12.0; // the player dropped a flare
    pub const MISSION: f32 = 13.0; // extra: game::missions::mission code
    pub const GROUND_HIT: f32 = 14.0; // extra: ground target index
    pub const GROUND_DESTROYED: f32 = 15.0; // extra: ground target index
    pub const DECOYED: f32 = 16.0; // a missile chasing the player went for a flare
}

/// Global game counters.
pub mod stats {
    pub const LEN: usize = 24;
    pub const SCORE: usize = 0;
    pub const KILLS: usize = 1;
    pub const WAVE: usize = 2;
    pub const BOTS_ALIVE: usize = 3;
    pub const LOCK_TARGET: usize = 4;
    pub const LOCK_PROGRESS: usize = 5;
    pub const EVENT_COUNT: usize = 6;
    pub const WAVE_TIMER: usize = 7;
    pub const DEATHS: usize = 8;
    pub const TIME: usize = 9;
    pub const RWR_LOCK: usize = 10; // strongest enemy lock on the player, 0..1
    pub const MISSILE_WARN: usize = 11; // missiles tracking the player
    pub const MISSILE_DIST: usize = 12; // nearest of them, m
    pub const MISSILE_BEARING: usize = 13; // its bearing from the nose, rad (clockwise)
    pub const MODE: usize = 14;
    pub const STAGE: usize = 15;
    pub const OBJECTIVES_LEFT: usize = 16;
    pub const ESCORT_HP: usize = 17; // escorted bomber hull share, -1 when none
    pub const MISSION_TIMER: usize = 18;
}

/// Writes x, y, z at `at`.
pub fn put_v3(out: &mut [f32], at: usize, v: crate::math::V3) {
    out[at] = v.x;
    out[at + 1] = v.y;
    out[at + 2] = v.z;
}

/// Writes x, y, z, w at `at`.
pub fn put_quat(out: &mut [f32], at: usize, q: crate::math::Q) {
    out[at] = q.x;
    out[at + 1] = q.y;
    out[at + 2] = q.z;
    out[at + 3] = q.w;
}

pub fn flag(b: bool) -> f32 {
    if b { 1.0 } else { 0.0 }
}

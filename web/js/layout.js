// Output buffer layout of the WASM core. Mirrors wasm/src/layout.rs; change both together.

export const MAX_EVENTS = 64;

export const PLAYER = {
  STRIDE: 48,
  POS: 0, // x, y, z
  QUAT: 3, // x, y, z, w
  SPEED: 7,
  THROTTLE: 8,
  HP: 9,
  MAX_HP: 10,
  ALIVE: 11,
  ON_GROUND: 12,
  AMMO: 13,
  MISSILES: 14,
  VERTICAL_SPEED: 15,
  G_LOAD: 16,
  TYPE: 17,
  STALL: 18,
  RESPAWN: 19,
  STALL_SPEED: 20,
  ROTATE_SPEED: 21,
  OUT_OF_BOUNDS: 22,
  MAX_SPEED: 23,
  ENGINE: 24, // engine output 0..1 (THROTTLE is the lever)
  ALPHA: 25, // angle of attack, rad
  BETA: 26, // sideslip, rad
  MACH: 27,
  WIND: 28, // x, y, z air velocity at the aircraft
  FUEL: 31, // share of a full tank
  FLARES: 32,
  MAX_FLARES: 33,
  ENGINE_HEALTH: 34, // 0..1
  CONTROL_HEALTH: 35, // 0..1
  FUEL_LEAK: 36, // share of the tank per second
  SERVICE: 37, // ground crew progress 0..1 while parked
  MAX_MISSILES: 38,
  VEL: 39, // x, y, z
  IN_HANGAR: 42, // 1 in a hangar's service bay
  OVERSPEED: 43, // equivalent airspeed past the structural limit, m/s
  LOST_IN: 44, // Simulator: seconds left to return inside the area, -1 none
};

export const BOT = {
  STRIDE: 16, POS: 0, QUAT: 3, HP: 7, ALIVE: 8, TYPE: 9, SPEED: 10,
  FRIENDLY: 11, TACTIC: 12, MAX_HP: 13, ENGINE: 14,
};

/** Bot tactics (BOT.TACTIC), entities::Tactic in the core. */
export const TACTIC = { PATROL: 0, ATTACK: 1, BREAK: 2, EVADE: 3, RECOVER: 4, ESCORT: 5 };

export const BULLET = { STRIDE: 8, POS: 0, VEL: 3, LIFE: 6, OWNER: 7 };
export const OWNER_PLAYER = 0;

// TARGET: bot index, -1 none, -2 player, -3 flare, -(100 + i) ground target i.
export const MISSILE = { STRIDE: 10, POS: 0, VEL: 3, LIFE: 6, TARGET: 7, OWNER: 8, BURN: 9 };
export const MISSILE_AT_PLAYER = -2;

export const FLARE = { STRIDE: 4, POS: 0, LIFE: 3 };

export const GROUND = { STRIDE: 6, POS: 0, HP: 3, ALIVE: 4, LOCK: 5 };
/** Lock / missile target code of ground target `i`. */
export const groundCode = (i) => -(100 + i);

export const EVENT = {
  STRIDE: 5,
  TYPE: 0,
  POS: 1,
  EXTRA: 4,
  BOT_DESTROYED: 1, // extra: aircraft type
  BOT_HIT: 2, // extra: bot index
  PLAYER_HIT: 3, // extra: damage
  PLAYER_DOWN: 4,
  MISSILE_LAUNCH: 5, // extra: target code
  WAVE: 6, // extra: wave number
  LANDED: 7, // extra: hard-landing damage
  GROUND_IMPACT: 8, // extra: 1 aircraft, 0 missile
  ENEMY_MISSILE: 9, // extra: 1 when aimed at the player
  REARMED: 10,
  SYSTEM_DAMAGE: 11, // extra: 1 engine, 2 flight controls, 3 fuel tank
  FLARE: 12, // the player dropped a flare
  MISSION: 13, // extra: MISSION code
  GROUND_HIT: 14, // extra: ground target index
  GROUND_DESTROYED: 15, // extra: ground target index
  DECOYED: 16, // a missile chasing the player went for a flare
};

/** EVENT.MISSION codes. */
export const MISSION = {
  STRIKE_STARTED: 1,
  STRIKE_COMPLETE: 2,
  ESCORT_STARTED: 3,
  ESCORT_COMPLETE: 4,
  ESCORT_FAILED: 5,
};

/** Game modes (`set_mode`). */
export const MODE = { WAVES: 0, STRIKE: 1, ESCORT: 2, FREE: 3 };

export const STATS = {
  LEN: 24,
  SCORE: 0,
  KILLS: 1,
  WAVE: 2,
  BOTS_ALIVE: 3,
  LOCK_TARGET: 4,
  LOCK_PROGRESS: 5,
  EVENT_COUNT: 6,
  WAVE_TIMER: 7,
  DEATHS: 8,
  TIME: 9,
  RWR_LOCK: 10, // strongest enemy lock on the player, 0..1
  MISSILE_WARN: 11, // missiles tracking the player
  MISSILE_DIST: 12, // nearest of them, m
  MISSILE_BEARING: 13, // its bearing from the nose, rad (clockwise)
  MODE: 14,
  STAGE: 15,
  OBJECTIVES_LEFT: 16,
  ESCORT_HP: 17, // escorted bomber hull share, -1 when none
  MISSION_TIMER: 18,
};

/** Result codes of `building_hit`. */
export const BUILDING_HIT = { NONE: 0, SCRAPE: 1, CRASH: 2 };

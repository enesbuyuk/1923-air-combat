//! Simulation entities. Behaviour lives in `game/`; these are plain data plus helpers.

use std::ops::{Deref, DerefMut};

use crate::config::*;
use crate::math::{Q, V3, FORWARD, UP};

/// Flight state of one aircraft. The player and the bots share it and fly the same
/// aerodynamic model (`game/aero.rs`); bots only differ in who moves the stick.
#[derive(Clone, Copy)]
pub struct Airframe {
    pub ty: usize,
    pub pos: V3,
    pub q: Q,
    /// Airspeed in flight, ground speed while rolling on the runway.
    pub speed: f32,
    /// Velocity over the ground. In flight it is independent of the nose direction.
    pub vel: V3,
    pub throttle: f32,
    /// Engine output 0..1; lags behind the throttle as the engine spools.
    pub engine: f32,
    /// Angle of attack and sideslip (rad): where the airflow meets the nose.
    pub alpha: f32,
    pub beta: f32,
    pub mach: f32,
    /// Air density relative to sea level at the current height.
    pub density: f32,
    /// Turbulence bank offset already applied (see `Weather::roll`).
    pub bump: f32,
    /// Body angular velocity (rad/s): x pitch (nose up +), y yaw (nose left +), z roll
    /// (left wing down +). Integrated from the aerodynamic and gyroscopic moments.
    pub omega: V3,
    /// Control surface positions -1..1 (x elevator, y rudder, z ailerons), driven by the
    /// flight control computer at a limited actuator rate.
    pub surf: V3,
    pub gload: f32,
    pub stall: bool,
    /// Share of a full tank, 0..1. An empty tank flames the engine out.
    pub fuel: f32,
    /// System health 0..1: engine (thrust) and flight controls (pitch / roll authority).
    pub engine_health: f32,
    pub control_health: f32,
    /// Share of the tank lost per second through a damaged tank.
    pub fuel_leak: f32,
    /// Physical configuration; commands and positions differ during actuator travel.
    pub gear_position: f32,
    pub gear_down: bool,
    pub gear_health: f32,
    pub flaps: f32,
    pub flap_command: f32,
    pub flap_health: f32,
    pub ground_height: f32,
    /// Flight controls switch to takeoff and landing gains low and slow (the player's).
    pub low_gains: bool,
}

impl Airframe {
    pub fn new(ty: usize, pos: V3, q: Q, vel: V3) -> Airframe {
        Airframe {
            ty,
            pos,
            q,
            speed: vel.len(),
            vel,
            throttle: 0.0,
            engine: 0.0,
            alpha: 0.0,
            beta: 0.0,
            mach: 0.0,
            density: 1.0,
            bump: 0.0,
            omega: V3::new(0.0, 0.0, 0.0),
            surf: V3::new(0.0, 0.0, 0.0),
            gload: 1.0,
            stall: false,
            fuel: START_FUEL,
            engine_health: 1.0,
            control_health: 1.0,
            fuel_leak: 0.0,
            gear_position: 0.0,
            gear_down: false,
            gear_health: 1.0,
            flaps: 0.0,
            flap_command: 0.0,
            flap_health: 1.0,
            ground_height: 0.0,
            low_gains: true,
        }
    }
    pub fn stats(&self) -> Stats {
        STATS[self.ty]
    }
    pub fn fwd(&self) -> V3 {
        self.q.rotate(FORWARD)
    }
    pub fn velocity(&self) -> V3 {
        self.vel
    }
    /// Mass relative to the nominal half-tank mass.
    pub fn mass(&self) -> f32 {
        1.0 + FUEL_MASS * (self.fuel - 0.5)
    }
    /// Equivalent airspeed past the structural limit (m/s), 0 within it.
    pub fn overspeed(&self) -> f32 {
        (self.speed * self.density.sqrt() - self.stats().max_speed * OVERSPEED_LIMIT).max(0.0)
    }
    /// Restore fuel and systems (ground crew).
    pub fn service(&mut self) {
        self.fuel = START_FUEL;
        self.engine_health = 1.0;
        self.control_health = 1.0;
        self.fuel_leak = 0.0;
        self.gear_health = 1.0;
        self.flap_health = 1.0;
    }
}

pub struct Player {
    pub af: Airframe,
    pub hp: f32,
    pub alive: bool,
    pub on_ground: bool,
    /// Flat ground heading while rolling on the runway.
    pub heading: V3,
    /// Nose-up pitch (radians) while on the ground: rotation before liftoff, de-rotation after touchdown.
    pub rot: f32,
    /// Landing gear struts while on the ground: heave (m, + extended) and pitch (rad,
    /// + nose up) of the airframe on its oleos, with their rates.
    pub gear: f32,
    pub gear_vel: f32,
    pub gear_pitch: f32,
    pub gear_pitch_vel: f32,
    /// Attitude the airframe touched down with, relative to the one its struts give it;
    /// eases out to identity on the ground roll.
    pub settle: Q,
    pub ammo: f32,
    pub missiles: f32,
    pub flares: f32,
    pub gun_cd: f32,
    pub missile_cd: f32,
    pub flare_cd: f32,
    pub respawn: f32,
    /// Seconds stopped on the airfield; the ground crew services the aircraft at REARM_TIME.
    pub parked: f32,
    /// Full weapon load for this aircraft type.
    pub max_ammo: f32,
    pub max_missiles: f32,
    /// Seconds outside the mission area.
    pub outside: f32,
}

impl Deref for Player {
    type Target = Airframe;
    fn deref(&self) -> &Airframe {
        &self.af
    }
}

impl DerefMut for Player {
    fn deref_mut(&mut self) -> &mut Airframe {
        &mut self.af
    }
}

impl Player {
    /// A fresh aircraft parked at the start of runway 36.
    pub fn on_runway(ty: usize) -> Player {
        let s = STATS[ty];
        let dir = runway_dir();
        let start = RUNWAY_CENTER.add(dir.mul(-(RUNWAY_LENGTH * 0.5 - RUNWAY_SPAWN_INSET)));
        let pos = V3::new(start.x, GEAR_HEIGHT, start.z);
        let mut p = Player {
            af: Airframe::new(ty, pos, Q::look(dir, UP), V3::default()),
            hp: s.hp,
            alive: true,
            on_ground: true,
            heading: dir,
            rot: 0.0,
            gear: 0.0,
            gear_vel: 0.0,
            gear_pitch: 0.0,
            gear_pitch_vel: 0.0,
            settle: Q::IDENTITY,
            ammo: s.rounds,
            missiles: s.missiles,
            flares: s.flares,
            gun_cd: 0.0,
            missile_cd: 0.0,
            flare_cd: 0.0,
            respawn: 0.0,
            parked: 0.0,
            max_ammo: s.rounds,
            max_missiles: s.missiles,
            outside: 0.0,
        };
        p.af.low_gains = true;
        p.af.gear_position = 1.0;
        p.af.gear_down = true;
        p
    }
    pub fn airborne(&self) -> bool {
        self.alive && !self.on_ground
    }
    /// Anything for the ground crew to do: weapons, fuel, hull or systems below full.
    pub fn needs_service(&self) -> bool {
        let s = self.stats();
        self.ammo < self.max_ammo
            || self.missiles < self.max_missiles
            || self.flares < s.flares
            || self.hp < s.hp
            || self.fuel < START_FUEL - 0.02
            || self.engine_health < 1.0
            || self.control_health < 1.0
            || self.fuel_leak > 0.0
            || self.gear_health < 1.0
            || self.flap_health < 1.0
    }
    /// Ground crew: full weapons, fuel and systems; hull repaired.
    pub fn rearm(&mut self) {
        let s = self.stats();
        self.ammo = self.max_ammo;
        self.missiles = self.max_missiles;
        self.flares = s.flares;
        self.hp = s.hp;
        self.af.service();
    }
}

/// What a bot is doing; drives its steering and throttle.
#[derive(Clone, Copy, PartialEq, Default)]
pub enum Tactic {
    #[default]
    Patrol = 0,
    Attack = 1,
    /// Hard turn into an attacker sitting on its tail.
    Break = 2,
    /// Beaming an incoming missile and dropping flares.
    Evade = 3,
    /// Too low or too slow: wings level, climb or unload.
    Recover = 4,
    /// Friendly bomber following its route.
    Escort = 5,
    Return = 6,
}

#[derive(Clone, Copy)]
pub struct Bot {
    pub af: Airframe,
    pub alive: bool,
    /// Friendly aircraft (escort mission): flies its route, is hunted by the enemy.
    pub friendly: bool,
    pub hp: f32,
    pub max_hp: f32,
    pub ammo: f32,
    /// Return-to-base approach stage; completion retires the landed aircraft.
    pub return_stage: u8,
    pub landing: bool,
    pub sensor_clock: f32,
    pub sensed_track: Track,
    pub sensed_pos: V3,
    pub sensed_vel: V3,
    pub sensed_valid: bool,
    pub approach_integral: f32,
    pub fire_cd: f32,
    pub missile_cd: f32,
    pub missiles: f32,
    pub flares: f32,
    pub flare_cd: f32,
    /// Seeker lock on the bot's quarry, 0..1, and whether that quarry is the player (radar warning).
    pub lock: f32,
    pub locking_player: bool,
    pub waypoint: V3,
    /// Running clock driving the evasive weave.
    pub jink: f32,
    pub tactic: Tactic,
    /// Turn direction (+1 right, -1 left) chosen when a break or evasion starts.
    pub break_side: f32,
}

impl Deref for Bot {
    type Target = Airframe;
    fn deref(&self) -> &Airframe {
        &self.af
    }
}

impl DerefMut for Bot {
    fn deref_mut(&mut self) -> &mut Airframe {
        &mut self.af
    }
}

impl Bot {
    pub const DEAD: Bot = Bot {
        af: Airframe {
            ty: 0,
            pos: V3::new(0.0, 0.0, 0.0),
            q: Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 },
            speed: 0.0,
            vel: V3::new(0.0, 0.0, 0.0),
            throttle: 0.0,
            engine: 0.0,
            alpha: 0.0,
            beta: 0.0,
            mach: 0.0,
            density: 1.0,
            bump: 0.0,
            omega: V3::new(0.0, 0.0, 0.0),
            surf: V3::new(0.0, 0.0, 0.0),
            gload: 1.0,
            stall: false,
            fuel: 0.5,
            engine_health: 1.0,
            control_health: 1.0,
            fuel_leak: 0.0,
            gear_position: 0.0,
            gear_down: false,
            gear_health: 1.0,
            flaps: 0.0,
            flap_command: 0.0,
            flap_health: 1.0,
            ground_height: 0.0,
            low_gains: false,
        },
        alive: false,
        friendly: false,
        hp: 0.0,
        max_hp: 1.0,
        ammo: 0.0,
        return_stage: 0,
        landing: false,
        sensor_clock: 0.0,
        sensed_track: Track::None,
        sensed_pos: V3::new(0.0, 0.0, 0.0),
        sensed_vel: V3::new(0.0, 0.0, 0.0),
        sensed_valid: false,
        approach_integral: 0.0,
        fire_cd: 0.0,
        missile_cd: 0.0,
        missiles: 0.0,
        flares: 0.0,
        flare_cd: 0.0,
        lock: 0.0,
        locking_player: false,
        waypoint: V3::new(0.0, 0.0, 0.0),
        jink: 0.0,
        tactic: Tactic::Patrol,
        break_side: 1.0,
    };

    /// A bot in level flight at `pos` heading `fwd` (flat) at `speed`.
    pub fn spawn(ty: usize, pos: V3, fwd: V3, speed: f32, hp: f32) -> Bot {
        let mut af = Airframe::new(ty, pos, Q::look(fwd, UP), fwd.mul(speed));
        af.throttle = 0.8;
        af.engine = 0.8;
        let s = STATS[ty];
        Bot {
            af,
            alive: true,
            hp,
            max_hp: hp,
            ammo: s.rounds,
            missiles: s.missiles,
            flares: s.flares,
            waypoint: pos,
            ..Bot::DEAD
        }
    }

    pub fn is_b2(&self) -> bool {
        self.ty == B2
    }
    pub fn orientation(&self) -> Q {
        self.q
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Owner {
    Player = 0,
    Bot = 1,
}

#[derive(Clone, Copy)]
pub struct Bullet {
    pub pos: V3,
    pub vel: V3,
    /// Seconds left; <= 0 marks a free slot.
    pub life: f32,
    pub owner: Owner,
    pub rounds: f32,
}

impl Bullet {
    pub const NONE: Bullet = Bullet { pos: V3::new(0.0, 0.0, 0.0), vel: V3::new(0.0, 0.0, 0.0), life: 0.0, owner: Owner::Player, rounds: 0.0 };
}

/// What a missile seeker is tracking.
#[derive(Clone, Copy, PartialEq, Default)]
pub enum Track {
    #[default]
    None,
    Bot(usize),
    Player,
    Flare(usize),
    Ground(usize),
}

impl Track {
    /// Encoding in the output buffer: bot / ground index, or a negative code.
    pub fn code(self) -> f32 {
        match self {
            Track::None => -1.0,
            Track::Bot(i) => i as f32,
            Track::Player => -2.0,
            Track::Flare(_) => -3.0,
            Track::Ground(i) => -(100.0 + i as f32),
        }
    }
}

#[derive(Clone, Copy)]
pub struct Missile {
    pub pos: V3,
    pub vel: V3,
    /// Seconds left; <= 0 marks a free slot.
    pub life: f32,
    /// Motor burn time left (s).
    pub burn: f32,
    pub track: Track,
    pub owner: Owner,
    /// Radar-guided SAM; air-to-air weapons have passive infrared seekers.
    pub radar: bool,
}

impl Missile {
    pub const NONE: Missile =
        Missile { pos: V3::new(0.0, 0.0, 0.0), vel: V3::new(0.0, 0.0, 0.0), life: 0.0, burn: 0.0, track: Track::None, owner: Owner::Player, radar: false };
}

/// Infrared decoy: falls behind the aircraft and burns out.
#[derive(Clone, Copy, Default)]
pub struct Flare {
    pub pos: V3,
    pub vel: V3,
    pub life: f32,
}

/// Ground target of the strike mission (SAM site).
#[derive(Clone, Copy)]
pub struct GroundTarget {
    pub alive: bool,
    pub pos: V3,
    pub hp: f32,
    pub missile_cd: f32,
    pub lock: f32,
}

impl GroundTarget {
    pub const NONE: GroundTarget = GroundTarget { alive: false, pos: V3::new(0.0, 0.0, 0.0), hp: 0.0, missile_cd: 0.0, lock: 0.0 };
}

#[derive(Default, Clone, Copy)]
pub struct Input {
    pub pitch: f32,
    pub roll: f32,
    pub yaw: f32,
    pub throttle: f32,
    pub gun: bool,
    pub missile: bool,
    pub brake: bool,
    pub flare: bool,
}

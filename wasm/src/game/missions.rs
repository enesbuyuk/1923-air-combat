//! Game modes on top of the enemy waves.
//!
//! - Waves: endless enemy waves (the original game).
//! - Strike: destroy every SAM site of the stage; each site locks and fires missiles at
//!   an aircraft above its radar horizon. Fly low to stay hidden.
//! - Escort: a friendly B-2 flies a circuit around the base; enemy fighters go for it.

use std::f32::consts::PI;

use super::Game;
use crate::config::*;
use crate::entities::*;
use crate::layout::{event, MAX_BOTS, MAX_GROUND};
use crate::math::{V3, UP};

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Waves = 0,
    Strike = 1,
    Escort = 2,
}

impl Mode {
    pub fn from_index(i: i32) -> Mode {
        match i {
            1 => Mode::Strike,
            2 => Mode::Escort,
            _ => Mode::Waves,
        }
    }
}

/// `event::MISSION` codes (event extra).
pub mod mission {
    pub const STRIKE_STARTED: f32 = 1.0;
    pub const STRIKE_COMPLETE: f32 = 2.0;
    pub const ESCORT_STARTED: f32 = 3.0;
    pub const ESCORT_COMPLETE: f32 = 4.0;
    pub const ESCORT_FAILED: f32 = 5.0;
}

const SAM_RANGE: f32 = 7000.0;
/// Below this height above the ground the SAM radar cannot see the aircraft.
const SAM_RADAR_FLOOR: f32 = 120.0;
const SAM_LOCK_TIME: f32 = 3.0;
const SAM_INTERVAL: f32 = 12.0;
const SAM_HP: f32 = 120.0;
const STRIKE_BONUS: f32 = 1000.0;
const ESCORT_BONUS: f32 = 1500.0;
const ESCORT_RADIUS: f32 = 6000.0;
const ESCORT_ALTITUDE: f32 = 1500.0;
const ESCORT_LEGS: u32 = 8;
/// Seconds before the next objective after one ends.
const NEXT_OBJECTIVE_DELAY: f32 = 6.0;

impl Game {
    /// Share of the normal wave size; missions bring their own threats.
    pub(super) fn mode_wave_scale(&self) -> f32 {
        match self.mode {
            Mode::Waves => 1.0,
            Mode::Strike => 0.4,
            Mode::Escort => 0.6,
        }
    }

    /// Where enemy waves gather: the escorted bomber when there is one, else the player.
    pub(super) fn wave_center(&self) -> V3 {
        self.escort_index().map_or(self.player.pos, |i| self.bots[i].pos)
    }

    pub(super) fn escort_index(&self) -> Option<usize> {
        self.bots.iter().position(|b| b.alive && b.friendly)
    }

    pub(super) fn objectives_left(&self) -> usize {
        match self.mode {
            Mode::Strike => self.ground.iter().filter(|g| g.alive).count(),
            Mode::Escort => (ESCORT_LEGS.saturating_sub(self.escort_leg)) as usize,
            Mode::Waves => 0,
        }
    }

    pub(super) fn update_mission(&mut self, dt: f32) {
        match self.mode {
            Mode::Waves => {}
            Mode::Strike => self.update_strike(dt),
            Mode::Escort => self.update_escort(dt),
        }
    }

    // ------------------------------------------------------------------ strike

    fn update_strike(&mut self, dt: f32) {
        if self.ground.iter().all(|g| !g.alive) {
            self.mission_timer -= dt;
            if self.mission_timer <= 0.0 {
                self.start_strike_stage();
            }
            return;
        }
        let p = &self.player;
        let visible = p.airborne() && p.pos.y > SAM_RADAR_FLOOR;
        let (ppos, skill) = (p.pos, self.difficulty().skill);
        for gi in 0..MAX_GROUND {
            let g = self.ground[gi];
            if !g.alive {
                continue;
            }
            let mut g = g;
            g.missile_cd -= dt;
            let dist = ppos.sub(g.pos).len();
            if visible && dist < SAM_RANGE {
                g.lock = (g.lock + dt * skill / SAM_LOCK_TIME).min(1.0);
            } else {
                g.lock = (g.lock - dt).max(0.0);
            }
            if g.lock >= 1.0 && g.missile_cd <= 0.0 {
                let pos = g.pos.add(UP.mul(6.0));
                let dir = ppos.sub(pos).norm();
                if self.launch_missile(pos, UP.mul(60.0).add(dir.mul(60.0)), Track::Player, Owner::Bot) {
                    g.missile_cd = SAM_INTERVAL / skill;
                    g.lock = 0.5;
                    self.event(event::ENEMY_MISSILE, pos, 1.0);
                }
            }
            self.ground[gi] = g;
        }
    }

    pub(super) fn start_strike_stage(&mut self) {
        self.stage += 1;
        let count = (2 + self.stage as usize).min(MAX_GROUND);
        // Spread the sites over a sector so they form one target area.
        let bearing = self.rng.range(0.0, 2.0 * PI);
        let center_dist = self.rng.range(6000.0, 9000.0);
        let center = RUNWAY_CENTER.add(V3::new(bearing.cos(), 0.0, bearing.sin()).mul(center_dist));
        for i in 0..MAX_GROUND {
            self.ground[i] = if i < count {
                let a = self.rng.range(0.0, 2.0 * PI);
                let r = self.rng.range(300.0, 2200.0);
                let pos = V3::new(center.x + a.cos() * r, 3.0, center.z + a.sin() * r);
                let cd = self.rng.range(2.0, SAM_INTERVAL);
                GroundTarget { alive: true, pos, hp: SAM_HP, missile_cd: cd, lock: 0.0 }
            } else {
                GroundTarget::NONE
            };
        }
        self.event(event::MISSION, center, mission::STRIKE_STARTED);
    }

    pub(super) fn damage_ground(&mut self, i: usize, dmg: f32, at: V3) {
        let g = &mut self.ground[i];
        if !g.alive {
            return;
        }
        g.hp -= dmg;
        if g.hp > 0.0 {
            self.event(event::GROUND_HIT, at, i as f32);
            return;
        }
        g.alive = false;
        let pos = g.pos;
        self.score += FIGHTER_SCORE * 2.0;
        self.event(event::GROUND_DESTROYED, pos, i as f32);
        if self.lock == Track::Ground(i) {
            self.reset_lock();
        }
        if self.ground.iter().all(|g| !g.alive) {
            self.score += STRIKE_BONUS * self.stage as f32;
            self.mission_timer = NEXT_OBJECTIVE_DELAY;
            self.event(event::MISSION, pos, mission::STRIKE_COMPLETE);
        }
    }

    // ------------------------------------------------------------------ escort

    fn escort_waypoint(leg: u32) -> V3 {
        let a = leg as f32 * (2.0 * PI / 4.0) + PI * 0.25;
        RUNWAY_CENTER.add(V3::new(a.cos() * ESCORT_RADIUS, ESCORT_ALTITUDE, a.sin() * ESCORT_RADIUS))
    }

    fn update_escort(&mut self, dt: f32) {
        let Some(i) = self.escort_index() else {
            self.mission_timer -= dt;
            if self.mission_timer <= 0.0 {
                self.start_escort();
            }
            return;
        };
        let b = &mut self.bots[i];
        if b.pos.sub(b.waypoint).flat().len() < 700.0 {
            self.escort_leg += 1;
            if self.escort_leg >= ESCORT_LEGS {
                // Route flown: the bomber lands (leaves the game) and the next one comes.
                b.alive = false;
                let pos = b.pos;
                self.score += ESCORT_BONUS;
                self.mission_timer = NEXT_OBJECTIVE_DELAY;
                self.event(event::MISSION, pos, mission::ESCORT_COMPLETE);
                return;
            }
            b.waypoint = Self::escort_waypoint(self.escort_leg);
        }
    }

    pub(super) fn start_escort(&mut self) {
        let Some(slot) = (0..MAX_BOTS).find(|&j| !self.bots[j].alive) else {
            return;
        };
        self.stage += 1;
        self.escort_leg = 0;
        let start = Self::escort_waypoint(ESCORT_LEGS - 1);
        let first = Self::escort_waypoint(0);
        let mut b = Bot::spawn(B2, start, first.sub(start).flat().norm(), 170.0, 320.0);
        b.friendly = true;
        b.waypoint = first;
        b.missiles = 0.0;
        self.bots[slot] = b;
        self.event(event::MISSION, start, mission::ESCORT_STARTED);
    }

    /// The escorted bomber went down.
    pub(super) fn escort_lost(&mut self, at: V3) {
        self.mission_timer = NEXT_OBJECTIVE_DELAY + 4.0;
        self.event(event::MISSION, at, mission::ESCORT_FAILED);
    }

    /// Starts the selected mode's first objective (called on a new game and mode change).
    pub(super) fn start_mode(&mut self, mode: Mode) {
        self.mode = mode;
        self.stage = 0;
        self.escort_leg = 0;
        self.mission_timer = 0.0;
        self.ground = [GroundTarget::NONE; MAX_GROUND];
        for b in self.bots.iter_mut().filter(|b| b.friendly) {
            b.alive = false;
        }
        match mode {
            Mode::Waves => {}
            Mode::Strike => self.start_strike_stage(),
            Mode::Escort => self.start_escort(),
        }
    }
}

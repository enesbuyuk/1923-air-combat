//! Radar scans and visual acquisition are separate from the authoritative scene state.
use super::Game;
use crate::entities::Airframe;
use crate::math::V3;
use crate::layout::{MAX_BOTS, MAX_GROUND};

pub const SCAN_INTERVAL: f32 = 0.25;
const MEMORY: f32 = 1.5;
#[derive(Clone, Copy, Default)]
pub struct Contact { pub pos: V3, pub ttl: f32, pub confirmed: bool }

impl Game {
    /// Identical radar/visual geometry for human and AI observers. Visual acquisition
    /// is all-round but short range; the radar scans a forward 120-degree cone.
    pub(super) fn detectable(&self, observer: &Airframe, target: V3, ground: bool) -> bool {
        let d = target.sub(observer.pos);
        let distance = d.len();
        let visual = distance < if ground { 3500.0 } else { 3000.0 };
        let radar = distance < if ground { 8000.0 } else { 12000.0 } && observer.fwd().dot(d.norm()) > 0.5;
        (visual || radar) && self.environment.clear_line(observer.pos, target)
    }

    pub(super) fn update_sensors(&mut self, dt: f32) {
        for c in &mut self.contacts { c.ttl = (c.ttl - dt).max(0.0); }
        self.sensor_timer -= dt;
        if self.sensor_timer > 0.0 { return; }
        self.sensor_timer = SCAN_INTERVAL;
        for i in 0..MAX_BOTS + MAX_GROUND {
            let (alive, pos) = if i < MAX_BOTS {
                (self.bots[i].alive, self.bots[i].pos)
            } else {
                let g = self.ground[i - MAX_BOTS]; (g.alive, g.pos)
            };
            let seen = alive && self.player.alive && self.detectable(&self.player.af, pos, i >= MAX_BOTS);
            let c = &mut self.contacts[i];
            c.confirmed = seen;
            if seen { c.pos = pos; c.ttl = MEMORY; }
            if !alive { c.ttl = 0.0; }
        }
    }
}

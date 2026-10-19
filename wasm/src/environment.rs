//! One environment for physics, sensors and rendering. Heights are representative,
//! deterministic terrain, not a surveyed Istanbul DEM. The airfield stays level.
use std::collections::HashMap;
use crate::math::{clamp, V3};

#[derive(Clone, Copy, PartialEq, Debug)]
#[repr(u8)]
pub enum Surface { Paved = 0, Soil = 1, Water = 2 }

fn smooth(x: f32) -> f32 { let t = clamp(x, 0.0, 1.0); t * t * (3.0 - 2.0 * t) }

fn runway(x: f32, z: f32, a: (f32, f32), b: (f32, f32), width: f32) -> bool {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dz);
    let along = ((x - a.0) * dx + (z - a.1) * dz) / len;
    let across = ((x - a.0) * dz - (z - a.1) * dx).abs() / len;
    along >= -5.0 && along <= len + 5.0 && across < width * 0.5
}

pub fn surface(x: f32, z: f32) -> Surface {
    if runway(x, z, (-38.0, -680.0), (-42.0, 735.0), 30.0)
        || runway(x, z, (-306.0, 297.0), (223.0, -236.0), 25.0)
        // Taxiways and service aprons, including the hangar mouths.
        || ((-290.0..170.0).contains(&x) && (-590.0..640.0).contains(&z)) {
        return Surface::Paved;
    }
    let coast = 9000.0 + 0.4 * x + 180.0 * (x / 1800.0).sin();
    if z > coast || z < -32000.0 { Surface::Water } else { Surface::Soil }
}

pub fn height(x: f32, z: f32) -> f32 {
    if surface(x, z) == Surface::Water { return 0.0; }
    // Flat airport and approach corridors, with a smooth transition to the hills.
    let airport = smooth(((x.abs() - 550.0).max((z.abs() - 950.0) * 0.4)) / 1000.0);
    let approach = 1.0 - (1.0 - smooth(((x + 40.0).abs() - 300.0) / 350.0))
        * (1.0 - smooth((z.abs() - 3200.0) / 1000.0));
    let coast = 9000.0 + 0.4 * x + 180.0 * (x / 1800.0).sin();
    let shore = smooth((coast - z) / 700.0);
    let hills = 65.0 + 40.0 * (x / 1700.0).sin() * (z / 2100.0).cos()
        + 90.0 * (-(x - 5500.0).powi(2) / 8e6 - (z + 4000.0).powi(2) / 12e6).exp();
    (hills * airport * approach * shore).max(0.0)
}

pub struct Obstacle {
    pub points: Vec<(f32, f32)>,
    pub bottom: f32,
    pub top: f32,
    bounds: [f32; 4],
}

impl Obstacle {
    fn inside(&self, x: f32, z: f32) -> bool {
        let mut inside = false;
        for i in 0..self.points.len() {
            let (ax, az) = self.points[i];
            let (bx, bz) = self.points[(i + 1) % self.points.len()];
            if (az > z) != (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax { inside = !inside; }
        }
        inside
    }
    fn blocks(&self, a: V3, b: V3) -> bool {
        if a.y.min(b.y) > self.top || a.y.max(b.y) < self.bottom { return false; }
        if a.x.min(b.x) > self.bounds[1] || a.x.max(b.x) < self.bounds[0]
            || a.z.min(b.z) > self.bounds[3] || a.z.max(b.z) < self.bounds[2] { return false; }
        let d = b.sub(a);
        for p in [a, b] { if p.y >= self.bottom && p.y <= self.top && self.inside(p.x, p.z) { return true; } }
        if d.y.abs() > 1e-5 {
            for y in [self.bottom, self.top] {
                let t = (y - a.y) / d.y;
                if (0.0..=1.0).contains(&t) && self.inside(a.x + t * d.x, a.z + t * d.z) { return true; }
            }
        }
        for i in 0..self.points.len() {
            let (x, z) = self.points[i];
            let (bx, bz) = self.points[(i + 1) % self.points.len()];
            let (ex, ez) = (bx - x, bz - z);
            let det = d.x * ez - d.z * ex;
            if det.abs() < 1e-6 { continue; }
            let t = ((x - a.x) * ez - (z - a.z) * ex) / det;
            let u = ((x - a.x) * d.z - (z - a.z) * d.x) / det;
            let y = a.y + t * d.y;
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) && y >= self.bottom && y <= self.top { return true; }
        }
        false
    }
}

#[derive(Default)]
struct Cell { top: f32, ids: Vec<usize> }
#[derive(Default)]
pub struct Obstacles { items: Vec<Obstacle>, cells: HashMap<(i32, i32), Cell>, top: f32 }
const CELL: f32 = 200.0;

impl Obstacles {
    pub fn clear(&mut self) { self.items.clear(); self.cells.clear(); self.top = 0.0; }
    pub fn add(&mut self, points: Vec<(f32, f32)>, bottom: f32, top: f32) {
        if points.len() < 3 || !bottom.is_finite() || !top.is_finite() || top <= bottom
            || points.iter().any(|p| !p.0.is_finite() || !p.1.is_finite()) { return; }
        let mut bounds = [f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY];
        for &(x, z) in &points { bounds[0] = bounds[0].min(x); bounds[1] = bounds[1].max(x); bounds[2] = bounds[2].min(z); bounds[3] = bounds[3].max(z); }
        // Reject pathological imports rather than allocating an unbounded grid.
        if bounds[1] - bounds[0] > 10000.0 || bounds[3] - bounds[2] > 10000.0 { return; }
        let id = self.items.len();
        self.top = self.top.max(top);
        for x in (bounds[0] / CELL).floor() as i32..=(bounds[1] / CELL).floor() as i32 {
            for z in (bounds[2] / CELL).floor() as i32..=(bounds[3] / CELL).floor() as i32 {
                let cell = self.cells.entry((x, z)).or_default();
                cell.top = cell.top.max(top);
                cell.ids.push(id);
            }
        }
        self.items.push(Obstacle { points, bottom, top, bounds });
    }
    fn clear_line(&self, a: V3, b: V3) -> bool {
        if self.items.is_empty() || a.y.min(b.y) > self.top { return true; }
        let d = b.sub(a);
        // Half-cell steps include neighbouring cells at grid corners; each polygon is
        // intersected analytically, so a thin wall between samples is still solid.
        let n = (d.x.abs().max(d.z.abs()) / (CELL * 0.5)).ceil().max(1.0) as usize;
        for i in 0..=n {
            let p = a.add(d.mul(i as f32 / n as f32));
            let (cx, cz) = ((p.x / CELL).floor() as i32, (p.z / CELL).floor() as i32);
            for x in cx - 1..=cx + 1 { for z in cz - 1..=cz + 1 {
                if let Some(cell) = self.cells.get(&(x, z)) {
                    if a.y.min(b.y) > cell.top { continue; }
                    if cell.ids.iter().any(|&j| self.items[j].blocks(a, b)) { return false; }
                }
            } }
        }
        true
    }
    pub fn contact(&self, p: V3, r: f32, below: f32) -> Option<(f32, f32, f32)> {
        if self.items.is_empty() || p.y - below > self.top { return None; }
        for cx in ((p.x - r) / CELL).floor() as i32..=((p.x + r) / CELL).floor() as i32 {
            for cz in ((p.z - r) / CELL).floor() as i32..=((p.z + r) / CELL).floor() as i32 {
                let Some(cell) = self.cells.get(&(cx, cz)) else { continue; };
                if p.y - below > cell.top { continue; }
                for &id in &cell.ids {
                    let o = &self.items[id];
                    if p.y - below > o.top || p.y + r < o.bottom || p.x + r < o.bounds[0] || p.x - r > o.bounds[1] || p.z + r < o.bounds[2] || p.z - r > o.bounds[3] { continue; }
                    let mut best = f32::INFINITY;
                    let mut nearest = (0.0, 0.0);
                    for i in 0..o.points.len() {
                        let (x, z) = o.points[i]; let (bx, bz) = o.points[(i + 1) % o.points.len()];
                        let (dx, dz) = (bx - x, bz - z);
                        let t = clamp(((p.x - x) * dx + (p.z - z) * dz) / (dx * dx + dz * dz).max(1e-6), 0.0, 1.0);
                        let q = (x + dx * t, z + dz * t);
                        let dist = (p.x - q.0).hypot(p.z - q.1);
                        if dist < best { best = dist; nearest = q; }
                    }
                    let inside = o.inside(p.x, p.z);
                    if inside || best < r {
                        let sign = if inside { 1.0 } else { -1.0 };
                        let nx = if best > 1e-4 { sign * (nearest.0 - p.x) / best } else { 1.0 };
                        let nz = if best > 1e-4 { sign * (nearest.1 - p.z) / best } else { 0.0 };
                        return Some((nx, nz, if inside { best + r } else { r - best }));
                    }
                }
            }
        }
        None
    }
}

#[derive(Default)]
pub struct Environment {
    pub static_obstacles: Obstacles,
    pub dynamic_obstacles: Obstacles,
    /// Flat test range for isolated aerodynamic checks; production always uses terrain.
    #[cfg(test)] pub flat: bool,
}
impl Environment {
    pub fn height(&self, x: f32, z: f32) -> f32 {
        #[cfg(test)] if self.flat { return 0.0; }
        height(x, z)
    }
    pub fn surface(&self, x: f32, z: f32) -> Surface {
        #[cfg(test)] if self.flat { return Surface::Paved; }
        surface(x, z)
    }
    pub fn agl(&self, p: V3) -> f32 { p.y - self.height(p.x, p.z) }
    pub fn clear_line(&self, a: V3, b: V3) -> bool {
        let d = b.sub(a);
        // Never use this for unlimited-distance queries.
        let n = (d.len() / 60.0).ceil().clamp(1.0, 2000.0) as usize;
        for i in 1..n {
            let p = a.add(d.mul(i as f32 / n as f32));
            if p.y < self.height(p.x, p.z) + 0.2 { return false; }
        }
        self.static_obstacles.clear_line(a, b) && self.dynamic_obstacles.clear_line(a, b)
    }
    pub fn contact(&self, p: V3, r: f32, below: f32) -> Option<(f32, f32, f32)> {
        self.static_obstacles.contact(p, r, below).or_else(|| self.dynamic_obstacles.contact(p, r, below))
    }
}

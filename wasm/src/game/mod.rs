//! Game state and the per-step update order. Subsystems extend `Game` in sibling files.

mod aero;
mod air;
mod bots;
mod flight;
pub mod missions;
mod projectiles;
#[cfg(test)]
mod tests;

use crate::config::*;
use crate::entities::*;
use crate::layout::{self, *};
use crate::math::{clamp, Rng, V3};
use air::Weather;
pub use missions::Mode;

pub struct Game {
    pub(crate) rng: Rng,
    pub input: Input,
    pub(crate) player: Player,
    pub(crate) bots: [Bot; MAX_BOTS],
    pub(crate) bullets: [Bullet; MAX_BULLETS],
    pub(crate) missiles: [Missile; MAX_MISSILES],
    pub(crate) flares: [Flare; MAX_FLARES],
    pub(crate) ground: [GroundTarget; MAX_GROUND],
    pub(crate) weather: Weather,
    score: f32,
    kills: f32,
    deaths: f32,
    wave: u32,
    wave_timer: f32,
    /// Enemy density multiplier from the settings: scales wave size and shortens the gap between waves.
    pub density: f32,
    pub difficulty: usize,
    pub(crate) mode: Mode,
    /// Mission stage (strike target areas cleared / escorts started).
    stage: u32,
    escort_leg: u32,
    /// Countdown to the next mission objective.
    mission_timer: f32,
    lock: Track,
    lock_progress: f32,
    time: f32,
    events: Vec<f32>,
    pub out_player: [f32; player::STRIDE],
    pub out_bots: [f32; MAX_BOTS * bot::STRIDE],
    pub out_bullets: [f32; MAX_BULLETS * bullet::STRIDE],
    pub out_missiles: [f32; MAX_MISSILES * missile::STRIDE],
    pub out_flares: [f32; MAX_FLARES * flare::STRIDE],
    pub out_ground: [f32; MAX_GROUND * ground::STRIDE],
    pub out_events: [f32; MAX_EVENTS * event::STRIDE],
    pub out_stats: [f32; stats::LEN],
}

impl Game {
    pub fn new(ty: usize, seed: u32) -> Game {
        let mut rng = Rng(seed.max(1));
        let weather = Weather::new(&mut rng);
        Game {
            rng,
            input: Input::default(),
            player: Player::on_runway(ty),
            bots: [Bot::DEAD; MAX_BOTS],
            bullets: [Bullet::NONE; MAX_BULLETS],
            missiles: [Missile::NONE; MAX_MISSILES],
            flares: [Flare::default(); MAX_FLARES],
            ground: [GroundTarget::NONE; MAX_GROUND],
            weather,
            score: 0.0,
            kills: 0.0,
            deaths: 0.0,
            wave: 0,
            wave_timer: FIRST_WAVE_DELAY,
            density: 1.0,
            difficulty: DEFAULT_DIFFICULTY,
            mode: Mode::Waves,
            stage: 0,
            escort_leg: 0,
            mission_timer: 0.0,
            lock: Track::None,
            lock_progress: 0.0,
            time: 0.0,
            events: Vec::with_capacity(MAX_EVENTS * event::STRIDE),
            out_player: [0.0; player::STRIDE],
            out_bots: [0.0; MAX_BOTS * bot::STRIDE],
            out_bullets: [0.0; MAX_BULLETS * bullet::STRIDE],
            out_missiles: [0.0; MAX_MISSILES * missile::STRIDE],
            out_flares: [0.0; MAX_FLARES * flare::STRIDE],
            out_ground: [0.0; MAX_GROUND * ground::STRIDE],
            out_events: [0.0; MAX_EVENTS * event::STRIDE],
            out_stats: [0.0; stats::LEN],
        }
    }

    fn difficulty(&self) -> Difficulty {
        DIFFICULTY[self.difficulty]
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.start_mode(mode);
    }

    /// Queues an event for JS; silently dropped once the buffer is full.
    fn event(&mut self, ty: f32, p: V3, extra: f32) {
        if self.events.len() < MAX_EVENTS * event::STRIDE {
            let mut rec = [0.0; event::STRIDE];
            rec[event::TYPE] = ty;
            layout::put_v3(&mut rec, event::POS, p);
            rec[event::EXTRA] = extra;
            self.events.extend_from_slice(&rec);
        }
    }

    /// Live enemy aircraft (the escorted bomber does not count).
    fn bots_alive(&self) -> usize {
        self.bots.iter().filter(|b| b.alive && !b.friendly).count()
    }

    fn reset_lock(&mut self) {
        self.lock = Track::None;
        self.lock_progress = 0.0;
    }

    // ------------------------------------------------------------------ step

    /// Advances the game by `dt` (normally the fixed step the JS loop uses), in
    /// SUBSTEPS equal substeps.
    pub fn step(&mut self, dt: f32) {
        self.events.clear();
        let dt = clamp(dt, 0.0, MAX_STEP);
        let h = dt / SUBSTEPS as f32;
        for _ in 0..SUBSTEPS {
            self.time += h;
            self.update_weather(h);
            self.update_player(h);
            self.update_bots(h);
            self.update_bullets(h);
            self.update_missiles(h);
            self.update_flares(h);
            self.update_mission(h);
        }
        self.update_wave_timer(dt);
        self.write_out();
    }

    fn update_wave_timer(&mut self, dt: f32) {
        if self.bots_alive() > 0 {
            return;
        }
        self.wave_timer -= dt;
        if self.wave_timer <= 0.0 {
            self.spawn_wave();
            self.wave_timer = clamp(5.0 / self.density, 2.0, 10.0) / self.mode_wave_scale();
        }
    }

    // ------------------------------------------------------------------ damage

    fn kill_player(&mut self, at: V3) {
        let p = &mut self.player;
        if !p.alive {
            return;
        }
        p.alive = false;
        p.hp = 0.0;
        p.speed = 0.0;
        p.vel = V3::default();
        p.respawn = RESPAWN_TIME;
        self.deaths += 1.0;
        self.score = (self.score - DEATH_PENALTY).max(0.0);
        self.event(event::PLAYER_DOWN, at, 0.0);
    }

    /// Hull damage; a combat hit (`systems`) may also knock out the engine, the flight
    /// controls or hole the fuel tank.
    fn damage_player(&mut self, dmg: f32, at: V3, systems: bool) {
        if !self.player.alive {
            return;
        }
        self.player.hp -= dmg;
        self.event(event::PLAYER_HIT, at, dmg);
        if systems {
            self.damage_systems(dmg, at);
        }
        if self.player.hp <= 0.0 {
            self.kill_player(at);
        }
    }

    fn damage_systems(&mut self, dmg: f32, at: V3) {
        // Bigger hits are more likely to reach a system.
        let scale = (dmg / 10.0).min(3.0);
        let roll = self.rng.next();
        let amount = dmg * SYSTEM_DAMAGE_PER_HP * self.rng.range(0.6, 1.4);
        let af = &mut self.player.af;
        let system = if roll < ENGINE_HIT_CHANCE * scale {
            af.engine_health = (af.engine_health - amount).max(0.0);
            1.0
        } else if roll < (ENGINE_HIT_CHANCE + CONTROL_HIT_CHANCE) * scale {
            af.control_health = (af.control_health - amount).max(0.0);
            2.0
        } else if roll < (ENGINE_HIT_CHANCE + CONTROL_HIT_CHANCE + TANK_HIT_CHANCE) * scale {
            af.fuel_leak += dmg * LEAK_PER_HP;
            3.0
        } else {
            return;
        };
        self.event(event::SYSTEM_DAMAGE, at, system);
    }

    fn damage_bot(&mut self, i: usize, dmg: f32, at: V3) {
        let b = &mut self.bots[i];
        if !b.alive {
            return;
        }
        b.hp -= dmg;
        // A shot-up engine gives less thrust.
        b.af.engine_health = clamp(0.4 + 0.6 * b.hp / b.max_hp, 0.0, 1.0);
        if b.hp > 0.0 {
            self.event(event::BOT_HIT, at, i as f32);
            return;
        }
        let pos = b.pos;
        self.destroy_bot(i, pos, true);
    }

    /// Removes a bot; `credit` awards the kill to the player (shot down or forced into the ground).
    fn destroy_bot(&mut self, i: usize, at: V3, credit: bool) {
        let b = &mut self.bots[i];
        if !b.alive {
            return;
        }
        b.alive = false;
        let (is_b2, ty, friendly) = (b.is_b2(), b.ty as f32, b.friendly);
        self.event(event::BOT_DESTROYED, at, ty);
        if self.lock == Track::Bot(i) {
            self.reset_lock();
        }
        if friendly {
            self.escort_lost(at);
            return;
        }
        if credit {
            self.kills += 1.0;
            self.score += (if is_b2 { B2_SCORE } else { FIGHTER_SCORE }) + self.wave as f32 * WAVE_SCORE_BONUS;
        }
    }

    /// The JS side owns the building geometry and reports when the player is inside one:
    /// `at` is the contact point, (nx, nz) the way out and `depth` how far to move.
    /// Returns 0 when nothing happened, 1 for a scrape, 2 for a fatal crash.
    pub fn building_hit(&mut self, at: V3, nx: f32, nz: f32, depth: f32) -> i32 {
        const NONE: i32 = 0;
        const SCRAPE: i32 = 1;
        const CRASH: i32 = 2;
        if !self.player.alive {
            return NONE;
        }
        let speed = self.player.speed;
        self.player.pos = at;
        if speed > BUILDING_CRASH_SPEED {
            self.kill_player(at);
            return CRASH;
        }
        let p = &mut self.player;
        p.pos = at.add(V3::new(nx, 0.0, nz).mul(depth + 0.5));
        p.speed = 0.0;
        p.vel = V3::default();
        self.damage_player(5.0 + speed * 0.8, at, false);
        if self.player.alive { SCRAPE } else { CRASH }
    }

    // ------------------------------------------------------------------ output

    /// Copies the state into the flat buffers JS reads.
    pub fn write_out(&mut self) {
        self.write_player();
        self.write_bots();
        self.write_projectiles();
        let n = self.events.len().min(MAX_EVENTS * event::STRIDE);
        self.out_events[..n].copy_from_slice(&self.events[..n]);

        let alive = self.bots_alive();
        let objectives = self.objectives_left();
        let escort_hp = self.escort_index().map_or(-1.0, |i| self.bots[i].hp / self.bots[i].max_hp);
        let (rwr, warn, dist, bearing) = self.threats();
        let st = &mut self.out_stats;
        st[stats::SCORE] = self.score;
        st[stats::KILLS] = self.kills;
        st[stats::WAVE] = self.wave as f32;
        st[stats::BOTS_ALIVE] = alive as f32;
        st[stats::LOCK_TARGET] = self.lock.code();
        st[stats::LOCK_PROGRESS] = self.lock_progress;
        st[stats::EVENT_COUNT] = (n / event::STRIDE) as f32;
        st[stats::WAVE_TIMER] = self.wave_timer;
        st[stats::DEATHS] = self.deaths;
        st[stats::TIME] = self.time;
        st[stats::RWR_LOCK] = rwr;
        st[stats::MISSILE_WARN] = warn;
        st[stats::MISSILE_DIST] = dist;
        st[stats::MISSILE_BEARING] = bearing;
        st[stats::MODE] = self.mode as u8 as f32;
        st[stats::STAGE] = self.stage as f32;
        st[stats::OBJECTIVES_LEFT] = objectives as f32;
        st[stats::ESCORT_HP] = escort_hp;
        st[stats::MISSION_TIMER] = self.mission_timer.max(0.0);
    }

    /// Radar warning: strongest enemy lock on the player, and the missiles tracking it
    /// (count, nearest distance, bearing from the nose, clockwise).
    fn threats(&self) -> (f32, f32, f32, f32) {
        let p = &self.player;
        let bot_lock = self.bots.iter().filter(|b| b.alive && b.locking_player).map(|b| b.lock);
        let sam_lock = self.ground.iter().filter(|g| g.alive).map(|g| g.lock);
        let rwr = bot_lock.chain(sam_lock).fold(0.0, f32::max);
        let mut count = 0.0;
        let mut nearest: Option<V3> = None;
        for m in self.missiles.iter().filter(|m| m.life > 0.0 && m.track == Track::Player) {
            count += 1.0;
            if nearest.is_none_or(|n| m.pos.sub(p.pos).len() < n.sub(p.pos).len()) {
                nearest = Some(m.pos);
            }
        }
        let Some(m) = nearest else {
            return (rwr, 0.0, 0.0, 0.0);
        };
        let d = m.sub(p.pos);
        let fwd = p.fwd().flat().norm();
        let right = fwd.cross(crate::math::UP);
        let flat = d.flat();
        let bearing = flat.dot(right).atan2(flat.dot(fwd));
        (rwr, count, d.len(), bearing)
    }

    fn write_player(&mut self) {
        let p = &self.player;
        let s = p.stats();
        let o = &mut self.out_player;
        layout::put_v3(o, player::POS, p.pos);
        layout::put_quat(o, player::QUAT, p.q);
        o[player::SPEED] = p.speed;
        o[player::THROTTLE] = p.throttle;
        o[player::ENGINE] = p.engine;
        o[player::ALPHA] = p.alpha;
        o[player::BETA] = p.beta;
        o[player::MACH] = p.mach;
        layout::put_v3(o, player::WIND, self.weather.air_at(p.pos.y));
        o[player::HP] = p.hp.max(0.0);
        o[player::MAX_HP] = s.hp;
        o[player::ALIVE] = flag(p.alive);
        o[player::ON_GROUND] = flag(p.on_ground);
        o[player::AMMO] = p.ammo;
        o[player::MISSILES] = p.missiles;
        o[player::VERTICAL_SPEED] = p.velocity().y;
        o[player::G_LOAD] = p.gload;
        o[player::TYPE] = p.ty as f32;
        o[player::STALL] = flag(p.stall);
        o[player::RESPAWN] = p.respawn.max(0.0);
        // True airspeed at which 1 G can no longer be held at this height and weight.
        o[player::STALL_SPEED] = s.stall_speed * p.mass().sqrt() / p.density.sqrt();
        o[player::ROTATE_SPEED] = s.rotate_speed;
        o[player::OUT_OF_BOUNDS] = flag(p.pos.flat().len() > WORLD_LIMIT * 0.9);
        o[player::MAX_SPEED] = s.max_speed;
        o[player::FUEL] = p.fuel;
        o[player::FLARES] = p.flares;
        o[player::MAX_FLARES] = s.flares;
        o[player::ENGINE_HEALTH] = p.engine_health;
        o[player::CONTROL_HEALTH] = p.control_health;
        o[player::FUEL_LEAK] = p.fuel_leak;
        o[player::SERVICE] = if p.on_ground && p.parked > 0.0 { (p.parked / REARM_TIME).min(1.0) } else { 0.0 };
        o[player::MAX_MISSILES] = s.missiles;
        layout::put_v3(o, player::VEL, p.vel);
    }

    fn write_bots(&mut self) {
        for (b, o) in self.bots.iter().zip(self.out_bots.chunks_exact_mut(bot::STRIDE)) {
            o[bot::ALIVE] = flag(b.alive);
            if !b.alive {
                continue;
            }
            layout::put_v3(o, bot::POS, b.pos);
            layout::put_quat(o, bot::QUAT, b.orientation());
            o[bot::HP] = b.hp;
            o[bot::TYPE] = b.ty as f32;
            o[bot::SPEED] = b.speed;
            o[bot::FRIENDLY] = flag(b.friendly);
            o[bot::TACTIC] = b.tactic as u8 as f32;
            o[bot::MAX_HP] = b.max_hp;
            o[bot::ENGINE] = b.engine;
        }
    }

    fn write_projectiles(&mut self) {
        for (b, o) in self.bullets.iter().zip(self.out_bullets.chunks_exact_mut(bullet::STRIDE)) {
            layout::put_v3(o, bullet::POS, b.pos);
            layout::put_v3(o, bullet::VEL, b.vel);
            o[bullet::LIFE] = b.life;
            o[bullet::OWNER] = b.owner as u8 as f32;
        }
        for (m, o) in self.missiles.iter().zip(self.out_missiles.chunks_exact_mut(missile::STRIDE)) {
            layout::put_v3(o, missile::POS, m.pos);
            layout::put_v3(o, missile::VEL, m.vel);
            o[missile::LIFE] = m.life;
            o[missile::TARGET] = m.track.code();
            o[missile::OWNER] = m.owner as u8 as f32;
            o[missile::BURN] = flag(m.burn > 0.0);
        }
        for (f, o) in self.flares.iter().zip(self.out_flares.chunks_exact_mut(flare::STRIDE)) {
            layout::put_v3(o, flare::POS, f.pos);
            o[flare::LIFE] = f.life;
        }
        for (g, o) in self.ground.iter().zip(self.out_ground.chunks_exact_mut(ground::STRIDE)) {
            layout::put_v3(o, ground::POS, g.pos);
            o[ground::HP] = g.hp;
            o[ground::ALIVE] = flag(g.alive);
            o[ground::LOCK] = g.lock;
        }
    }
}

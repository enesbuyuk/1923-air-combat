//! Headless flight-model checks: takeoff, top speed, turns, stall and landing.

use super::{Game, Mode};
use crate::config::*;
use crate::entities::{Bot, Input, Owner, Tactic, Track};
use crate::layout::MAX_GROUND;
use crate::math::{Q, V3, UP};

const F16: usize = 0;
const DT: f32 = 1.0 / 60.0;

fn run(g: &mut Game, seconds: f32, input: Input) {
    g.input = input;
    for _ in 0..(seconds / DT) as usize {
        g.step(DT);
    }
}

/// Calm air so the numbers are reproducible.
fn calm(ty: usize) -> Game {
    let mut g = Game::new(ty, 7);
    g.weather.wind = V3::default();
    g.wave_timer = 1e9;
    g
}

/// Level flight heading north at `speed`, height `h`, engine already at `throttle`.
fn airborne(ty: usize, h: f32, speed: f32, throttle: f32) -> Game {
    let mut g = calm(ty);
    let p = &mut g.player;
    p.on_ground = false;
    // South of the base, flying north: plenty of room before the world limit.
    p.pos = V3::new(0.0, h, 13000.0);
    p.q = Q::look(V3::new(0.0, 0.0, -1.0), UP);
    p.vel = V3::new(0.0, 0.0, -speed);
    p.speed = speed;
    p.throttle = throttle;
    p.engine = throttle;
    g
}

fn throttle(t: f32) -> Input {
    Input { throttle: t, ..Input::default() }
}

#[test]
fn takes_off_within_the_runway_and_climbs() {
    let mut g = calm(F16);
    let start = g.player.pos;
    let mut t = 0.0;
    while g.player.on_ground && t < 60.0 {
        let rotate = g.player.speed > STATS[F16].rotate_speed;
        run(&mut g, DT, Input { throttle: 1.0, pitch: if rotate { 1.0 } else { 0.0 }, ..Input::default() });
        t += DT;
    }
    let roll = g.player.pos.sub(start).flat().len();
    assert!(!g.player.on_ground, "never lifted off");
    assert!(roll < RUNWAY_LENGTH - RUNWAY_SPAWN_INSET, "ground roll {roll} m");
    run(&mut g, 4.0, Input { throttle: 1.0, pitch: 0.3, ..Input::default() });
    run(&mut g, 6.0, throttle(1.0));
    assert!(g.player.alive);
    assert!(g.player.pos.y > 60.0, "height after takeoff {}", g.player.pos.y);
}

#[test]
fn engine_spools_up_with_a_lag() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.0);
    run(&mut g, 1.0, throttle(1.0));
    let e1 = g.player.engine;
    run(&mut g, 5.0, throttle(1.0));
    assert!(e1 < 0.6, "engine after 1 s: {e1}");
    assert!(g.player.engine > 0.9, "engine after 6 s: {}", g.player.engine);
}

#[test]
fn top_speed_is_near_the_rated_value_and_higher_aloft() {
    let mut low = airborne(F16, 300.0, 300.0, 1.0);
    let mut high = airborne(F16, 8000.0, 300.0, 1.0);
    run(&mut low, 60.0, throttle(1.0));
    run(&mut high, 60.0, throttle(1.0));
    let vmax = STATS[F16].max_speed;
    assert!((low.player.speed - vmax).abs() < 25.0, "sea-level top speed {}", low.player.speed);
    assert!(high.player.speed > low.player.speed, "8 km {} vs low {}", high.player.speed, low.player.speed);
    assert!(high.player.mach > 1.0);
}

#[test]
fn hands_off_flight_holds_its_path() {
    let mut g = airborne(F16, 2000.0, 220.0, 0.6);
    run(&mut g, 20.0, throttle(0.6));
    let p = &g.player;
    assert!((p.pos.y - 2000.0).abs() < 150.0, "height drift {}", p.pos.y - 2000.0);
    assert!(p.vel.norm().dot(p.fwd()) > 0.99, "nose far from the flight path");
}

#[test]
fn hard_turn_respects_the_g_limit_and_bleeds_speed() {
    let mut g = airborne(F16, 3000.0, 250.0, 1.0);
    // Specific energy (m^2/s^2): a max-G pull must cost energy even in full afterburner.
    let energy = |g: &Game| 0.5 * g.player.speed * g.player.speed + GRAVITY * g.player.pos.y;
    let e0 = energy(&g);
    // Roll to ~80 degrees, then pull.
    while g.player.q.rotate(crate::math::RIGHT).y > -0.98 {
        run(&mut g, DT, Input { throttle: 1.0, roll: 1.0, ..Input::default() });
    }
    let mut peak: f32 = 0.0;
    for _ in 0..(8.0 / DT) as usize {
        run(&mut g, DT, Input { throttle: 1.0, pitch: 1.0, ..Input::default() });
        peak = peak.max(g.player.gload);
    }
    let lim = STATS[F16].g_limit;
    assert!(peak > lim * 0.8, "peak G {peak}");
    assert!(peak < lim + 1.0, "peak G {peak} over limit");
    let lost = 1.0 - energy(&g) / e0;
    assert!(lost > 0.05, "no energy bleed: {:.1}%", lost * 100.0);
}

#[test]
fn slow_flight_stalls_and_the_nose_drops() {
    let mut g = airborne(F16, 3000.0, 120.0, 0.0);
    let mut stalled = false;
    for _ in 0..(20.0 / DT) as usize {
        run(&mut g, DT, Input { pitch: 1.0, ..Input::default() });
        stalled |= g.player.stall;
    }
    assert!(stalled, "never stalled");
    assert!(g.player.vel.y < -5.0, "not descending: {}", g.player.vel.y);
    assert!(g.player.alpha <= STATS[F16].alpha_max * 1.1, "AoA {}", g.player.alpha);
}

#[test]
fn shallow_approach_lands_safely() {
    // 3 degree glide at ~85 m/s from 60 m, near idle (no gear or flap drag is modelled).
    let mut g = airborne(F16, 60.0, 85.0, 0.05);
    let path = V3::new(0.0, -0.052, -1.0).norm();
    g.player.vel = path.mul(85.0);
    g.player.q = Q::look(V3::new(0.0, 0.1, -1.0).norm(), UP);
    let mut t = 0.0;
    while !g.player.on_ground && g.player.alive && t < 60.0 {
        // Flare in the last few metres.
        let pitch = if g.player.pos.y < 6.0 { 0.3 } else { 0.0 };
        run(&mut g, DT, Input { throttle: 0.05, pitch, ..Input::default() });
        t += DT;
    }
    assert!(g.player.alive, "crashed on landing");
    assert!(g.player.on_ground, "never touched down");
    assert!(g.player.hp >= STATS[F16].hp, "hard landing damage");
}

#[test]
fn crosswind_makes_the_aircraft_crab() {
    let mut g = airborne(F16, 1500.0, 150.0, 0.5);
    g.weather.wind = V3::new(15.0, 0.0, 0.0);
    // Start trimmed in the moving air mass: nose north, carried along by the wind.
    g.player.vel = g.player.vel.add(g.weather.air_at(1500.0));
    run(&mut g, 15.0, throttle(0.5));
    let p = &g.player;
    // The ground track drifts east while the nose turns into the wind.
    assert!(p.vel.x > 5.0, "no drift: {}", p.vel.x);
    assert!(p.fwd().x < p.vel.norm().x, "no crab angle");
}

#[test]
fn every_aircraft_survives_a_minute_of_hands_off_flight() {
    for ty in 0..STATS.len() {
        let mut g = airborne(ty, 1500.0, STATS[ty].max_speed * 0.6, 0.7);
        g.weather = super::air::Weather::new(&mut g.rng);
        run(&mut g, 60.0, throttle(0.7));
        assert!(g.player.alive && g.player.pos.y > 500.0, "type {ty} at {}", g.player.pos.y);
    }
}

// ---------------------------------------------------------------------------
// Roll inertia, fuel, ground crew
// ---------------------------------------------------------------------------

#[test]
fn roll_rate_builds_up_with_inertia() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    run(&mut g, 0.05, Input { throttle: 0.7, roll: 1.0, ..Input::default() });
    let early = g.player.omega.z.abs();
    run(&mut g, 1.0, Input { throttle: 0.7, roll: 1.0, ..Input::default() });
    let late = g.player.omega.z.abs();
    let rate = STATS[F16].roll_rate;
    assert!(early < 0.6 * rate, "roll rate after 50 ms: {early}");
    assert!(late > 0.9 * rate, "roll rate after 1 s: {late}");
}

#[test]
fn full_throttle_burns_fuel_and_a_dry_tank_flames_out() {
    let mut idle = airborne(F16, 3000.0, 250.0, 0.0);
    let mut full = airborne(F16, 3000.0, 250.0, 1.0);
    run(&mut idle, 10.0, throttle(0.0));
    run(&mut full, 10.0, throttle(1.0));
    let used = |g: &Game| START_FUEL - g.player.fuel;
    assert!(used(&full) > 3.0 * used(&idle), "full {} idle {}", used(&full), used(&idle));

    let mut dry = airborne(F16, 3000.0, 250.0, 1.0);
    dry.player.fuel = 0.002;
    run(&mut dry, 15.0, throttle(1.0));
    assert_eq!(dry.player.fuel, 0.0);
    assert!(dry.player.engine < 0.05, "engine still running: {}", dry.player.engine);
}

#[test]
fn a_heavy_aircraft_stalls_faster() {
    // Same slow speed and pull: the full-tank aircraft runs out of lift at a higher speed.
    let stall_speed = |fuel: f32| {
        let mut g = airborne(F16, 3000.0, 140.0, 0.3);
        g.player.fuel = fuel;
        let mut t = 0.0;
        while !g.player.stall && t < 20.0 {
            run(&mut g, DT, Input { throttle: 0.3, pitch: 1.0, ..Input::default() });
            t += DT;
        }
        g.player.speed
    };
    assert!(stall_speed(1.0) > stall_speed(0.05) + 3.0);
}

/// Parked on the runway, out of ammunition, low on fuel and with a damaged engine.
fn needs_service() -> Game {
    let mut g = calm(F16);
    g.player.ammo = 0.0;
    g.player.missiles = 0.0;
    g.player.flares = 0.0;
    g.player.fuel = 0.3;
    g.player.engine_health = 0.2;
    g
}

#[test]
fn ground_crew_rearms_after_stopping_in_a_hangar() {
    let mut g = needs_service();
    let h = &HANGARS[3];
    g.player.pos = V3::new(h.x, GEAR_HEIGHT, h.z);
    assert!(in_hangar(h.x, h.z));
    run(&mut g, REARM_TIME + 1.0, throttle(0.0));
    let p = &g.player;
    assert_eq!(p.ammo, PLAYER_AMMO);
    assert_eq!(p.missiles, STATS[F16].missiles);
    assert_eq!(p.flares, STATS[F16].flares);
    assert!(p.fuel > 0.99 && p.engine_health == 1.0);
}

#[test]
fn no_ground_crew_outside_the_hangars() {
    let mut g = needs_service();
    assert!(!in_hangar(g.player.pos.x, g.player.pos.z), "spawn point is in a hangar");
    run(&mut g, REARM_TIME + 1.0, throttle(0.0));
    assert_eq!(g.player.ammo, 0.0);
    assert!(g.player.fuel < 0.31 && g.player.engine_health == 0.2);
}

#[test]
fn hangar_bays_face_their_open_front() {
    for h in &HANGARS {
        let (fx, fz) = (h.heading.sin(), h.heading.cos());
        // Out over the front apron counts, past it or behind the back wall does not.
        assert!(in_hangar(h.x + fx * 40.0, h.z + fz * 40.0));
        assert!(!in_hangar(h.x + fx * 60.0, h.z + fz * 60.0));
        assert!(!in_hangar(h.x - fx * 50.0, h.z - fz * 50.0));
        // Sideways only between the walls.
        assert!(!in_hangar(h.x + fz * 35.0, h.z - fx * 35.0));
    }
}

#[test]
fn combat_hits_damage_aircraft_systems() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    g.player.hp = 1e6;
    for _ in 0..60 {
        g.damage_player(5.0, g.player.pos, true);
    }
    let p = &g.player;
    assert!(p.engine_health < 1.0, "engine never hit");
    assert!(p.control_health < 1.0, "controls never hit");
    assert!(p.fuel_leak > 0.0, "tank never hit");
}

// ---------------------------------------------------------------------------
// Bots fly the real flight model
// ---------------------------------------------------------------------------

fn enemy(g: &mut Game, slot: usize, ty: usize, pos: V3, fwd: V3, speed: f32) {
    g.bots[slot] = Bot::spawn(ty, pos, fwd, speed, 1e6);
}

#[test]
fn autopilot_turns_a_bot_toward_its_waypoint() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.6);
    g.player.on_ground = true; // not huntable: the bot patrols
    enemy(&mut g, 0, F16, V3::new(0.0, 2000.0, 0.0), V3::new(0.0, 0.0, -1.0), 220.0);
    g.bots[0].waypoint = V3::new(20000.0, 2100.0, 0.0);
    run(&mut g, 20.0, Input::default());
    let b = &g.bots[0];
    assert!(b.alive);
    assert!(b.vel.norm().x > 0.9, "heading {:?}", (b.vel.x, b.vel.z));
    assert!((b.pos.y - 2000.0).abs() < 600.0, "height {}", b.pos.y);
}

#[test]
fn a_diving_bot_recovers_above_the_ground() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.6);
    let dir = V3::new(0.0, -0.7, -0.7).norm();
    enemy(&mut g, 0, F16, V3::new(0.0, 700.0, 0.0), dir, 280.0);
    g.bots[0].af.q = Q::look(dir, UP);
    let mut lowest = f32::MAX;
    for _ in 0..(20.0 / DT) as usize {
        run(&mut g, DT, throttle(0.6));
        lowest = lowest.min(g.bots[0].pos.y);
    }
    assert!(g.bots[0].alive, "bot flew into the ground");
    assert!(lowest > 50.0, "lowest point {lowest}");
}

#[test]
fn a_turning_bot_bleeds_speed_like_the_player() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.6);
    g.player.on_ground = true;
    enemy(&mut g, 0, F16, V3::new(0.0, 3000.0, 0.0), V3::new(0.0, 0.0, -1.0), 260.0);
    // Waypoint behind: a hard reversal.
    g.bots[0].waypoint = V3::new(0.0, 3100.0, 8000.0);
    let mut slowest = f32::MAX;
    for _ in 0..(12.0 / DT) as usize {
        run(&mut g, DT, Input::default());
        slowest = slowest.min(g.bots[0].speed);
    }
    assert!(slowest < 235.0, "no energy lost in the turn: {slowest}");
}

#[test]
fn enemy_waves_do_not_fly_into_the_ground() {
    let mut g = airborne(F16, 2500.0, 230.0, 0.7);
    g.player.hp = 1e9;
    g.wave = 4;
    g.spawn_wave();
    for _ in 0..(120.0 / DT) as usize {
        run(&mut g, DT, throttle(0.7));
        g.player.hp = 1e9;
    }
    // The player never fires, so any kill is a bot that hit the ground.
    assert_eq!(g.kills, 0.0, "bots crashed: {}", g.kills);
}

#[test]
fn an_attacking_bot_closes_on_the_player() {
    let mut g = airborne(F16, 2000.0, 220.0, 0.6);
    g.player.hp = 1e9;
    g.wave = 3;
    enemy(&mut g, 0, F16, V3::new(0.0, 2200.0, 13000.0 + 4000.0), V3::new(0.0, 0.0, -1.0), 260.0);
    let mut closest = f32::MAX;
    for _ in 0..(60.0 / DT) as usize {
        run(&mut g, DT, throttle(0.6));
        g.player.hp = 1e9;
        closest = closest.min(g.bots[0].pos.sub(g.player.pos).len());
    }
    assert!(closest < 1200.0, "never got close: {closest}");
}

// ---------------------------------------------------------------------------
// Missiles and flares
// ---------------------------------------------------------------------------

/// Player flying north at 2 km; a missile of `owner` fired from `from` toward `track`.
fn missile_duel(from: V3, track: Track, owner: Owner) -> Game {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    let dir = g.player.pos.sub(from).norm();
    let vel = if owner == Owner::Player { g.player.vel } else { dir.mul(250.0) };
    g.launch_missile(from, vel, track, owner);
    g
}

#[test]
fn a_missile_hits_a_straight_flying_target() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    let at = g.player.pos.add(V3::new(400.0, 100.0, -3000.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 250.0);
    g.bots[0].hp = 100.0;
    g.bots[0].tactic = Tactic::Patrol;
    g.bots[0].flares = 0.0;
    let from = g.player.pos;
    let vel = g.player.vel;
    g.launch_missile(from, vel, Track::Bot(0), Owner::Player);
    run(&mut g, 15.0, throttle(0.7));
    assert!(!g.bots[0].alive, "missed a straight-flying target");
}

#[test]
fn a_missile_coasts_and_slows_after_burnout() {
    let g0 = missile_duel(V3::new(0.0, 2000.0, 13000.0), Track::None, Owner::Player);
    let mut g = g0;
    run(&mut g, MISSILE_BURN + 0.2, throttle(0.7));
    let after_burn = g.missiles[0].vel.len();
    run(&mut g, 9.0, throttle(0.7));
    let coasting = g.missiles[0].vel.len();
    assert!(after_burn > 700.0, "burnout speed {after_burn}");
    assert!(coasting < after_burn - 150.0, "no drag: {after_burn} -> {coasting}");
}

#[test]
fn a_missile_cannot_run_down_a_distant_fleeing_target() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    let at = g.player.pos.add(V3::new(0.0, 0.0, -12000.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 330.0);
    g.bots[0].hp = 100.0;
    let from = g.player.pos;
    let vel = g.player.vel;
    g.launch_missile(from, vel, Track::Bot(0), Owner::Player);
    run(&mut g, 25.0, throttle(0.7));
    assert!(g.bots[0].alive, "missile caught a target far out of range");
}

#[test]
fn an_enemy_missile_hits_a_player_who_does_nothing() {
    let mut g0 = airborne(F16, 2000.0, 250.0, 0.7);
    let from = g0.player.pos.add(V3::new(200.0, 0.0, 2500.0));
    g0.launch_missile(from, V3::new(0.0, 0.0, -250.0), Track::Player, Owner::Bot);
    let hp = g0.player.hp;
    run(&mut g0, 15.0, throttle(0.7));
    assert!(g0.player.hp < hp, "enemy missile missed a straight-flying player");
}

#[test]
fn flares_decoy_missiles_most_of_the_time() {
    let mut decoyed = 0;
    for seed in 0..10 {
        let mut g = airborne(F16, 2000.0, 250.0, 0.0);
        g.rng = crate::math::Rng(seed + 11);
        let from = g.player.pos.add(V3::new(0.0, 0.0, 3000.0));
        g.launch_missile(from, V3::new(0.0, 0.0, -250.0), Track::Player, Owner::Bot);
        let hp = g.player.hp;
        // Idle engine, a flare every FLARE_INTERVAL once the missile is close.
        for _ in 0..(15.0 / DT) as usize {
            let close = g.missiles[0].life > 0.0 && g.missiles[0].pos.sub(g.player.pos).len() < 2000.0;
            run(&mut g, DT, Input { flare: close, ..Input::default() });
        }
        if g.player.hp == hp {
            decoyed += 1;
        }
    }
    assert!(decoyed >= 7, "only {decoyed}/10 missiles decoyed");
}

#[test]
fn a_missile_loses_a_target_outside_its_gimbal() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    // Target abeam of a missile flying away from it.
    let at = g.player.pos.add(V3::new(3000.0, 0.0, 0.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 250.0);
    let from = g.player.pos.add(V3::new(0.0, 0.0, -50.0));
    g.launch_missile(from, V3::new(-300.0, 0.0, 0.0), Track::Bot(0), Owner::Player);
    run(&mut g, 0.1, throttle(0.7));
    assert!(g.missiles[0].track == Track::None);
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

#[test]
fn sam_sites_lock_a_high_player_but_not_a_low_one() {
    let mut high = airborne(F16, 1500.0, 220.0, 0.6);
    high.set_mode(Mode::Strike);
    high.player.pos = high.ground[0].pos.add(V3::new(0.0, 1500.0, 3000.0));
    let mut low = airborne(F16, 1500.0, 220.0, 0.6);
    low.set_mode(Mode::Strike);
    low.player.pos = low.ground[0].pos.add(V3::new(0.0, 80.0, 3000.0));
    run(&mut high, 2.0, throttle(0.6));
    run(&mut low, 2.0, throttle(0.6));
    assert!(high.ground[0].lock > 0.3, "high lock {}", high.ground[0].lock);
    assert_eq!(low.ground[0].lock, 0.0);
}

#[test]
fn destroying_every_sam_completes_the_strike_and_starts_the_next() {
    let mut g = airborne(F16, 1500.0, 220.0, 0.6);
    g.set_mode(Mode::Strike);
    let n = g.objectives_left();
    assert!(n >= 3);
    for i in 0..MAX_GROUND {
        if g.ground[i].alive {
            let at = g.ground[i].pos;
            g.damage_ground(i, 1e6, at);
        }
    }
    assert_eq!(g.objectives_left(), 0);
    run(&mut g, 8.0, throttle(0.6));
    assert!(g.objectives_left() > n, "next stage did not start");
}

#[test]
fn the_escorted_bomber_flies_its_route() {
    let mut g = calm(F16);
    g.set_mode(Mode::Escort);
    let i = g.escort_index().expect("no escort");
    let to_wp = |g: &Game| g.bots[i].pos.sub(g.bots[i].waypoint).flat().len();
    let d0 = to_wp(&g);
    run(&mut g, 30.0, Input::default());
    assert!(g.bots[i].alive);
    assert!(to_wp(&g) < d0 - 3000.0, "not following its route: {d0} -> {}", to_wp(&g));
}

#[test]
fn a_fresh_aircraft_on_the_runway_needs_no_service() {
    let mut g = calm(F16);
    run(&mut g, REARM_TIME + 1.0, throttle(0.0));
    assert_eq!(g.player.parked, 0.0);
}

#[test]
fn free_mode_clears_the_sky_and_spawns_no_enemies() {
    let mut g = airborne(F16, 1500.0, 220.0, 0.6);
    g.spawn_wave();
    assert!(g.bots_alive() > 0, "no wave to clear");
    g.set_mode(Mode::Free);
    g.wave_timer = 0.0;
    assert_eq!(g.bots_alive(), 0);
    assert!(g.missiles.iter().all(|m| m.life <= 0.0 || m.owner == Owner::Player));
    run(&mut g, 30.0, throttle(0.6));
    assert_eq!(g.bots_alive(), 0);
    assert_eq!(g.objectives_left(), 0);
}

// ---------------------------------------------------------------------------
// Stall, ground effect, landing gear, thrust lapse, fuel weight
// ---------------------------------------------------------------------------

/// Slow F-16 at idle, stick fully back until well into the stall; `yaw` holds rudder.
fn stalled(yaw: f32) -> Game {
    let mut g = airborne(F16, 3000.0, 110.0, 0.0);
    run(&mut g, 8.5, Input { pitch: 1.0, ..Input::default() });
    assert!(g.player.stall, "not stalled yet");
    run(&mut g, 3.0, Input { pitch: 1.0, yaw, ..Input::default() });
    g
}


#[test]
fn a_held_stall_drops_the_nose_and_releasing_recovers() {
    let mut g = airborne(F16, 3000.0, 110.0, 0.0);
    let (mut peak_nose, mut peak_alpha): (f32, f32) = (-1.0, 0.0);
    for _ in 0..(16.0 / DT) as usize {
        run(&mut g, DT, Input { pitch: 1.0, ..Input::default() });
        peak_nose = peak_nose.max(g.player.fwd().y);
        peak_alpha = peak_alpha.max(g.player.alpha);
    }
    // The pull drags the wing past maximum lift, then the nose falls through the horizon
    // although the stick is still fully back.
    assert!(peak_alpha > STATS[F16].alpha_max, "AoA never past the limit: {peak_alpha}");
    assert!(g.player.stall);
    assert!(g.player.fwd().y < peak_nose - 0.4, "nose held up: {} from {peak_nose}", g.player.fwd().y);
    // Release the stick and add power: flying again within a few seconds.
    run(&mut g, 5.0, throttle(1.0));
    assert!(g.player.alive && !g.player.stall, "still stalled at {} m/s", g.player.speed);
    assert!(g.player.speed > 90.0, "speed {}", g.player.speed);
}

#[test]
fn an_uncoordinated_stall_drops_a_wing_and_recovers() {
    let right_y = |g: &Game| g.player.q.rotate(crate::math::RIGHT).y;
    let level = stalled(0.0);
    let mut ruddered = stalled(1.0);
    // Right rudder: the right wing drops; the coordinated stall stays near wings level.
    assert!(right_y(&level).abs() < 0.15, "coordinated stall banked {}", right_y(&level));
    assert!(right_y(&ruddered) < -0.3, "no wing drop: {}", right_y(&ruddered));
    // No spin: centre the controls, add power and level the wings.
    run(&mut ruddered, 5.0, throttle(1.0));
    assert!(!ruddered.player.stall && ruddered.player.omega.z.abs() < 0.1, "still departing");
    let bank = right_y(&ruddered);
    run(&mut ruddered, 3.0, Input { throttle: 1.0, roll: if bank < 0.0 { -1.0 } else { 1.0 }, ..Input::default() });
    run(&mut ruddered, 2.0, Input { throttle: 1.0, pitch: 0.5, ..Input::default() });
    assert!(ruddered.player.alive && ruddered.player.pos.y > 1500.0, "height {}", ruddered.player.pos.y);
}

#[test]
fn ground_effect_adds_lift_within_a_wingspan() {
    use super::air::ground_effect;
    let span = STATS[F16].span;
    assert!(ground_effect(GEAR_HEIGHT, span) > 0.7);
    assert_eq!(ground_effect(GROUND_EFFECT_SPANS * span, span), 0.0);
    // The big wing of the B-2 floats on a deeper cushion.
    assert!(ground_effect(20.0, STATS[B2].span) > ground_effect(20.0, span));
    // Same speed and attitude, close to the runway and well above it.
    let lift = |h: f32| {
        let mut g = airborne(F16, h, 90.0, 0.0);
        g.player.q = Q::look(V3::new(0.0, 0.1, -1.0).norm(), UP);
        super::aero::fly(&mut g.player.af, &Input::default(), V3::default(), 0.0, DT);
        g.player.gload
    };
    assert!(lift(4.0) > 1.06 * lift(80.0), "near {} high {}", lift(4.0), lift(80.0));
}

#[test]
fn touchdown_compresses_the_gear_and_it_settles() {
    let mut g = airborne(F16, GEAR_HEIGHT + 0.5, 75.0, 0.0);
    g.player.vel = V3::new(0.0, -2.5, -75.0);
    g.player.q = Q::look(V3::new(0.0, 0.05, -1.0).norm(), UP);
    let mut t = 0.0;
    while !g.player.on_ground && t < 5.0 {
        run(&mut g, DT, throttle(0.0));
        t += DT;
    }
    assert!(g.player.on_ground && g.player.alive, "no touchdown");
    let (mut lo, mut hi): (f32, f32) = (0.0, 0.0);
    for _ in 0..(1.0 / DT) as usize {
        run(&mut g, DT, throttle(0.0));
        lo = lo.min(g.player.gear);
        hi = hi.max(g.player.gear);
    }
    // A visible squash and rebound, without bottoming the struts.
    assert!(lo < -0.08 && lo > -GEAR_TRAVEL, "compression {lo}");
    assert!(hi > 0.0, "no rebound");
    run(&mut g, 3.0, Input { brake: true, ..Input::default() });
    assert!(g.player.gear_vel.abs() < 0.05 && g.player.gear.abs() < 0.05, "still bouncing");
    // Braking dips the nose on its strut.
    assert!(g.player.gear_pitch < -0.005, "no nose dip: {}", g.player.gear_pitch);
}

#[test]
fn thrust_lapses_with_altitude() {
    use super::air::density_ratio;
    let mut af = Bot::spawn(F16, V3::default(), V3::new(0.0, 0.0, -1.0), 200.0, 1.0).af;
    af.engine = 1.0;
    af.density = 1.0;
    let sea_level = super::aero::thrust(&af);
    af.density = density_ratio(8000.0);
    let aloft = super::aero::thrust(&af);
    // At 8 km the air is about 43% as dense: roughly 55% of the thrust is left.
    assert!(aloft < 0.65 * sea_level && aloft > 0.45 * sea_level, "{aloft} vs {sea_level}");
}

#[test]
fn a_light_aircraft_accelerates_better_than_a_full_one() {
    let gain = |fuel: f32| {
        let mut g = airborne(F16, 3000.0, 150.0, 1.0);
        g.player.fuel = fuel;
        run(&mut g, 8.0, throttle(1.0));
        g.player.speed - 150.0
    };
    let (full, light) = (gain(1.0), gain(0.1));
    // Noticeable but modest: tens of percent, not a different aircraft.
    assert!(light > 1.1 * full && light < 1.6 * full, "light {light} full {full}");
}

#[test]
fn rolling_under_load_is_slower_than_a_1g_roll() {
    let roll_rate_after = |pull: f32| {
        let mut g = airborne(F16, 3000.0, 250.0, 0.8);
        run(&mut g, 1.5, Input { throttle: 0.8, pitch: pull, ..Input::default() });
        run(&mut g, 1.0, Input { throttle: 0.8, pitch: pull, roll: 1.0, ..Input::default() });
        g.player.omega.z.abs()
    };
    let free = roll_rate_after(0.0);
    let loaded = roll_rate_after(1.0);
    assert!(loaded < 0.75 * free, "loaded {loaded} vs 1 G {free}");
}

#[test]
fn controls_stiffen_at_high_speed() {
    let roll_rate_at = |speed: f32| {
        let mut g = airborne(F16, 1000.0, speed, 1.0);
        run(&mut g, 1.0, Input { throttle: 1.0, roll: 1.0, ..Input::default() });
        g.player.omega.z.abs()
    };
    let corner = roll_rate_at(220.0);
    let fast = roll_rate_at(400.0);
    assert!(fast < 0.75 * corner, "roll at 400 m/s {fast} vs 220 m/s {corner}");
}

#[test]
fn a_ruddered_stall_spins_until_opposite_rudder_and_forward_stick() {
    // Stick back and full right rudder: the stall autorotates into a spin.
    let mut g = stalled(1.0);
    run(&mut g, 2.0, Input { pitch: 1.0, yaw: 1.0, ..Input::default() });
    let spinning = g.player.omega.z.abs();
    assert!(g.player.stall && spinning > 0.3, "no spin: roll rate {spinning}");
    assert!(g.player.fwd().y < -0.3, "spinning nose up: {}", g.player.fwd().y);
    // Recovery: opposite rudder, stick forward, then power and pull out.
    run(&mut g, 2.5, Input { pitch: -0.5, yaw: -1.0, ..Input::default() });
    run(&mut g, 2.0, Input::default());
    assert!(g.player.omega.z.abs() < 0.2, "still spinning: {}", g.player.omega.z);
    assert!(!g.player.stall, "still stalled");
}

#[test]
fn overspeed_damages_the_airframe() {
    let mut g = airborne(F16, 2000.0, 200.0, 1.0);
    let hp = g.player.hp;
    // Steep full-power dive well past the structural limit (equivalent airspeed).
    let eas = STATS[F16].max_speed * OVERSPEED_LIMIT + 60.0;
    let tas = eas / super::air::density_ratio(2000.0).sqrt();
    let dive = V3::new(0.0, -0.8, -0.6).norm();
    g.player.q = Q::look(dive, UP);
    g.player.vel = dive.mul(tas);
    g.player.speed = tas;
    run(&mut g, 1.0, throttle(1.0));
    assert!(g.player.hp < hp, "no overspeed damage");
    // Within the limit nothing happens.
    let mut ok = airborne(F16, 3000.0, 250.0, 0.8);
    let hp = ok.player.hp;
    run(&mut ok, 3.0, throttle(0.8));
    assert_eq!(ok.player.hp, hp);
}



// ---------------------------------------------------------------------------
// Performance envelope, guns, collisions and the Simulator realism setting
// ---------------------------------------------------------------------------

/// Level full-power speed (Mach) at height `h`, with the height pinned.
fn level_mach(ty: usize, h: f32) -> f32 {
    let mut g = airborne(ty, h, STATS[ty].max_speed * 0.8, 1.0);
    for _ in 0..(240.0 / DT) as usize {
        g.player.fuel = 0.5;
        g.player.pos.y = h;
        g.player.vel.y = 0.0;
        run(&mut g, DT, throttle(1.0));
    }
    g.player.speed / super::air::speed_of_sound(h)
}

#[test]
fn top_speed_peaks_at_the_tropopause_and_the_ceiling_is_finite() {
    let tropo = level_mach(F16, 11000.0);
    assert!((1.9..2.3).contains(&tropo), "F-16 at 11 km: Mach {tropo}");
    assert!(level_mach(F16, 18000.0) < 0.7 * tropo, "F-16 still fast at 18 km");
    // A bomber cruises high subsonic.
    let b2 = level_mach(B2, 11000.0);
    assert!((0.6..0.95).contains(&b2), "B-2 at 11 km: Mach {b2}");
}

#[test]
fn the_b2_takes_off_within_the_runway() {
    let mut g = calm(B2);
    let start = g.player.pos;
    for _ in 0..(90.0 / DT) as usize {
        let pitch = if g.player.speed > STATS[B2].rotate_speed { 1.0 } else { 0.0 };
        run(&mut g, DT, Input { throttle: 1.0, pitch, ..Input::default() });
        if !g.player.on_ground {
            break;
        }
    }
    assert!(!g.player.on_ground, "never lifted off");
    assert!(g.player.pos.sub(start).flat().len() < RUNWAY_LENGTH - RUNWAY_SPAWN_INSET);
}

#[test]
fn cannon_rounds_slow_down_and_spread() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.8);
    g.input = Input { throttle: 0.8, gun: true, ..Input::default() };
    g.step(DT);
    let b = g.bullets.iter().find(|b| b.life > 0.0).copied().expect("no round fired");
    let v0 = b.vel.sub(g.player.vel).len();
    g.input = throttle(0.8);
    run(&mut g, 1.0, throttle(0.8));
    let after = g.bullets.iter().filter(|b| b.life > 0.0).map(|b| b.vel.len()).fold(0.0, f32::max);
    assert!(after < 0.8 * (v0 + 250.0), "no drag: {v0} -> {after}");
    // Several rounds fired straight ahead do not all leave on the same line.
    let mut g = airborne(F16, 2000.0, 250.0, 0.8);
    run(&mut g, 0.5, Input { throttle: 0.8, gun: true, ..Input::default() });
    let dirs: Vec<V3> = g.bullets.iter().filter(|b| b.life > 0.0).map(|b| b.vel.sub(g.player.vel).norm()).collect();
    assert!(dirs.len() > 3);
    assert!(dirs.windows(2).any(|w| w[0].dot(w[1]) < 0.999995), "no dispersion");
}

#[test]
fn a_midair_collision_destroys_both_aircraft() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.8);
    let ahead = g.player.pos.add(V3::new(0.0, 0.0, -30.0));
    enemy(&mut g, 0, F16, ahead, V3::new(0.0, 0.0, 1.0), 200.0);
    run(&mut g, 0.2, throttle(0.8));
    assert!(!g.player.alive && !g.bots[0].alive);
}

#[test]
fn simulator_loads_real_ammunition_and_disarms_the_bomber() {
    let mut g = calm(F16);
    g.set_realism(true);
    assert_eq!(g.player.ammo, STATS[F16].rounds);
    g.input = Input { gun: true, ..Input::default() };
    g.player.on_ground = false;
    g.player.pos.y = 2000.0;
    g.player.gun_cd = 0.0;
    g.update_player(DT);
    assert_eq!(g.player.ammo, STATS[F16].rounds - ROUNDS_PER_SHOT);
    let mut b2 = calm(B2);
    b2.set_realism(true);
    assert_eq!((b2.player.ammo, b2.player.missiles), (0.0, 0.0));
    b2.set_realism(false);
    assert!(b2.player.ammo > 0.0 && b2.player.missiles > 0.0);
}

#[test]
fn simulator_has_no_aim_assist() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.8);
    // A target 5 degrees off the nose: arcade bends the shot onto it, simulator does not.
    let off = V3::new(0.087, 0.0, -1.0).norm().mul(800.0);
    let at = g.player.pos.add(off);
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 250.0);
    let fwd = g.player.fwd();
    let (muzzle, pvel) = (g.player.pos, g.player.vel);
    assert!(g.gun_assist_dir(muzzle, fwd, pvel).dot(fwd) < 0.9999);
    g.realism = true;
    assert_eq!(g.gun_assist_dir(muzzle, fwd, pvel).dot(fwd), 1.0);
}

#[test]
fn simulator_does_not_turn_the_aircraft_back_and_loses_it_outside() {
    let mut g = airborne(F16, 3000.0, 250.0, 0.8);
    g.realism = true;
    g.player.pos = V3::new(0.0, 3000.0, WORLD_LIMIT + 200.0);
    g.player.q = Q::look(V3::new(0.0, 0.0, 1.0), UP);
    g.player.vel = V3::new(0.0, 0.0, 250.0);
    run(&mut g, 5.0, throttle(0.8));
    assert!(g.player.vel.norm().z > 0.99, "turned back by magic");
    run(&mut g, SIM_OUT_OF_BOUNDS_TIME, throttle(0.8));
    assert!(!g.player.alive || g.player.respawn > 0.0, "still flying outside");
}

#[test]
fn simulator_landing_limits_are_strict() {
    // A 5 m/s sink: fine in arcade, a damaging hard landing in the simulator.
    let land = |realism: bool, sink: f32| {
        let mut g = airborne(F16, 1.0, 75.0, 0.05);
        g.realism = realism;
        g.player.vel = V3::new(0.0, -sink, -75.0);
        g.player.pos.y = super::flight::wheels_down_height(0.0) + 0.01;
        g.player.q = Q::look(V3::new(0.0, 0.08, -1.0).norm(), UP);
        run(&mut g, 0.1, throttle(0.05));
        (g.player.alive, g.player.hp)
    };
    let full = STATS[F16].hp;
    assert_eq!(land(false, 5.0), (true, full));
    let (alive, hp) = land(true, 5.0);
    assert!(alive && hp < full, "no damage at 5 m/s in the simulator");
    assert!(!land(true, 7.0).0, "7 m/s survived in the simulator");
    assert!(land(false, 7.0).0);
}


// ---------------------------------------------------------------------------
// Rigid body and flight control computer
// ---------------------------------------------------------------------------

#[test]
fn control_surfaces_move_at_the_actuator_rate() {
    let mut g = airborne(F16, 2000.0, 250.0, 0.7);
    g.input = Input { throttle: 0.7, roll: 1.0, pitch: 1.0, ..Input::default() };
    g.step(DT);
    let s = g.player.surf;
    let max = SURFACE_RATE * DT + 1e-4;
    assert!(s.x.abs() <= max && s.z.abs() <= max, "surfaces jumped: {} {}", s.x, s.z);
    assert!(s.z.abs() > 0.5 * max, "ailerons did not move");
}

#[test]
fn a_pitch_doublet_settles_without_oscillating() {
    let mut g = airborne(F16, 3000.0, 230.0, 0.7);
    run(&mut g, 0.4, Input { throttle: 0.7, pitch: 1.0, ..Input::default() });
    run(&mut g, 0.4, Input { throttle: 0.7, pitch: -1.0, ..Input::default() });
    run(&mut g, 2.5, throttle(0.7));
    assert!(g.player.omega.x.abs() < 0.03, "pitch rate still {}", g.player.omega.x);
    assert!(g.player.alive);
}

#[test]
fn gyroscopic_coupling_vanishes_about_a_principal_axis() {
    use super::aero::gyroscopic_for_tests as gyro;
    let i = STATS[F16].inertia;
    for w in [V3::new(2.0, 0.0, 0.0), V3::new(0.0, 2.0, 0.0), V3::new(0.0, 0.0, 2.0)] {
        assert_eq!(gyro(w, i).len(), 0.0);
    }
    // Rolling while pitching: the long fuselage (yaw inertia > roll inertia) yaws.
    assert!(gyro(V3::new(1.0, 0.0, 3.0), i).y.abs() > 0.1);
}

#[test]
fn the_integration_is_step_size_independent() {
    let fly = |dt: f32| {
        let mut g = airborne(F16, 3000.0, 230.0, 0.8);
        g.weather.wind = V3::default();
        g.input = Input { throttle: 0.8, pitch: 0.6, roll: 0.3, ..Input::default() };
        for _ in 0..(6.0 / dt).round() as usize {
            g.step(dt);
        }
        g.player.pos
    };
    let coarse = fly(1.0 / 30.0);
    let fine = fly(1.0 / 120.0);
    assert!(coarse.sub(fine).len() < 60.0, "paths diverge by {} m", coarse.sub(fine).len());
}

#[test]
fn a_full_sky_steps_quickly() {
    let mut g = calm(F16);
    g.density = 3.0;
    g.wave = 6;
    g.spawn_wave();
    g.spawn_wave();
    let start = std::time::Instant::now();
    run(&mut g, 10.0, throttle(0.0));
    let per_step = start.elapsed().as_secs_f32() / (10.0 / DT);
    assert!(per_step < 0.002, "{:.3} ms per step with {} bots", per_step * 1000.0, g.bots_alive());
}

#[test]
fn the_density_table_matches_the_isa_formula() {
    use super::air::{density_ratio, isa_density_for_tests as exact};
    for h in [0.0, 37.0, 1234.5, 10999.0, 11000.0, 11025.0, 17890.0, 29999.0, 31000.0] {
        let (a, b) = (density_ratio(h), exact(h));
        assert!((a - b).abs() < 1e-4 * b.max(0.01), "h {h}: {a} vs {b}");
    }
}

#[test]
fn liftoff_is_seamless() {
    let mut g = calm(F16);
    let mut last = (g.player.pos.y, 0.0f32, 0.0f32);
    let mut worst = (0.0f32, 0.0f32);
    let mut lifted = None;
    for i in 0..(30.0 / DT) as usize {
        let rotate = g.player.speed > STATS[F16].rotate_speed;
        let was_ground = g.player.on_ground;
        run(&mut g, DT, Input { throttle: 1.0, pitch: if rotate { 1.0 } else { 0.0 }, ..Input::default() });
        let p = &g.player;
        let (y, pitch) = (p.pos.y, p.fwd().y.asin());
        let rate = (pitch - last.1) / DT;
        if was_ground && !p.on_ground {
            lifted = Some(i);
        }
        if lifted.is_some_and(|l| i <= l + 3) {
            // Around liftoff: no jump in height, no snap or stall of the pitch rate.
            worst.0 = worst.0.max((y - last.0).abs());
            worst.1 = worst.1.max((rate - last.2).abs());
        }
        assert!(!(lifted.is_some() && p.on_ground), "touched down again after liftoff");
        last = (y, pitch, rate);
    }
    assert!(lifted.is_some(), "never lifted off");
    assert!(worst.0 < 0.02, "height step {} m", worst.0);
    assert!(worst.1 < 0.03, "pitch rate step {} rad/s", worst.1);
}

#[test]
fn holding_the_flare_through_touchdown_does_not_bounce() {
    // Stick held back at touchdown, throttle idle: the lift dumpers keep it on the runway.
    let mut g = airborne(F16, GEAR_HEIGHT + 1.0, 95.0, 0.0);
    g.player.vel = V3::new(0.0, -2.0, -95.0);
    g.player.q = Q::look(V3::new(0.0, 0.15, -1.0).norm(), UP);
    let mut touched = false;
    for _ in 0..(10.0 / DT) as usize {
        let brake = g.player.on_ground;
        run(&mut g, DT, Input { pitch: 0.6, brake, ..Input::default() });
        touched |= g.player.on_ground;
        assert!(!touched || g.player.on_ground, "bounced back into the air");
    }
    assert!(touched && g.player.alive, "no landing");
}

#[test]
fn an_arcade_hard_landing_does_not_destroy_a_damaged_aircraft() {
    let mut g = airborne(F16, GEAR_HEIGHT + 0.5, 90.0, 0.0);
    g.player.hp = 10.0;
    g.player.vel = V3::new(0.0, -(MAX_SINK_RATE - 1.0), -90.0);
    g.player.q = Q::look(V3::new(0.0, 0.05, -1.0).norm(), UP);
    run(&mut g, 0.5, throttle(0.0));
    assert!(g.player.on_ground && g.player.alive, "destroyed by a landing inside the limits");
    assert!(g.player.hp < 10.0, "no hard landing damage");
}

#[test]
fn full_stick_at_liftoff_climbs_out_gently() {
    // Takeoff gains: the nose keeps its rotation pace and the climb builds up, rather than
    // the aircraft leaping off the runway the moment the wheels leave it.
    for ty in [F16, B2] {
        let mut g = calm(ty);
        let mut lifted = None;
        let (mut vy, mut max_accel) = (0.0f32, 0.0f32);
        for i in 0..(60.0 / DT) as usize {
            run(&mut g, DT, Input { throttle: 1.0, pitch: 1.0, ..Input::default() });
            if lifted.is_none() && !g.player.on_ground {
                lifted = Some(i);
            }
            if let Some(l) = lifted {
                max_accel = max_accel.max((g.player.vel.y - vy) / DT);
                if i > l + (1.5 / DT) as usize {
                    break;
                }
            }
            vy = g.player.vel.y;
        }
        assert!(lifted.is_some(), "never lifted off");
        assert!(max_accel < 0.6 * GRAVITY, "aircraft {ty} leapt off at {max_accel} m/s^2");
    }
}

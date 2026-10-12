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
    // Roll to ~80 degrees, then pull.
    run(&mut g, 0.6, Input { throttle: 1.0, roll: 1.0, ..Input::default() });
    let mut peak: f32 = 0.0;
    for _ in 0..(8.0 / DT) as usize {
        run(&mut g, DT, Input { throttle: 1.0, pitch: 1.0, ..Input::default() });
        peak = peak.max(g.player.gload);
    }
    let lim = STATS[F16].g_limit;
    assert!(peak > lim * 0.8, "peak G {peak}");
    assert!(peak < lim + 1.0, "peak G {peak} over limit");
    assert!(g.player.speed < 240.0, "no energy bleed: {}", g.player.speed);
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
    // 3 degree glide at ~85 m/s from 60 m.
    let mut g = airborne(F16, 60.0, 85.0, 0.12);
    let path = V3::new(0.0, -0.052, -1.0).norm();
    g.player.vel = path.mul(85.0);
    g.player.q = Q::look(V3::new(0.0, 0.1, -1.0).norm(), UP);
    let mut t = 0.0;
    while !g.player.on_ground && g.player.alive && t < 60.0 {
        // Flare in the last few metres.
        let pitch = if g.player.pos.y < 6.0 { 0.3 } else { 0.0 };
        run(&mut g, DT, Input { throttle: 0.12, pitch, ..Input::default() });
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
    let early = g.player.roll_vel.abs();
    run(&mut g, 1.0, Input { throttle: 0.7, roll: 1.0, ..Input::default() });
    let late = g.player.roll_vel.abs();
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
    // Same slow speed and pull: the full-tank aircraft runs out of lift first.
    let stall_time = |fuel: f32| {
        let mut g = airborne(F16, 3000.0, 140.0, 0.3);
        g.player.fuel = fuel;
        let mut t = 0.0;
        while !g.player.stall && t < 20.0 {
            run(&mut g, DT, Input { throttle: 0.3, pitch: 1.0, ..Input::default() });
            t += DT;
        }
        t
    };
    assert!(stall_time(1.0) < stall_time(0.05));
}

#[test]
fn ground_crew_rearms_after_stopping_at_the_base() {
    let mut g = calm(F16);
    g.player.ammo = 0.0;
    g.player.missiles = 0.0;
    g.player.flares = 0.0;
    g.player.fuel = 0.3;
    g.player.engine_health = 0.2;
    run(&mut g, REARM_TIME + 1.0, throttle(0.0));
    let p = &g.player;
    assert_eq!(p.ammo, PLAYER_AMMO);
    assert_eq!(p.missiles, STATS[F16].missiles);
    assert_eq!(p.flares, STATS[F16].flares);
    assert!(p.fuel > 0.99 && p.engine_health == 1.0);
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
    run(&mut g, 3.0, throttle(0.7));
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

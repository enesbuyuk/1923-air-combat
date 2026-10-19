//! Observable configuration, environment, sensor and player/AI parity regressions.
use super::{Game, Mode};
use super::tests::*;
use crate::config::*;
use crate::entities::{Bot, Input, Owner, Tactic, Track};
use crate::environment::{Environment, Surface};
use crate::layout::{bot, player};
use crate::math::{Q, V3, UP};

fn wall(g: &mut Game, x: f32, z: f32, top: f32) {
    g.environment.static_obstacles.add(vec![(x - 100.0, z - 0.1), (x + 100.0, z - 0.1), (x + 100.0, z + 0.1), (x - 100.0, z + 0.1)], 0.0, top);
}

#[test]
fn all_aircraft_take_off_over_the_production_terrain() {
    for ty in 0..STATS.len() {
        let mut g = Game::new(ty, 7);
        g.set_mode(Mode::Free);
        g.weather.wind = V3::default();
        let start = g.player.pos;
        for _ in 0..(60.0 / DT) as usize {
            run(&mut g, DT, Input { throttle: 1.0, pitch: 1.0, ..Input::default() });
            if !g.player.on_ground { break; }
        }
        assert!(g.player.alive && !g.player.on_ground, "aircraft {ty} failed to lift off");
        assert!(g.player.pos.sub(start).flat().len() < RUNWAY_LENGTH - RUNWAY_SPAWN_INSET, "aircraft {ty} overran the runway");
        run(&mut g, 2.0, Input { throttle: 1.0, pitch: 0.3, ..Input::default() });
        assert!(g.player.alive && g.environment.agl(g.player.pos) > 3.0, "aircraft {ty} failed to climb");
    }
}

#[test]
fn landing_gear_travels_over_time_and_changes_drag() {
    let mut g = airborne(F16, 2000.0, 140.0, 0.3);
    g.player.gear_down = true;
    super::configuration::update(&mut g.player.af, 1.0);
    assert!((g.player.gear_position - 1.0 / 3.0).abs() < 1e-5);
    super::configuration::update(&mut g.player.af, 2.1);
    assert_eq!(g.player.gear_position, 1.0);
    let mut clean = airborne(F16, 2000.0, 140.0, 0.3);
    run(&mut g, 2.0, throttle(0.3));
    run(&mut clean, 2.0, throttle(0.3));
    assert!(g.player.speed < clean.player.speed - 0.5, "gear had no aerodynamic cost");
}

#[test]
fn flaps_move_gradually_increase_lift_and_lower_the_stall_speed() {
    let mut clean = airborne(F16, 2000.0, 100.0, 0.3);
    let mut flaps = airborne(F16, 2000.0, 100.0, 0.3);
    flaps.player.flap_command = 1.0;
    super::configuration::update(&mut flaps.player.af, 0.5);
    assert_eq!(flaps.player.flaps, 0.25);
    super::configuration::update(&mut flaps.player.af, 2.0);
    for g in [&mut clean, &mut flaps] {
        g.player.q = Q::look(V3::new(0.0, 0.12, -1.0).norm(), UP);
        g.update_player(DT);
        g.write_out();
    }
    assert!(flaps.player.gload > clean.player.gload * 1.2, "flaps did not increase lift");
    assert!(flaps.out_player[player::STALL_SPEED] < clean.out_player[player::STALL_SPEED] * 0.9);
    assert!(super::configuration::drag(&flaps.player.af) > super::configuration::drag(&clean.player.af));
}

#[test]
fn excessive_airspeed_can_damage_and_jam_gear_and_flaps() {
    let mut g = approach(F16, 2000.0, 300.0, 0.5);
    g.player.flaps = 1.0;
    g.player.flap_command = 1.0;
    for _ in 0..100 { super::configuration::update(&mut g.player.af, 0.1); }
    assert!(g.player.gear_health <= 0.1 && g.player.flap_health <= 0.1);
    g.player.gear_down = false;
    g.player.flap_command = 0.0;
    super::configuration::update(&mut g.player.af, 10.0);
    assert_eq!(g.player.gear_position, 1.0, "damaged gear retracted normally");
    assert_eq!(g.player.flaps, 1.0, "damaged flaps retracted normally");
}

#[test]
fn stowed_partial_or_broken_gear_cannot_make_a_normal_landing() {
    for (position, health) in [(0.0, 1.0), (0.5, 1.0), (1.0, 0.1)] {
        let mut g = approach(F16, 0.75, 75.0, 0.0);
        g.player.gear_position = position;
        g.player.gear_down = position > 0.5;
        g.player.gear_health = health;
        g.player.vel.y = -1.0;
        g.update_player(DT);
        assert!(!g.player.alive, "unsafe gear landed normally: {position}, {health}");
    }
}

#[test]
fn terrain_preserves_the_airfield_and_distinguishes_land_and_water() {
    let e = Environment::default();
    assert_eq!(e.height(-40.0, 500.0), 0.0);
    assert_eq!(e.surface(-40.0, 500.0), Surface::Paved);
    assert_eq!(e.surface(700.0, 0.0), Surface::Soil);
    assert_eq!(e.surface(0.0, 12000.0), Surface::Water);
    let high = e.height(5500.0, -4000.0);
    assert!(high > 50.0, "terrain stayed flat");
    assert!((e.agl(V3::new(5500.0, high + 30.0, -4000.0)) - 30.0).abs() < 1e-4);
    assert!((e.height(0.0, 4199.99) - e.height(0.0, 4200.01)).abs() < 0.1, "approach flattening made a cliff");
}

#[test]
fn soil_has_more_rolling_resistance_and_less_braking_than_asphalt() {
    let roll = |x: f32, brake: bool| {
        let mut g = calm(F16);
        g.environment.flat = false;
        g.player.pos = V3::new(x, g.environment.height(x, 0.0) + GEAR_HEIGHT, 0.0);
        g.player.speed = 20.0;
        run(&mut g, 1.0, Input { brake, ..Input::default() });
        assert!(g.player.alive);
        g.player.speed
    };
    assert!(roll(700.0, false) < roll(-40.0, false) - 1.0);
    let asphalt_braking = roll(-40.0, false) - roll(-40.0, true);
    let soil_braking = roll(700.0, false) - roll(700.0, true);
    assert!(asphalt_braking > soil_braking * 1.5);
}

#[test]
fn water_contact_cannot_turn_into_taxiing() {
    let mut g = calm(F16);
    g.environment.flat = false;
    g.player.pos = V3::new(0.0, GEAR_HEIGHT, 12000.0);
    run(&mut g, DT, throttle(0.0));
    assert!(!g.player.alive);
}

#[test]
fn touchdown_uses_the_local_terrain_height() {
    let mut g = approach(F16, 100.0, 65.0, 0.0);
    g.environment.flat = false;
    let h = g.environment.height(5500.0, -4000.0);
    g.player.pos = V3::new(5500.0, h + GEAR_HEIGHT, -4000.0);
    g.player.vel = V3::new(0.0, -1.0, -65.0);
    g.update_player(DT);
    assert!(g.player.alive && g.player.on_ground);
    assert!((g.environment.agl(g.player.pos) - GEAR_HEIGHT).abs() < 0.1);
}

#[test]
fn hills_and_thin_buildings_occlude_sensors() {
    let mut g = calm(F16);
    g.environment.flat = false;
    assert!(!g.environment.clear_line(V3::new(3000.0, 20.0, -4000.0), V3::new(8000.0, 20.0, -4000.0)));
    assert!(g.environment.clear_line(V3::new(3000.0, 500.0, -4000.0), V3::new(8000.0, 500.0, -4000.0)));
    g.environment.flat = true;
    wall(&mut g, 0.0, 100.05, 200.0);
    assert!(!g.environment.clear_line(V3::new(0.0, 100.0, 0.0), V3::new(0.0, 100.0, 300.0)));
    assert!(g.environment.clear_line(V3::new(0.0, 250.0, 0.0), V3::new(0.0, 250.0, 300.0)));
}

#[test]
fn lost_contacts_coast_at_the_last_known_position_then_expire() {
    let mut g = airborne(F16, 1000.0, 200.0, 0.5);
    let at = g.player.pos.add(V3::new(0.0, 0.0, -1000.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 200.0);
    g.update_sensors(0.25);
    assert!(g.contacts[0].confirmed);
    wall(&mut g, 0.0, at.z + 500.0, 1500.0);
    g.bots[0].pos.x += 50.0;
    g.update_sensors(0.25);
    assert!(!g.contacts[0].confirmed && g.contacts[0].ttl > 0.0);
    assert_eq!(g.contacts[0].pos.x, at.x, "occluded target kept broadcasting its real position");
    g.write_out();
    assert!(g.out_bots[bot::DETECTED] < 0.0, "memory track was marked confirmed");
    g.update_sensors(2.0);
    assert_eq!(g.contacts[0].ttl, 0.0);
}

#[test]
fn a_hidden_target_cannot_be_locked_by_the_player_or_acquired_by_a_bot() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.5);
    let at = g.player.pos.add(V3::new(0.0, 0.0, -1000.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, 1.0), 200.0);
    wall(&mut g, 0.0, at.z + 500.0, 2500.0);
    run(&mut g, 1.0, throttle(0.5));
    assert!(g.lock == Track::None);
    assert_eq!(g.bots[0].lock, 0.0);
    assert!(g.bots[0].tactic != Tactic::Attack, "AI acquired a target through the wall");
}

#[test]
fn bullets_and_seekers_cannot_pass_through_a_building() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.5);
    let at = g.player.pos.add(V3::new(0.0, 0.0, -100.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 200.0);
    let z = g.player.pos.z - 10.0;
    wall(&mut g, 0.0, z, 2500.0);
    g.spawn_bullet(g.player.pos, V3::new(0.0, 0.0, -1200.0), Owner::Player);
    g.update_bullets(DT);
    assert!(g.bullets.iter().all(|b| b.life <= 0.0));
    g.launch_missile(g.player.pos, g.player.vel, Track::Bot(0), Owner::Player);
    g.update_missiles(DT);
    assert!(g.missiles[0].track == Track::None);
}

#[test]
fn infrared_locks_do_not_trigger_the_radar_warning_receiver() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.5);
    let at = g.player.pos.add(V3::new(0.0, 0.0, 1500.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 200.0);
    g.bots[0].lock = 1.0;
    g.bots[0].locking_player = true;
    assert_eq!(g.threats().0, 0.0);
    g.ground[0].alive = true;
    g.ground[0].lock = 0.8;
    assert_eq!(g.threats().0, 0.8);
}

#[test]
fn infrared_flares_cannot_seduce_a_radar_guided_sam() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.0);
    g.launch_radar_missile(g.player.pos.add(V3::new(0.0, 0.0, 1500.0)), g.player.vel, Track::Player, Owner::Bot);
    for _ in 0..50 { g.drop_flare(g.player.pos, g.player.vel, 0.0, Track::Player); }
    assert!(g.missiles[0].track == Track::Player);
}

#[test]
fn difficulty_changes_pilot_skill_without_changing_aircraft_or_stores() {
    for difficulty in 0..DIFFICULTY.len() {
        let mut g = calm(F16);
        g.difficulty = difficulty;
        g.wave = 3;
        g.spawn_wave();
        for b in g.bots.iter().filter(|b| b.alive) {
            assert_eq!(b.hp, STATS[b.ty].hp);
            assert_eq!(b.max_hp, STATS[b.ty].hp);
            assert_eq!(b.ammo, STATS[b.ty].rounds);
            assert_eq!(b.missiles, STATS[b.ty].missiles);
            assert_eq!(b.flares, STATS[b.ty].flares);
            assert_eq!(b.fuel, START_FUEL);
        }
    }
}

#[test]
fn bots_consume_fuel_and_a_dry_tank_flames_out() {
    let mut g = calm(F16);
    enemy(&mut g, 0, F16, V3::new(0.0, 3000.0, 0.0), V3::new(0.0, 0.0, -1.0), 200.0);
    g.bots[0].fuel = 0.0001;
    g.bots[0].engine = 1.0;
    for _ in 0..(10.0 / DT) as usize { g.update_bots(DT); }
    assert_eq!(g.bots[0].fuel, 0.0);
    assert!(g.bots[0].engine < 0.05);
    assert!(g.bots[0].landing || !g.bots[0].alive, "fuel-starved bot did not attempt to return");
}

#[test]
fn bots_can_exhaust_their_cannon_and_do_not_get_free_ammunition() {
    let mut g = airborne(F16, 2000.0, 200.0, 0.5);
    let at = g.player.pos.add(V3::new(0.0, 0.0, 500.0));
    enemy(&mut g, 0, F16, at, V3::new(0.0, 0.0, -1.0), 200.0);
    g.bots[0].ammo = 1.0;
    g.bots[0].missiles = 0.0;
    g.update_bots(DT);
    assert_eq!(g.bots[0].ammo, 0.0);
    let shots = g.bullets.iter().filter(|b| b.life > 0.0).count();
    assert_eq!(shots, 1);
    assert_eq!(g.bullets.iter().find(|b| b.life > 0.0).unwrap().rounds, 1.0);
    for _ in 0..120 { g.update_bots(DT); }
    assert_eq!(g.bots[0].ammo, 0.0);
    assert_eq!(g.bullets.iter().filter(|b| b.life > 0.0).count(), shots);
    assert!(g.bots[0].landing);
}

#[test]
fn identical_hits_have_the_same_hull_and_system_effects_for_player_and_bot() {
    let mut human = calm(F16);
    let mut ai = calm(F16);
    ai.bots[0] = Bot::spawn(F16, V3::default(), V3::new(0.0, 0.0, -1.0), 200.0, STATS[F16].hp);
    let at = human.player.pos;
    human.damage_player(20.0, at, true);
    ai.damage_bot(0, 20.0, at);
    assert_eq!(human.player.hp, ai.bots[0].hp);
    assert_eq!(human.player.engine_health, ai.bots[0].engine_health);
    assert_eq!(human.player.control_health, ai.bots[0].control_health);
    assert_eq!(human.player.fuel_leak, ai.bots[0].fuel_leak);
}

#[test]
fn enemy_and_player_cannon_rounds_do_the_same_damage_at_every_difficulty() {
    for difficulty in 0..DIFFICULTY.len() {
        let mut g = airborne(F16, 2000.0, 200.0, 0.5);
        g.difficulty = difficulty;
        let at = V3::new(0.0, 2000.0, 0.0);
        g.bots[0] = Bot::spawn(F16, at, V3::new(0.0, 0.0, -1.0), 200.0, STATS[F16].hp);
        let velocity = V3::new(0.0, 0.0, -1200.0);
        g.spawn_bullet(at.add(V3::new(0.0, 0.0, 10.0)), velocity, Owner::Player);
        g.update_bullets(DT);
        g.player.pos = at.add(V3::new(100.0, 0.0, 0.0));
        g.spawn_bullet(g.player.pos.add(V3::new(0.0, 0.0, 10.0)), velocity, Owner::Bot);
        g.update_bullets(DT);
        assert_eq!(g.player.hp, g.bots[0].hp);
        assert_eq!(g.player.hp, STATS[F16].hp - BULLET_DAMAGE);
    }
}

#[test]
fn a_returning_bot_can_complete_a_configured_runway_touchdown() {
    let mut g = calm(F16);
    g.environment.flat = false;
    g.bots[0] = Bot::spawn(F16, V3::new(-40.0, 20.0, 900.0), V3::new(0.0, 0.0, -1.0), 75.0, STATS[F16].hp);
    let b = &mut g.bots[0];
    b.landing = true; b.return_stage = 2;
    b.gear_down = true; b.gear_position = 1.0;
    b.flaps = 0.5; b.flap_command = 0.5;
    b.vel = V3::new(0.0, -3.0, -75.0);
    b.q = Q::look(V3::new(0.0, 0.07, -1.0).norm(), UP);
    for _ in 0..(15.0 / DT) as usize {
        g.update_bots(DT);
        if !g.bots[0].alive { break; }
    }
    let b = g.bots[0];
    assert!(!b.alive && g.kills == 0.0, "return failed: alive {}, kills {}, position ({}, {}, {}), speed {}, sink {}, gear {}, bank-up {}", b.alive, g.kills, b.pos.x, b.pos.y, b.pos.z, b.speed, b.vel.y, b.gear_position, b.q.rotate(UP).y);
}

#[test]
fn low_fuel_bots_fly_the_return_route_and_land_without_in_flight_refuelling() {
    for (x, y, z) in [(800.0, 600.0, 8000.0), (2000.0, 1500.0, -1000.0)] {
        let mut g = calm(F16);
        g.environment.flat = false;
        g.bots[0] = Bot::spawn(F16, V3::new(x, y, z), V3::new(0.0, 0.0, -1.0), 150.0, STATS[F16].hp);
        g.bots[0].fuel = 0.14;
        // A stable approach may require another circuit; the finite tank still
        // bounds the sortie, and no in-flight servicing is permitted.
        for _ in 0..(600.0 / DT) as usize {
            g.update_bots(DT);
            assert!(g.bots[0].fuel <= 0.14, "bot refuelled in flight");
            if !g.bots[0].alive { break; }
        }
        let b = g.bots[0];
        assert!(!b.alive && g.kills == 0.0, "return from ({x}, {y}, {z}) failed: alive {}, kills {}, stage {}, at ({}, {}, {}), speed {}, sink {}, fuel {}, engine {}", b.alive, g.kills, b.return_stage, b.pos.x, b.pos.y, b.pos.z, b.speed, b.vel.y, b.fuel, b.engine);
        let offset = b.pos.sub(RUNWAY_CENTER);
        assert!(offset.dot(runway_dir().cross(UP)).abs() < 10.0 && offset.dot(runway_dir()).abs() < RUNWAY_LENGTH * 0.5,
            "bot touched down outside runway: ({}, {}, {})", b.pos.x, b.pos.y, b.pos.z);
    }
}

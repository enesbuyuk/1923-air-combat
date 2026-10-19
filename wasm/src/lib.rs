//! 1923 Air Combat - game simulation core compiled to WebAssembly.
//!
//! World frame: +X east, +Y up, -Z north (matches three.js).
//! Aircraft local frame: -Z forward (nose), +Y up, +X right wing.
//! JS reads state through raw pointers into linear memory (see `*_ptr` exports and
//! `layout.rs` for the record formats).

#![allow(static_mut_refs)]

mod config;
mod entities;
mod environment;
mod game;
mod layout;
mod math;

use config::{DIFFICULTY, RUNWAY_HEADING_DEG, RUNWAY_LENGTH, RUNWAY_WIDTH, STATS};
use entities::{Input, Track};
use game::Game;
use layout::{MAX_BOTS, MAX_BULLETS, MAX_FLARES, MAX_GROUND, MAX_MISSILES};
use math::{clamp, V3};

// WASM is single-threaded, so one global game instance is safe.
static mut GAME: Option<Box<Game>> = None;

fn game() -> &'static mut Game {
    unsafe { GAME.get_or_insert_with(|| Box::new(Game::new(0, 1))) }
}

/// Starts a new game with aircraft type `aircraft`. Resets density and difficulty.
#[no_mangle]
pub extern "C" fn init(aircraft: i32, seed: u32) {
    let ty = (aircraft.max(0) as usize).min(STATS.len() - 1);
    unsafe {
        let world = GAME.as_mut().map(|g| std::mem::take(&mut g.environment));
        let mut fresh = Box::new(Game::new(ty, seed));
        if let Some(world) = world { fresh.environment = world; }
        GAME = Some(fresh);
    }
    game().write_out();
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_input(pitch: f32, roll: f32, yaw: f32, throttle: f32, gun: i32, missile: i32, brake: i32, flare: i32) {
    game().input = Input {
        pitch: clamp(pitch, -1.0, 1.0),
        roll: clamp(roll, -1.0, 1.0),
        yaw: clamp(yaw, -1.0, 1.0),
        throttle,
        gun: gun != 0,
        missile: missile != 0,
        brake: brake != 0,
        flare: flare != 0,
    };
}

/// Game mode: 0 waves, 1 strike, 2 escort, 3 free flight. Restarts the mission objectives; like the
/// density, `init` resets it to waves.
#[no_mangle]
pub extern "C" fn set_mode(mode: i32) {
    game().set_mode(game::Mode::from_index(mode));
    game().write_out();
}

#[no_mangle]
pub extern "C" fn step(dt: f32) {
    game().step(dt);
}

/// Enemy density multiplier (0.25..3); applies from the next wave and survives `init`
/// only if the caller sets it again.
#[no_mangle]
pub extern "C" fn set_enemy_density(d: f32) {
    game().density = clamp(d, 0.25, 3.0);
}

/// Enemy pilot skill only: 0 easy, 1 medium, 2 hard.
#[no_mangle]
pub extern "C" fn set_difficulty(level: i32) {
    game().difficulty = level.clamp(0, DIFFICULTY.len() as i32 - 1) as usize;
}

#[no_mangle]
pub extern "C" fn toggle_gear() -> i32 {
    let p = &mut game().player;
    if !p.alive || p.on_ground { return 0; }
    p.gear_down = !p.gear_down;
    game().write_out();
    1
}
#[no_mangle]
pub extern "C" fn cycle_flaps() {
    let p = &mut game().player;
    if p.alive { p.flap_command = if p.flap_command < 0.25 { 0.5 } else if p.flap_command < 0.75 { 1.0 } else { 0.0 }; }
    game().write_out();
}
#[no_mangle]
pub extern "C" fn terrain_height(x: f32, z: f32) -> f32 { environment::height(x, z) }
#[no_mangle]
pub extern "C" fn terrain_surface(x: f32, z: f32) -> i32 { environment::surface(x, z) as i32 }
#[no_mangle]
pub extern "C" fn line_of_sight(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32) -> i32 {
    game().environment.clear_line(V3::new(ax, ay, az), V3::new(bx, by, bz)) as i32
}
#[no_mangle]
pub extern "C" fn obstacle_buffer_ptr() -> *mut f32 { game().obstacle_import.as_mut_ptr() }
#[no_mangle]
pub extern "C" fn clear_obstacles(dynamic: i32) {
    let e = &mut game().environment;
    if dynamic != 0 { e.dynamic_obstacles.clear(); } else { e.static_obstacles.clear(); }
}
/// Buffer: vertex count, bottom, top, then x/z pairs (at most 512 vertices).
#[no_mangle]
pub extern "C" fn add_obstacle(dynamic: i32) {
    let g = game();
    let count = g.obstacle_import[0] as usize;
    if !(3..=512).contains(&count) { return; }
    let points = g.obstacle_import[3..3 + count * 2].chunks_exact(2).map(|p| (p[0], p[1])).collect();
    let (bottom, top) = (g.obstacle_import[1], g.obstacle_import[2]);
    let obstacles = if dynamic != 0 { &mut g.environment.dynamic_obstacles } else { &mut g.environment.static_obstacles };
    obstacles.add(points, bottom, top);
}

/// Metres down the runway from the usual start point where the player spawns (online
/// rooms give every pilot their own spot). Moves an aircraft still waiting at the start.
#[no_mangle]
pub extern "C" fn set_spawn_offset(metres: f32) {
    let g = game();
    g.spawn_offset = clamp(metres, 0.0, RUNWAY_LENGTH * 0.5);
    let p = &g.player;
    if p.alive && p.on_ground && p.speed < 1.0 {
        g.spawn_player();
    }
    g.write_out();
}

#[no_mangle]
pub extern "C" fn remote_buffer_ptr() -> *mut f32 { game().remote_import.as_mut_ptr() }
/// Poses bot slot `slot` as another online pilot from the remote buffer (`layout::remote`).
#[no_mangle]
pub extern "C" fn set_remote(slot: i32, live: i32) {
    if slot >= 0 { game().set_remote(slot as usize, live != 0); }
}
#[no_mangle]
pub extern "C" fn clear_remote(slot: i32) {
    if slot >= 0 { game().clear_remote(slot as usize); }
}
/// Cannon damage dealt to the online pilot in `slot` since the last call.
#[no_mangle]
pub extern "C" fn take_remote_damage(slot: i32) -> f32 {
    if slot < 0 { 0.0 } else { game().take_remote_damage(slot as usize) }
}
/// Damage another online pilot dealt to the player.
#[no_mangle]
pub extern "C" fn remote_hit(damage: f32) {
    game().remote_hit(damage);
}
/// A missile fired by another online pilot. `target`: -2 the player, a bot slot, or -1 none.
#[no_mangle]
pub extern "C" fn remote_missile(x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, target: i32) {
    let track = match target {
        -2 => Track::Player,
        t if (0..layout::MAX_BOTS as i32).contains(&t) => Track::Bot(t as usize),
        _ => Track::None,
    };
    game().launch_remote_missile(V3::new(x, y, z), V3::new(vx, vy, vz), track);
}
#[no_mangle]
pub extern "C" fn remote_flare(slot: i32) {
    if slot >= 0 { game().remote_flare(slot as usize); }
}

/// See `Game::building_hit`. Output buffers are refreshed so JS sees the result at once.
#[no_mangle]
pub extern "C" fn building_hit(x: f32, y: f32, z: f32, nx: f32, nz: f32, depth: f32) -> i32 {
    let g = game();
    let result = g.building_hit(V3::new(x, y, z), nx, nz, depth);
    g.write_out();
    result
}

#[no_mangle]
pub extern "C" fn player_ptr() -> *const f32 {
    game().out_player.as_ptr()
}
#[no_mangle]
pub extern "C" fn bots_ptr() -> *const f32 {
    game().out_bots.as_ptr()
}
#[no_mangle]
pub extern "C" fn bullets_ptr() -> *const f32 {
    game().out_bullets.as_ptr()
}
#[no_mangle]
pub extern "C" fn missiles_ptr() -> *const f32 {
    game().out_missiles.as_ptr()
}
#[no_mangle]
pub extern "C" fn flares_ptr() -> *const f32 {
    game().out_flares.as_ptr()
}
#[no_mangle]
pub extern "C" fn ground_ptr() -> *const f32 {
    game().out_ground.as_ptr()
}
#[no_mangle]
pub extern "C" fn events_ptr() -> *const f32 {
    game().out_events.as_ptr()
}
#[no_mangle]
pub extern "C" fn stats_ptr() -> *const f32 {
    game().out_stats.as_ptr()
}
#[no_mangle]
pub extern "C" fn max_bots() -> i32 {
    MAX_BOTS as i32
}
#[no_mangle]
pub extern "C" fn max_bullets() -> i32 {
    MAX_BULLETS as i32
}
#[no_mangle]
pub extern "C" fn max_missiles() -> i32 {
    MAX_MISSILES as i32
}
#[no_mangle]
pub extern "C" fn max_flares() -> i32 {
    MAX_FLARES as i32
}
#[no_mangle]
pub extern "C" fn max_ground() -> i32 {
    MAX_GROUND as i32
}

/// Writes heading_deg, length, width of the main runway to `out`.
///
/// # Safety
/// `out` must point to at least 3 writable `f32`s in linear memory.
#[no_mangle]
pub unsafe extern "C" fn runway_info(out: *mut f32) {
    unsafe {
        *out = RUNWAY_HEADING_DEG;
        *out.add(1) = RUNWAY_LENGTH;
        *out.add(2) = RUNWAY_WIDTH;
    }
}

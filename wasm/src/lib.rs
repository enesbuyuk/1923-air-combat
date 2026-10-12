//! 1923 Air Combat - game simulation core compiled to WebAssembly.
//!
//! World frame: +X east, +Y up, -Z north (matches three.js).
//! Aircraft local frame: -Z forward (nose), +Y up, +X right wing.
//! JS reads state through raw pointers into linear memory (see `*_ptr` exports and
//! `layout.rs` for the record formats).

#![allow(static_mut_refs)]

mod config;
mod entities;
mod game;
mod layout;
mod math;

use config::{DIFFICULTY, RUNWAY_HEADING_DEG, RUNWAY_LENGTH, RUNWAY_WIDTH, STATS};
use entities::Input;
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
        GAME = Some(Box::new(Game::new(ty, seed)));
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

/// Game mode: 0 waves, 1 strike, 2 escort. Restarts the mission objectives; like the
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

/// Enemy difficulty: 0 easy, 1 medium, 2 hard. AI and damage change at once, enemy
/// health and speed from the next wave. Like the density, `init` resets it.
#[no_mangle]
pub extern "C" fn set_difficulty(level: i32) {
    game().difficulty = level.clamp(0, DIFFICULTY.len() as i32 - 1) as usize;
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

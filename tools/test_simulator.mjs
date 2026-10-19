// Run after ./build.sh: node --test tools/test_simulator.mjs
// Exercises the actual WebAssembly binary through the browser's simulation wrapper.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Sim } from '../web/js/sim.js';
import { AIRCRAFT } from '../web/js/aircraft.js';
import { footprint } from '../web/js/collision.js';
import { PLAYER, BOT, MISSILE, BULLET, GROUND } from '../web/js/layout.js';

const bytes = await readFile(new URL('../web/1923_air.wasm', import.meta.url));
const stored = new Map([['1923.realism', '0'], ['1923.mode', '3']]);
globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null };
const { applySettings } = await import('../web/js/settings.js');

async function simulation() {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new Sim(instance.exports);
}

test('old saved settings cannot restore arcade rules on a new flight or restart', async () => {
  const sim = await simulation();
  for (let restart = 0; restart < 2; restart++) {
    sim.init(0);
    applySettings(sim);
    assert.equal(sim.player().ammo, 511);
    assert.equal(sim.player().missiles, 6);
    assert.equal(sim.stats().mode, 3);
  }
  assert.equal(typeof sim.wasm.set_realism, 'undefined');
  assert.equal(typeof sim.setRealism, 'undefined');
});

test('every displayed aircraft missile load matches the simulation', async () => {
  const sim = await simulation();
  for (const [type, aircraft] of AIRCRAFT.entries()) {
    sim.init(type);
    applySettings(sim);
    assert.equal(sim.player().maxMissiles, aircraft.missiles, aircraft.name);
    assert.equal(sim.player().missiles, aircraft.missiles, aircraft.name);
  }
  sim.init(2);
  assert.equal(sim.player().ammo, 0);
  assert.equal(sim.player().missiles, 0);
});

test('the simulator takes off and remains stable through the JS/WASM interface', async () => {
  const sim = await simulation();
  sim.init(0);
  applySettings(sim);
  let lifted = false;
  for (let frame = 0; frame < 60 * 30; frame++) {
    const p = sim.player();
    if (!p.onGround && !lifted) {
      lifted = true;
      assert.equal(sim.toggleGear(), true);
    }
    sim.setInput({
      pitch: p.onGround ? Number(p.speed > p.rotateSpeed) : 0.1,
      roll: 0, yaw: 0, throttle: 1, gun: false, missile: false, brake: false, flare: false,
    });
    sim.step(1 / 60);
    assert.equal(sim.player().alive, true, `aircraft lost at frame ${frame}`);
    assert.ok(Number.isFinite(sim.player().y));
  }
  assert.ok(lifted, 'aircraft never lifted off');
  assert.ok(sim.player().y > 60, 'aircraft failed to climb');
  assert.ok(sim.player().gear < 0.03 && sim.player().flaps < 0.03);
  assert.equal(sim.player().gearHealth, 1);
});

test('manual configuration has a ground interlock and actuator travel', async () => {
  const sim = await simulation();
  sim.init(0);
  applySettings(sim);
  assert.equal(sim.player().gear, 1);
  assert.equal(sim.toggleGear(), false);
  assert.equal(sim.player().gearCommand, true);
  assert.equal(sim.player().flapCommand, 0);
  assert.equal(sim.player().flaps, 0);
  sim.cycleFlaps();
  assert.equal(sim.player().flapCommand, 0.5);
  assert.equal(sim.player().flaps, 0);
  sim.step(0.05);
  assert.ok(sim.player().flaps > 0 && sim.player().flaps < 0.1);
});

test('terrain queries, rendering coordinates and physical surface identifiers agree', async () => {
  const sim = await simulation();
  sim.init(0);
  assert.equal(sim.terrainHeight(-40, 500), 0);
  assert.equal(sim.terrainSurface(-40, 500), 0);
  assert.equal(sim.terrainSurface(700, 0), 1);
  assert.equal(sim.terrainSurface(0, 12000), 2);
  assert.ok(sim.terrainHeight(5500, -4000) > 50);
  assert.ok(Math.abs(sim.player().agl - sim.player().y + sim.terrainHeight(sim.player().x, sim.player().z)) < 1e-4);
});

test('imported thin walls block sensors and survive restart and memory growth', async () => {
  const sim = await simulation();
  sim.init(0);
  const visible = () => sim.wasm.line_of_sight(0, 100, 0, 0, 100, -300) > 0;
  assert.equal(visible(), true);
  sim.addObstacle(footprint([[-100, -100.1], [100, -100.1], [100, -99.9], [-100, -99.9]], 200));
  assert.equal(visible(), false);
  sim.wasm.memory.grow(1);
  sim.init(3);
  assert.equal(visible(), false);
  sim.addObstacle(footprint([[-100, -200.1], [100, -200.1], [100, -199.9], [-100, -199.9]], 200), true);
  sim.clearDynamicObstacles();
  assert.equal(visible(), false, 'clearing streamed scenery erased static buildings');
});

test('all expanded buffers decode without overlapping adjacent records', async () => {
  const sim = await simulation();
  sim.init(1);
  assert.equal(sim.playerRaw().length, PLAYER.STRIDE);
  assert.equal(sim.bots().length, sim.maxBots * BOT.STRIDE);
  assert.equal(sim.missiles().length, sim.maxMissiles * MISSILE.STRIDE);
  assert.equal(sim.bullets().length, sim.maxBullets * BULLET.STRIDE);
  assert.equal(sim.ground().length, sim.maxGround * GROUND.STRIDE);
  assert.equal(sim.player().flapHealth, 1);
  assert.equal(sim.player().gearHealth, 1);
});

test('a hangar roof occludes above the bay while the interior stays clear', async () => {
  const sim = await simulation();
  sim.init(0);
  sim.addObstacle(footprint([[-30, -40], [30, -40], [30, 40], [-30, 40]], 14, 13.5));
  assert.equal(sim.wasm.line_of_sight(-20, 2.2, 0, 20, 2.2, 0), 1);
  assert.equal(sim.wasm.line_of_sight(0, 2.2, 0, 0, 30, 0), 0);
});

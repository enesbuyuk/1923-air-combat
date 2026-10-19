// node --test tools/test_gforce.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { GForce } from '../web/js/gforce.js';
import { AIRCRAFT } from '../web/js/aircraft.js';
import { Controls } from '../web/js/input.js';

const fighter = AIRCRAFT[0].gOnset;
const pilot = () => new GForce({ style: {} });
function expose(p, g, seconds, onset = fighter, dt = 1 / 60) {
  for (let i = 0; i < Math.round(seconds / dt); i++) p.update(g, onset, true, dt);
}
function timeToLoc(p, g, dt = 1 / 60, onset = fighter) {
  let elapsed = 0;
  while (!p.unconscious && elapsed < 120) {
    p.update(g, onset, true, dt);
    elapsed += dt;
  }
  assert.equal(p.unconscious, true, 'exposure did not produce G-LOC');
  return elapsed;
}

test('normal flight and a brief 9 G pull preserve consciousness and recover on unloading', () => {
  const p = pilot();
  expose(p, 1, 120);
  assert.equal(p.stress, 0);
  expose(p, 9, 3);
  assert.equal(p.incapacitated, false);
  expose(p, 1, 4);
  assert.equal(p.stress, 0);
  assert.equal(p.incapacitated, false);
});

test('blackout can remove vision while the pilot still has control, before G-LOC', () => {
  const p = pilot();
  expose(p, 9, 12.5);
  assert.equal(p.positive, 1);
  assert.equal(p.unconscious, false);
  assert.equal(p.incapacitated, false);
  p.render();
  assert.match(p.overlay.style.background, /rgba\(0,0,0,1\)/);
  expose(p, 9, 3);
  assert.equal(p.unconscious, true);
  assert.equal(p.incapacitated, true);
});

test('sustained 8 G is no longer tolerated indefinitely, and more G shortens endurance', () => {
  const moderate = timeToLoc(pilot(), 8);
  const hard = timeToLoc(pilot(), 9);
  assert.ok(moderate > 20 && moderate < 35, `${moderate} s at 8 G`);
  assert.ok(hard > 14 && hard < 16, `${hard} s at 9 G`);
  const extreme = timeToLoc(pilot(), 15);
  assert.ok(extreme > 8 && extreme < 11, `${extreme} s at extreme G`);
});

test('G-LOC persists after unloading, followed by a separate period of disorientation', () => {
  const p = pilot();
  timeToLoc(p, 9);
  expose(p, 1, 10);
  assert.equal(p.unconscious, true);
  assert.equal(p.positive, 1);
  expose(p, 1, 1);
  assert.equal(p.unconscious, false);
  assert.equal(p.incapacitated, true);
  assert.ok(p.positive > 0.5 && p.positive < 1);
  expose(p, 1, 12);
  assert.equal(p.incapacitated, false);
  assert.equal(p.stress, 0);
});

test('waiting under continued high G does not wake the pilot', () => {
  const p = pilot();
  timeToLoc(p, 9);
  expose(p, 9, 45);
  assert.equal(p.unconscious, true);
  assert.equal(p.positive, 1);
});

test('negative G darkens the view without a red tint or changing consciousness', () => {
  const p = pilot();
  expose(p, -3, 6);
  assert.ok(p.negative > 0.7);
  assert.equal(p.positive, 0);
  assert.equal(p.incapacitated, false);
  p.render();
  assert.match(p.overlay.style.background, /rgba\(0,0,0,/);
  assert.doesNotMatch(p.overlay.style.background, /rgba\(1[56]0,0,0,/);
  expose(p, 1, 18);
  p.render();
  assert.equal(p.overlay.style.opacity, 0);
});

test('a push-pull reversal reduces subsequent positive-G tolerance temporarily', () => {
  const rested = pilot();
  const reversed = pilot();
  expose(reversed, -2, 4);
  expose(rested, 8, 6);
  expose(reversed, 8, 6);
  assert.ok(reversed.positive > rested.positive + 0.1);
  expose(reversed, 1, 60);
  assert.ok(reversed.pushPull < 0.001);
});

test('the unprotected profile develops symptoms earlier than protected fighter crew', () => {
  const protectedPilot = pilot();
  const unprotectedPilot = pilot();
  expose(protectedPilot, 6, 8);
  expose(unprotectedPilot, 6, 8, AIRCRAFT[2].gOnset);
  assert.equal(protectedPilot.stress, 0);
  assert.ok(unprotectedPilot.stress > 0);
});

test('exposure timing is stable across update rates and does not advance during a pause', () => {
  const durations = [30, 60, 144].map((hz) => timeToLoc(pilot(), 9, 1 / hz));
  assert.ok(Math.max(...durations) - Math.min(...durations) < 0.04);
  const p = pilot();
  timeToLoc(p, 9);
  const remaining = p.locRemaining;
  for (let i = 0; i < 120; i++) p.update(1, fighter, true, 0);
  assert.equal(p.locRemaining, remaining);
  assert.equal(p.unconscious, true);
});

test('death and new-flight reset clear vision, incapacitation and exposure history', () => {
  for (const died of [false, true]) {
    const p = pilot();
    timeToLoc(p, 9);
    p.render();
    if (died) p.update(1, fighter, false, 1 / 60);
    else p.reset();
    assert.equal(p.stress, 0);
    assert.equal(p.incapacitated, false);
    assert.equal(p.pushPull, 0);
    assert.equal(p.overlay.style.opacity, 0);
  }
});

test('incapacitation releases controls, holds throttle and prevents weapon or brake commands', () => {
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = () => ({ matches: false });
  const c = new Controls({ inGame: () => true, flying: () => true, onKey: () => {} });
  c.throttle = 0.7;
  c.pitch = 1;
  for (const code of ['KeyS', 'KeyD', 'KeyQ', 'ShiftLeft', 'Space', 'KeyC', 'KeyB']) c.keys.add(code);
  c.touch.throttleSet = 1;
  c.missileQueued = true;
  c.update(1, true);
  const disabled = { ...c.consume() };
  assert.ok(Math.abs(disabled.pitch) < 0.01);
  assert.equal(disabled.roll, 0);
  assert.equal(disabled.yaw, 0);
  assert.equal(disabled.throttle, 0.7);
  for (const field of ['gun', 'missile', 'flare', 'brake']) assert.equal(disabled[field], false, field);
  c.update(1, false);
  const recovered = c.consume();
  assert.ok(recovered.pitch > 0.9);
  assert.equal(recovered.gun, true);
  assert.equal(recovered.brake, true);
  assert.equal(recovered.missile, false, 'queued weapon fired after recovery');
});

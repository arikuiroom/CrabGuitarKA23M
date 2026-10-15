import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFreeMode, freeStrings } from '../../src/free-mode.js';
import { fixture, beats, chords, close, midiOf } from './fixture.mjs';

test('silent initial state, concurrent starts share one clock; 100 cycles have no drift', async () => {
  const f = fixture(); assert(!f.mode.active); assert.equal(f.timers.size, 0);
  await Promise.all(Array.from({ length: 100 }, () => f.mode.start()));
  assert.deepEqual(f.changes, [[true]]);
  const end = 160 + 100 * 32 * beats.red;
  f.until(end); close(f.due, end);
  assert.equal(f.leads.length, 1600);
  assert(f.leads.every(n => n.i === 5 && n.v >= .44 && n.v <= .54));
  assert.equal(f.hits.length, 1600);
  f.mode.stop(); assert.equal(f.timers.size, 0); assert.deepEqual(f.changes, [[true], [false]]);
});

test('jitter and callback work do not move the absolute drum grid or accumulate drift', async () => {
  let f;
  f = fixture({ play: () => f.addTime(11) });
  await f.mode.start();
  for (let i = 0; i < 1000; i++) f.next(i % 3 === 0 ? 7 : 0);
  // The first callback is 7 ms late and establishes this session's origin.
  for (const hit of f.hits) {
    const phase = (hit.time - 167) % 130;
    assert(phase < .001 || Math.abs(phase - 7) < .001);
  }
  assert(f.due > f.time); assert.equal(f.timers.size, 1); f.mode.stop();
});

test('lag skips elapsed events without bursts and returns to original deadlines', async () => {
  const f = fixture(); await f.mode.start(); f.next();
  const before = f.notes.length, hits = f.hits.length;
  f.next(10000);
  assert(f.notes.length <= before + 1); assert(f.hits.length <= hits + 3);
  assert(f.due > f.time);
  // Continue to a whole A/B boundary: the stall has not shifted it.
  f.until(160 + 32 * beats.red); close(f.due, 160 + 32 * beats.red);
  f.next(); close(f.hits.at(-1).time, 160 + 32 * beats.red);
  assert.equal(f.timers.size, 1); f.mode.stop();
});

test('a multi-hour stall skips in constant space without melodic catch-up', async () => {
  const f = fixture(); await f.mode.start(); f.next();
  f.next(12 * 60 * 60 * 1000);
  assert(f.leads.length <= 1); assert(f.hits.length <= 4); assert(f.due > f.time);
  for (let i = 0; i < 100; i++) f.next();
  assert(f.leads.length < 20); assert.equal(f.timers.size, 1); f.mode.stop();
});

test('holds skip both instruments, retain ON, and do not accumulate catch-up', async () => {
  const f = fixture(); await f.mode.start(); f.nextNote();
  f.setAllowed(false); const hits = f.hits.length, notes = f.notes.length;
  for (let i = 0; i < 100; i++) f.next();
  assert.equal(f.notes.length, notes); assert.equal(f.hits.length, hits);
  assert(f.mode.active); assert(f.silences >= 100);
  f.setAllowed(true); f.nextNote(); assert.equal(f.leads.length, 2); f.mode.stop();
});

test('pause and OFF cancel clock; stale callbacks cannot alter a newer timer', async () => {
  const f = fixture(); await f.mode.start(); f.nextNote();
  const stale = f.timers.values().next().value.fn;
  f.mode.pause(); assert(f.mode.active && f.mode.paused); assert.equal(f.timers.size, 0);
  stale(); assert.equal(f.leads.length, 1);
  await f.mode.start(); const newTimer = [...f.timers.keys()][0]; stale();
  assert.deepEqual([...f.timers.keys()], [newTimer]);
  f.nextNote(); assert.equal(f.leads.length, 2); f.mode.stop();
  assert(!f.mode.active); assert.equal(f.timers.size, 0);
});

test('stop from a melody or percussion callback aborts the remaining event and timer', async () => {
  let f;
  f = fixture({ percussion: () => f.mode.stop() });
  await f.mode.start(); f.next(); assert(!f.mode.active); assert.equal(f.timers.size, 0);
  f = fixture({ play: () => f.mode.stop() });
  await f.mode.start(); f.next(); f.next(); f.next();
  assert(!f.mode.active); assert.equal(f.timers.size, 0);
});

test('old unlock completion/rejection cannot revive stopped or newer sessions', async () => {
  const pending = [];
  const f = fixture({ unlock: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const first = f.mode.start(); f.mode.stop(); const second = f.mode.start();
  pending[0].reject(Error('stale')); await first; assert.equal(f.errors.length, 0);
  pending[1].resolve(); await second; assert.equal(f.timers.size, 1); f.mode.stop();
  const third = f.mode.start(); f.mode.stop(); pending[2].resolve(); await third;
  assert.equal(f.timers.size, 0);
});

test('blocked start, unlock failure and 500 rapid toggles leave no timers', async () => {
  let allowed = false;
  const f = fixture({ canStart: () => allowed, unlock: async () => { throw Error('blocked'); } });
  await f.mode.start(); assert.deepEqual(f.changes, []);
  allowed = true; await f.mode.start(); assert.equal(f.errors.length, 1); assert(!f.mode.active);
  const g = fixture();
  for (let i = 0; i < 500; i++) {
    await g.mode.start(); const stale = g.timers.values().next().value.fn;
    g.mode.stop(); stale(); assert.equal(g.timers.size, 0);
  }
});

test('500 color/chord changes reset on one clock, with immediate backing and a short pickup', async () => {
  const f = fixture(); await f.mode.start();
  for (let i = 0; i < 500; i++) {
    const preset = Object.keys(beats)[i % 5], chord = Object.keys(chords)[i % 5];
    f.setPreset(preset); f.setChord(chord); f.next();
    const origin = f.time;
    close(f.hits.at(-1).time, origin);
    assert.equal(f.timers.size, 1);
    f.nextNote();
    assert.equal(f.leads.at(-1).i, 5);
    close(f.leads.at(-1).time, origin + .135 / 6.2 * 16 * beats[preset]);
  }
  f.mode.stop(); assert.equal(f.timers.size, 0);
});

test('chord changes transpose the next note without resetting the A/B clock', async () => {
  const f = fixture(); await f.mode.start(); f.nextNote();
  assert.equal(midiOf(f.leads[0].frequency), 67);
  f.setChord('G'); f.nextNote();
  assert.equal(midiOf(f.leads[1].frequency), 62);
  close(f.leads[1].time, 160 + .530 / 6.2 * 16 * beats.red);
  f.mode.stop();
});

test('missing playable strings stop cleanly; optional callbacks default to C without support', async () => {
  const f = fixture({ getStrings: () => [] }); await f.mode.start(); f.next();
  assert(!f.mode.active); assert.equal(f.timers.size, 0); assert.equal(f.notes.length, 0);
  const g = fixture({ getChord: undefined, getSupportStrings: undefined });
  g.setPreset('black'); await g.mode.start(); g.nextNote();
  assert.equal(midiOf(g.leads[0].frequency), 67); assert.equal(g.support.length, 0); g.mode.stop();
  // The public factory still accepts the original minimal callback interface.
  assert.equal(typeof createFreeMode({ getStrings: () => [5], play() {}, unlock() {}, canPlay: () => true }).start, 'function');
});

test('freeStrings retains actual lowest root/fifth support for all chord voicings', () => {
  const expected = { open: [0, 4], C: [1, 3], G: [0, 2], Am: [1, 2], Em: [0, 1] };
  for (const [chord, frets] of Object.entries(chords)) assert.deepEqual(freeStrings(chord, frets, 'black'), expected[chord]);
});

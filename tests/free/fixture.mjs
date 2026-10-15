import assert from 'node:assert/strict';
import { createFreeMode, freeStrings } from '../../src/free-mode.js';

export const beats = { red: 520, mint: 440, black: 380, darkbrown: 620, redbrown: 540 };
export const chords = {
  open: [0, 0, 0, 0, 0, 0], C: [null, 3, 2, 0, 1, 0],
  G: [3, 2, 0, 0, 0, 3], Am: [null, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0]
};
export const midiOf = frequency => Math.round(69 + 12 * Math.log2(frequency / 440));
export const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-7, `${message || 'number'}: ${actual} != ${expected}`);
export function fixture(overrides = {}) {
  let time = 0, id = 0, allowed = true, preset = 'red', chord = 'C', silences = 0;
  const timers = new Map(), notes = [], hits = [], changes = [], errors = [];
  const mode = createFreeMode({
    unlock: async () => {}, now: () => time, random: () => .5,
    play: (i, v, gate, frequency) => notes.push({ i, v, gate, frequency, time }),
    percussion: (kind, level) => hits.push({ kind, level, time }), silence: () => silences++,
    canPlay: () => allowed, getPreset: () => preset, getChord: () => chord,
    getStrings: color => freeStrings(chord, chords[chord], color),
    getSupportStrings: () => freeStrings(chord, chords[chord], 'black'),
    onChange: (...args) => changes.push(args), onError: error => errors.push(error),
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id), ...overrides
  });
  function next(late = 0) {
    assert.equal(timers.size, 1, 'one shared pending timer');
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); time = timer.at + late; timer.fn();
  }
  return {
    mode, timers, notes, hits, changes, errors,
    get silences() { return silences; }, get time() { return time; },
    get leads() { return notes.filter(note => note.frequency !== undefined); },
    get support() { return notes.filter(note => note.frequency === undefined); },
    get due() { return timers.values().next().value?.at; },
    setAllowed: value => allowed = value, setPreset: value => preset = value, setChord: value => chord = value,
    addTime: value => time += value, next,
    until(end) {
      let count = 0;
      while (timers.size && timers.values().next().value.at < end - 1e-7) {
        next(); assert(++count < 100000, 'bounded timer progress');
      }
    },
    nextNote() {
      const before = notes.filter(note => note.frequency !== undefined).length;
      for (let i = 0; i < 200 && notes.filter(note => note.frequency !== undefined).length === before; i++) next();
      assert(notes.filter(note => note.frequency !== undefined).length > before, 'next melody is reachable');
    }
  };
}

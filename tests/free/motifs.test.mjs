import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFreeMode, freeStrings, rhythmAt } from '../../src/free-mode.js';

const intervals = { red: 130, mint: 110, black: 95, darkbrown: 155, redbrown: 135 };
const presets = Object.keys(intervals);
const chords = {
  open: [0, 0, 0, 0, 0, 0], C: [null, 3, 2, 0, 1, 0],
  G: [3, 2, 0, 0, 0, 3], Am: [null, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0]
};
async function record(preset, { ticks = 512, strings = [0, 1, 2, 3], random = () => .5 } = {}) {
  let time = 0, id = 0;
  const timers = new Map(), notes = [], hits = [];
  const tickAt = () => (time - 160) / intervals[preset];
  const mode = createFreeMode({
    unlock: async () => {}, canPlay: () => true, getPreset: () => preset, getStrings: () => strings,
    random, now: () => time,
    play: (position, velocity, gate) => notes.push({ tick: tickAt(), position, velocity, gate }),
    percussion: (kind, level) => hits.push({ tick: tickAt(), kind, level }),
    setTimer: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id)
  });
  await mode.start();
  for (let tick = 0; tick < ticks; tick++) {
    assert.equal(timers.size, 1, `${preset}: one shared clock`);
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); time = timer.at; timer.fn();
  }
  const nextTime = timers.values().next().value.at;
  mode.stop(); assert.equal(timers.size, 0);
  return { notes, hits, nextTime };
}
function section(notes, start, length = 16) {
  return notes.filter(n => n.tick >= start && n.tick < start + length)
    .map(n => ({ ...n, tick: n.tick - start }));
}

for (const preset of presets) {
  test(`${preset}: four-bar A A A′ B hook repeats, with a small fourth-cycle answer variation`, async () => {
    const { notes } = await record(preset);
    const base = section(notes, 0, 64), variation = section(notes, 192, 64);
    assert.deepEqual(section(notes, 0), section(notes, 16), 'A repeats exactly');
    assert.notDeepEqual(section(notes, 0), section(notes, 32), 'A′ is a recognizable turn');
    assert.deepEqual(section(notes, 0, 8), section(notes, 32, 8), 'A′ preserves the opening half');
    assert.notDeepEqual(section(notes, 32), section(notes, 48), 'B answers the turn');
    for (const cycle of [1, 2, 4, 5, 6]) {
      assert.deepEqual(section(notes, cycle * 64, 64), base, `cycle ${cycle + 1} repeats the hook`);
    }
    assert.notDeepEqual(variation, base, 'the fourth cycle has a deliberate variation');
    assert.deepEqual(section(notes, 192, 48), section(notes, 0, 48), 'variation only changes B');
    assert.deepEqual(section(notes, 448, 64), variation, 'the variation is deterministic every four cycles');
    const answer = section(notes, 48), changedAnswer = section(notes, 240);
    assert(Math.abs(answer.length - changedAnswer.length) <= 2, 'answer changes only a few notes');
    assert.equal(answer.at(-1).position, 0, 'the answer resolves to the lowest chord tone');
    assert.equal(changedAnswer.at(-1).position, 0, 'the varied answer keeps its cadence');
  });
  test(`${preset}: integer grid, aligned bars, breathing space and natural final notes`, async () => {
    const { notes, hits, nextTime } = await record(preset);
    assert.equal(nextTime, 160 + 512 * intervals[preset], 'no drift across eight four-bar cycles');
    assert(notes.every(n => Number.isInteger(n.tick) && Number.isInteger(n.position) && n.position >= 0 && n.position <= 3));
    for (let bar = 0; bar < 32; bar++) {
      const phrase = section(notes, bar * 16);
      assert.equal(phrase[0].tick, 0, `bar ${bar + 1} begins on its downbeat`);
      assert(phrase.every(n => n.tick < 14), 'the final two ticks are an explicit rest');
      assert.equal(phrase.at(-1).gate, undefined, 'final note decays naturally into the rest');
    }
    const expectedHits = Array.from({ length: 512 }, (_, tick) => rhythmAt(preset, tick)
      .map(([kind, level]) => ({ tick, kind, level }))).flat();
    assert.deepEqual(hits, expectedHits, 'backing beat stays on the same uninterrupted sixteenth grid');
    // Red/classical backing taps intentionally coincide with their straight
    // melody. The syncopated colors also put backing hits in guitar gaps.
    if (['mint', 'black', 'redbrown'].includes(preset)) {
      assert(hits.some(hit => !notes.some(note => note.tick === hit.tick)), 'backing continues in guitar rests');
    }
    if (preset === 'mint' || preset === 'black') {
      assert(notes.some(n => n.gate === (preset === 'mint' ? .12 : .17)), 'short notes keep rhythmic articulation');
    } else assert(notes.every(n => n.gate === undefined));
  });
}

test('all five hooks have distinct signatures and rhythms, with mostly neighboring pitch steps', async () => {
  const pitches = new Set(), rhythms = new Set();
  for (const preset of presets) {
    const { notes } = await record(preset, { ticks: 256 });
    pitches.add(notes.slice(0, 5).map(n => n.position).join(','));
    rhythms.add(notes.map(n => n.tick).join(','));
    assert(notes.filter(n => n.tick * intervals[preset] < 6000).length >= 5);
    const jumps = notes.slice(1).map((n, i) => Math.abs(n.position - notes[i].position));
    if (preset === 'black') assert(notes.every(n => n.position === 0 || n.position === 3));
    else {
      assert(Math.max(...jumps) <= 2, `${preset}: no full-palette leap`);
      assert(jumps.filter(jump => jump <= 1).length / jumps.length > .95, `${preset}: almost all notes move by one step or repeat`);
    }
    assert(notes.every((n, i) => !i || (n.tick - notes[i - 1].tick) * intervals[preset] < 3300));
  }
  assert.equal(pitches.size, 5); assert.equal(rhythms.size, 5);
});

test('every repeated and varied note stays in the selected chord; black stays on its lowest root/fifth', async () => {
  const openMidi = [40, 45, 50, 55, 59, 64];
  const chordTones = { open: [4, 7, 11], C: [0, 4, 7], G: [7, 11, 2], Am: [9, 0, 4], Em: [4, 7, 11] };
  const powerStrings = { open: [0, 4], C: [1, 3], G: [0, 2], Am: [1, 2], Em: [0, 1] };
  for (const [chord, frets] of Object.entries(chords)) for (const preset of presets) {
    const strings = freeStrings(chord, frets, preset);
    const { notes } = await record(preset, { ticks: 256, strings });
    assert(notes.every(n => strings.includes(n.position)), `${chord}/${preset}: only playable strings`);
    assert(notes.every(n => chordTones[chord].includes((openMidi[n.position] + frets[n.position]) % 12)), `${chord}/${preset}: every pitch belongs to the chord`);
    if (preset === 'black') {
      assert.deepEqual(strings, powerStrings[chord]);
      assert(notes.every(n => powerStrings[chord].includes(n.position)));
      assert(notes.some(n => n.position === powerStrings[chord][1]), 'riff includes its fifth');
      assert.equal(notes.at(-1).position, powerStrings[chord][0], 'varied riff cadences on its low root');
    }
  }
});

test('random touch never changes pitches, rests, gates or variation timing', async () => {
  for (const preset of presets) {
    const soft = await record(preset, { ticks: 256, random: () => 0 });
    const loud = await record(preset, { ticks: 256, random: () => 1 });
    const withoutVelocity = ({ velocity, ...note }) => note;
    assert.deepEqual(soft.notes.map(withoutVelocity), loud.notes.map(withoutVelocity));
    assert.deepEqual(soft.hits, loud.hits);
    assert(soft.notes.every((note, i) => Math.abs(loud.notes[i].velocity - note.velocity - .02) < 1e-9));
    assert([...soft.notes, ...loud.notes].every(n => n.velocity > 0 && n.velocity < .65));
  }
});

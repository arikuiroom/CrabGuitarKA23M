import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeStrings, melodyMidi, rhythmAt, sourceMotifs } from '../../src/free-mode.js';
import { fixture, beats, chords, close, midiOf } from './fixture.mjs';

const expected = {
  A: [[67,.135,.174],[67,.530,.313],[67,.948,.662],[67,1.691,.197],[60,1.993,.151],[59,2.329,.256],[60,2.701,.139],[62,2.875,.186],[60,3.061,.406]],
  B: [[60,.158,.174],[60,.564,.267],[60,.959,.639],[62,1.992,.314],[60,2.341,.348],[59,2.689,.383],[60,3.072,.674]]
};

test('only exact estimated note, onset and duration data define A/B', () => {
  assert.deepEqual(sourceMotifs, expected);
  assert(Object.isFrozen(sourceMotifs));
  for (const motif of Object.values(sourceMotifs)) {
    assert(Object.isFrozen(motif)); assert(motif.every(Object.isFrozen));
  }
  assert.deepEqual(sourceMotifs.A.map(n => n[0]), [67,67,67,67,60,59,60,62,60]);
  assert.deepEqual(sourceMotifs.B.map(n => n[0]), [60,60,60,62,60,59,60]);
});

for (const [preset, beat] of Object.entries(beats)) {
  test(`${preset}: exact C melody and unquantized onset ratios repeat A/B on one treble string`, async () => {
    const f = fixture(); f.setPreset(preset); await f.mode.start();
    const phraseMs = 16 * beat;
    f.until(160 + phraseMs * 6);
    assert.equal(f.leads.length, 48); close(f.due, 160 + phraseMs * 6);
    let offset = 0;
    for (let phrase = 0; phrase < 6; phrase++) {
      const motif = expected[phrase % 2 ? 'B' : 'A'];
      for (const [midi, onset] of motif) {
        const note = f.leads[offset++];
        assert.equal(midiOf(note.frequency), midi); assert.equal(note.i, 5);
        close(note.time, 160 + phrase * phraseMs + onset / 6.2 * phraseMs);
        const tick = (note.time - 160) / (beat / 4);
        assert(Math.abs(tick - Math.round(tick)) > .001, 'melody was not rounded to the drum grid');
      }
    }
    assert(f.leads[0].time < 1800);
    f.mode.stop(); assert.equal(f.timers.size, 0);
  });

  test(`${preset}: percussion stays on its uninterrupted sixteenth grid throughout long phrase rests`, async () => {
    const f = fixture(); f.setPreset(preset); await f.mode.start();
    f.until(160 + beat * 32 * 3);
    const expectedHits = Array.from({ length: 128 * 3 }, (_, tick) => rhythmAt(preset, tick)
      .map(([kind, level]) => ({ kind, level, time: 160 + tick * beat / 4 }))).flat();
    assert.deepEqual(f.hits, expectedHits);
    assert(f.hits.some(hit => hit.time > 160 + 10 * beat && hit.time < 160 + 16 * beat), 'backing continues through the A tail');
    assert(f.hits.some(hit => hit.time > 160 + 26 * beat && hit.time < 160 + 32 * beat), 'backing continues through the B tail');
    assert(f.hits.every(hit => !f.leads.some(note => Math.abs(note.time - hit.time) < .001)));
    f.mode.stop();
  });

  test(`${preset}: sung durations are scaled, short dry attacks are styled, final notes have natural tails`, async () => {
    const f = fixture(); f.setPreset(preset); await f.mode.start();
    f.until(160 + beat * 32);
    const dry = preset === 'mint' ? .12 : preset === 'black' ? .17 : undefined;
    let offset = 0;
    for (const motif of Object.values(expected)) for (let i = 0; i < motif.length; i++) {
      const note = f.leads[offset++], duration = motif[i][2];
      if (i === motif.length - 1) assert.equal(note.gate, undefined, 'final note rings through the rest');
      else {
        const seconds = duration / 6.2 * 16 * beat / 1000;
        close(note.gate, dry && duration < 6.2 / 16 ? Math.min(dry, seconds) : seconds);
      }
    }
    assert(f.leads[2].gate > .6, 'long held note is not clipped to a short attack');
    const gap = f.leads[9].time - f.leads[8].time;
    close(gap, 3.297 / 6.2 * 16 * beat);
    assert(gap > 3000 && gap < 5300);
    f.mode.stop();
  });
}

test('G preserves major contour; Am and Em/open use the natural-minor seventh', () => {
  assert.deepEqual([67,60,59,60,62].map(n => melodyMidi(n, 'C')), [67,60,59,60,62]);
  assert.deepEqual([67,60,59,60,62].map(n => melodyMidi(n, 'G')), [62,55,54,55,57]);
  assert.deepEqual([67,60,59,60,62].map(n => melodyMidi(n, 'Am')), [64,57,55,57,59]);
  for (const chord of ['Em','open']) assert.deepEqual([67,60,59,60,62].map(n => melodyMidi(n, chord)), [71,64,62,64,66]);
  assert.equal(melodyMidi(67), 67); assert.equal(melodyMidi(67, 'unknown'), 67);
});

test('all styles keep the same melody; black lead includes passing tones and low support stays root/fifth only', async () => {
  const openMidi = [40,45,50,55,59,64], roots = { open:4, C:0, G:7, Am:9, Em:4 };
  for (const [chord, frets] of Object.entries(chords)) for (const [preset, beat] of Object.entries(beats)) {
    const f = fixture(); f.setChord(chord); f.setPreset(preset); await f.mode.start();
    f.until(160 + beat * 32);
    const expectedMidi = Object.values(expected).flat().map(note => melodyMidi(note[0], chord));
    assert.deepEqual(f.leads.map(n => midiOf(n.frequency)), expectedMidi);
    assert(f.leads.every(n => n.i === freeStrings(chord, frets, 'red').at(-1)));
    if (preset === 'black') {
      const support = freeStrings(chord, frets, 'black');
      assert.deepEqual(f.support.map(n => n.i), [support[0], support[1], support[0], support[1]]);
      assert(f.support.every(n => n.i !== 5 && n.gate === .17 && n.v < .4));
      assert(f.support.every(n => [roots[chord], (roots[chord] + 7) % 12].includes((openMidi[n.i] + frets[n.i]) % 12)));
      assert(f.leads.some(n => ![roots[chord], (roots[chord] + 7) % 12].includes(midiOf(n.frequency) % 12)), 'the melody is not restricted to power-chord tones');
    } else assert.equal(f.support.length, 0);
    f.mode.stop();
  }
});

test('support is optional and never collides with the monophonic melody string', async () => {
  for (const support of [[], [5], [0,5]]) {
    const f = fixture({ getSupportStrings: () => support }); f.setPreset('black');
    await f.mode.start(); f.until(160 + beats.black * 32);
    assert(f.support.every(n => n.i !== 5)); assert.equal(f.leads.length, 16);
    if (support.length < 2) assert.equal(f.support.length, 0);
    f.mode.stop();
  }
});

test('random touch changes only velocity, never contour, rest, gates or accompaniment timing', async () => {
  for (const [preset, beat] of Object.entries(beats)) {
    const soft = fixture({ random: () => 0 }), loud = fixture({ random: () => 1 });
    for (const f of [soft, loud]) { f.setPreset(preset); await f.mode.start(); f.until(160 + beat * 32); f.mode.stop(); }
    const withoutVelocity = ({ v, ...note }) => note;
    assert.deepEqual(soft.notes.map(withoutVelocity), loud.notes.map(withoutVelocity));
    assert.deepEqual(soft.hits, loud.hits);
    soft.leads.forEach((note, i) => close(loud.leads[i].v - note.v, .02));
    assert([...soft.notes, ...loud.notes].every(n => n.v > 0 && n.v < .65));
  }
});

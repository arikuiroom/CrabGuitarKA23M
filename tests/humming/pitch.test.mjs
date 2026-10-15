import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, createNoteTracker, normalizeMelody, frequencyToMidi, midiToFrequency } from '../../src/humming-pitch.js';

const pcm = (frequency, sampleRate = 48000, options = {}) => Float32Array.from(
  { length: options.length ?? (sampleRate > 96000 ? 8192 : 4096) }, (_, index) => {
    const phase = 2 * Math.PI * frequency * index / sampleRate;
    return (options.amplitude ?? 0.15) * Math.sin(phase)
      + (options.second ?? 0) * Math.sin(2 * phase) + (options.third ?? 0) * Math.sin(3 * phase)
      + (options.dc ?? 0);
  });
const pitch = midi => ({ midi, frequency: midiToFrequency(midi), rms: 0.1, confidence: 0.99 });
const silence = { midi: null, frequency: null, rms: 0, confidence: 0 };
const near = (actual, expected, tolerance = 0.02) => assert(Math.abs(actual - expected) <= tolerance,
  `${actual} is not within ${tolerance} of ${expected}`);

test('YIN finds 80–1000 Hz at browser sample rates, with DC removed', () => {
  for (const sampleRate of [8000, 44100, 48000, 96000, 192000]) {
    for (const frequency of [80, 110, 146.83, 196, 220, 329.63, 440, 659.25, 880, 1000]) {
      const result = detectPitch(pcm(frequency, sampleRate, { dc: 0.2 }), sampleRate);
      assert(result.frequency, `${frequency} Hz at ${sampleRate} Hz was not detected`);
      near(result.midi, frequencyToMidi(frequency), 0.12);
      assert(result.confidence > 0.95);
    }
  }
});

test('harmonic-rich humming preserves fundamental rather than doubling pitch', () => {
  for (const frequency of [110, 196, 220, 329.63]) {
    const result = detectPitch(pcm(frequency, 48000, { amplitude: 0.04, second: 0.15, third: 0.015 }), 48000);
    near(result.midi, frequencyToMidi(frequency), 0.08);
  }
});

test('silence, DC, quiet frames and deterministic noise never become notes', () => {
  let seed = 47;
  const noise = Float32Array.from({ length: 4096 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 0xffffffff - 0.5) * 0.4;
  });
  for (const frame of [new Float32Array(4096), new Float32Array(4096).fill(0.2), noise,
    pcm(220, 48000, { amplitude: 0.001 })]) assert.equal(detectPitch(frame, 48000).frequency, null);
  assert.equal(detectPitch(Float32Array.of(NaN), 48000).frequency, null);
  assert.equal(detectPitch(pcm(220), 0).frequency, null);
});

test('slow chirps are tracked while input frames remain unchanged', () => {
  const rate = 48000, length = 4096;
  const frame = Float32Array.from({ length }, (_, index) => {
    const time = index / rate;
    return 0.2 * Math.sin(2 * Math.PI * (210 * time + 120 * time * time / 2));
  });
  const before = frame.slice();
  const result = detectPitch(frame, rate);
  assert(result.frequency > 210 && result.frequency < 221);
  assert.deepEqual(frame, before);
});

test('stable notes preserve rhythm and 80 ms or longer rests', () => {
  const tracker = createNoteTracker();
  for (let frame = 0; frame <= 70; frame++) {
    const time = frame * 0.02;
    const midi = time < 0.20 ? null : time < 0.60 ? 60 : time < 0.80 ? null : time < 1.20 ? 64 : null;
    tracker.push(midi === null ? silence : pitch(midi), time);
  }
  const events = tracker.finish(1.4);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.midi), [60, 64]);
  near(events[0].start, 0.2);
  near(events[0].duration, 0.4);
  near(events[1].start, 0.8);
  near(events[1].duration, 0.4);
  const normalized = normalizeMelody(events);
  assert.equal(normalized[0].start, 0);
  near(normalized[1].start, 0.6);
});

test('vibrato, semitone boundary jitter, short dropouts and octave glitches do not retrigger', () => {
  const tracker = createNoteTracker();
  for (let frame = 0; frame <= 70; frame++) {
    const time = frame * 0.02;
    let result = pitch(69 + 0.25 * Math.sin(frame));
    if (frame === 18 || frame === 19) result = pitch(81);
    if (frame === 38 || frame === 39) result = silence;
    if (frame > 50) result = pitch(69.55);
    tracker.push(result, time);
  }
  const events = tracker.finish(1.4);
  assert.equal(events.length, 1);
  assert.equal(events[0].midi, 69);
  near(events[0].duration, 1.4);
});

test('deliberate octave and ordinary note changes survive smoothing', () => {
  const tracker = createNoteTracker();
  for (let frame = 0; frame <= 65; frame++) {
    tracker.push(pitch(frame < 20 ? 57 : frame < 40 ? 69 : 67), frame * 0.02);
  }
  const events = tracker.finish(1.3);
  assert.deepEqual(events.map(event => event.midi), [57, 69, 67]);
  near(events[1].start, 0.42);
  near(events[2].start, 0.82);
});

test('noise does not enter the voiced state; weak sustained humming uses hysteresis', () => {
  const tracker = createNoteTracker();
  for (let index = 0; index < 20; index++) tracker.push({ ...pitch(60), confidence: 0.7 }, index * 0.02);
  assert.equal(tracker.getState().hasVoiced, false);
  for (let index = 20; index < 40; index++) tracker.push(pitch(60), index * 0.02);
  for (let index = 40; index < 60; index++) tracker.push({ ...pitch(60), rms: 0.007, confidence: 0.81 }, index * 0.02);
  assert.equal(tracker.finish(1.2).length, 1);
});

test('event count is bounded and finished arrays cannot mutate tracker state', () => {
  const tracker = createNoteTracker({ maxNotes: 24 });
  for (let frame = 0; frame < 1000; frame++) tracker.push(pitch(60 + Math.floor(frame / 8) % 2 * 4), frame * 0.02);
  const events = tracker.finish(20);
  assert.equal(events.length, 24);
  assert(tracker.getState().limitReached);
  events[0].midi = 1;
  assert.notEqual(tracker.finish(20)[0].midi, 1);
});

test('whole-motif octaves preserve contour, durations and rests, including a wide range', () => {
  for (const midis of [[40, 44, 47], [82, 86, 84], [40, 84, 50], [60, 64, 67]]) {
    const events = midis.map((midi, index) => ({ midi, start: 0.4 + index * 0.4, duration: 0.25 }));
    const converted = normalizeMelody(events);
    const shift = converted[0].midi - midis[0];
    assert.equal(Math.abs(shift % 12), 0);
    assert.deepEqual(converted.map(event => event.midi - shift), midis);
    assert.equal(converted[0].start, 0);
    assert(converted.every(event => event.duration === 0.25));
    near(converted[2].start, 0.8);
  }
  assert.deepEqual(normalizeMelody([]), []);
});

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

test('four same-note hums retain their 60 ms gaps and unquantized lengths', () => {
  const tracker = createNoteTracker();
  const spans = [[0, 13], [16, 30], [33, 45], [48, 65]];
  for (let frame = 0; frame < 70; frame++) {
    const sounding = spans.some(([start, end]) => frame >= start && frame < end);
    tracker.push(sounding ? pitch(64) : silence, 0.013 + frame * 0.02);
  }
  const events = tracker.finish(1.413);
  assert.deepEqual(events.map(event => event.midi), [64, 64, 64, 64]);
  events.forEach((event, index) => {
    near(event.start, 0.013 + spans[index][0] * 0.02, 1e-7);
    near(event.duration, (spans[index][1] - spans[index][0]) * 0.02, 1e-7);
    if (index) near(event.start - events[index - 1].start - events[index - 1].duration, 0.06, 1e-7);
  });
});

test('a deep amplitude valley retriggers a same-pitch hum even while pitch remains voiced', () => {
  const tracker = createNoteTracker();
  for (let frame = 0; frame < 55; frame++) {
    const low = (frame >= 15 && frame < 18) || (frame >= 35 && frame < 38);
    tracker.push({ ...pitch(62 + 0.15 * Math.sin(frame)), rms: low ? 0.025 : 0.1 }, frame * 0.02);
  }
  const events = tracker.finish(1.1);
  assert.deepEqual(events.map(event => event.midi), [62, 62, 62]);
  near(events[0].duration, 0.30, 1e-7);
  near(events[1].start, 0.36, 1e-7);
  near(events[1].duration, 0.34, 1e-7);
  near(events[2].start, 0.76, 1e-7);
});

test('4096-sample rolling PCM frames preserve repeated hums despite window smoothing', () => {
  const spans = [[0, 0.26], [0.32, 0.60], [0.66, 0.90], [0.96, 1.30]];
  for (const sampleRate of [44100, 48000, 96000]) {
    const tracker = createNoteTracker();
    for (let frame = 0; frame < 75; frame++) {
      const time = frame * 0.02;
      const samples = Float32Array.from({ length: 4096 }, (_, index) => {
        const at = time - (4096 - index) / sampleRate;
        return spans.some(([start, end]) => at >= start && at < end)
          ? 0.15 * Math.sin(2 * Math.PI * 220 * at) : 0;
      });
      tracker.push(detectPitch(samples, sampleRate), time);
    }
    const events = tracker.finish(1.5);
    assert.deepEqual(events.map(event => event.midi), [57, 57, 57, 57], `${sampleRate} Hz`);
    events.forEach((event, index) => {
      // Rolling windows necessarily observe edges late; retain the rhythm
      // within one 20 ms poll rather than pretending detection is zero-latency.
      assert(event.start >= spans[index][0]);
      assert(event.start - spans[index][0] <= 0.06 + 1e-7);
      near(event.duration, spans[index][1] - spans[index][0], 0.02 + 1e-7);
      if (index) near(event.start - events[index - 1].start - events[index - 1].duration, 0.06, 1e-7);
    });
    const normalized = normalizeMelody(events);
    normalized.forEach((event, index) => near(event.start, spans[index][0], 0.02 + 1e-7));
  }
});

test('brief low frames and confidence-only dropouts never become rearticulations', () => {
  const tracker = createNoteTracker();
  for (let frame = 0; frame < 75; frame++) {
    let result = { ...pitch(69 + 0.25 * Math.sin(frame)), rms: 0.1 + 0.015 * Math.sin(frame / 3) };
    if (frame === 15 || frame === 30 || frame === 31) result = silence;
    if (frame >= 45 && frame < 48) result = { ...result, midi: null, frequency: null, confidence: 0.3 };
    if (frame === 60) result = { ...result, midi: null, frequency: null, rms: NaN };
    tracker.push(result, frame * 0.02);
  }
  const events = tracker.finish(1.5);
  assert.equal(events.length, 1);
  near(events[0].duration, 1.5, 1e-7);
});

test('shallow dips, sustained quieter humming and a one-frame return do not add notes', () => {
  for (const scenario of ['shallow', 'quiet', 'transient']) {
    const tracker = createNoteTracker();
    for (let frame = 0; frame < 65; frame++) {
      let result = pitch(60);
      if (scenario === 'shallow' && frame >= 15 && frame < 19) result.rms = 0.07;
      if (scenario === 'quiet' && frame >= 15 && frame < 40) result.rms = 0.007;
      if (scenario === 'transient' && frame >= 15 && frame !== 18) result = silence;
      tracker.push(result, frame * 0.02);
    }
    assert.equal(tracker.finish(1.3).length, 1, scenario);
  }
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

test('repeated same-note articulations respect the event cap', () => {
  const tracker = createNoteTracker({ maxNotes: 2 });
  for (let frame = 0; frame < 100; frame++) {
    tracker.push(frame % 16 < 13 ? pitch(64) : silence, frame * 0.02);
  }
  assert.equal(tracker.finish(2).length, 2);
  assert(tracker.getState().limitReached);
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

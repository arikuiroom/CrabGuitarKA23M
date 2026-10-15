import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// These suites temporarily replace global AudioContext; run them in sequence.
await import('./test-humming-timing.mjs');
await import('./test-effects.mjs');
await import('./test-presets.mjs');
await import('./test-techniques.mjs');
await import('./test-arm.mjs');
await import('./test-cutting.mjs');
await import('./test-instruments.mjs');
// Import as a data URL so the test also works without a package.json type field.
const source = await readFile(new URL('../../src/audio.js', import.meta.url), 'utf8');
const { synthesize, GuitarAudio } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const rms = (samples, start, end) => {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / (end - start));
};
function estimatePitch(samples, sampleRate, expected) {
  const start = Math.round(sampleRate * 0.1);
  const length = Math.round(sampleRate * 0.12);
  const center = sampleRate / expected;
  const low = Math.floor(center * 0.88);
  const high = Math.ceil(center * 1.12);
  const differences = new Map();
  let bestLag = low, best = Infinity;
  for (let lag = low; lag <= high; lag++) {
    let difference = 0;
    for (let i = start; i < start + length; i++) difference += (samples[i] - samples[i + lag]) ** 2;
    differences.set(lag, difference);
    if (difference < best) { best = difference; bestLag = lag; }
  }
  const left = differences.get(bestLag - 1), right = differences.get(bestLag + 1);
  const adjustment = (left - right) / (2 * (left - 2 * best + right));
  return sampleRate / (bestLag + (Number.isFinite(adjustment) ? adjustment : 0));
}
const open = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
let maximumCents = 0;
for (const sampleRate of [44100, 48000]) {
  // All six strings, plus common chord frets through a complete octave.
  for (const frequency of open.flatMap(base => [0, 1, 2, 3, 5, 7, 12].map(fret => base * 2 ** (fret / 12)))) {
    const samples = synthesize(frequency, sampleRate);
    assert.equal(samples.length, sampleRate * 3);
    assert(samples.every(Number.isFinite), 'all output samples must be finite');
    assert.equal(samples[0], 0, 'attack must start at zero');
    assert.equal(samples.at(-1), 0, 'release must end at zero');
    const beginning = rms(samples, sampleRate * 0.025 | 0, sampleRate * 0.25 | 0);
    const ending = rms(samples, sampleRate * 2.5 | 0, sampleRate * 2.8 | 0);
    assert(beginning > 0.04, 'pluck must have audible energy');
    assert(ending < beginning * 0.2, 'pluck must decay naturally');
    assert(samples.every(value => Math.abs(value) <= 0.821), 'render must retain headroom');
    const measured = estimatePitch(samples, sampleRate, frequency);
    const cents = Math.abs(1200 * Math.log2(measured / frequency));
    maximumCents = Math.max(maximumCents, cents);
    assert(cents < 10, `pitch ${frequency.toFixed(2)} Hz measured ${measured.toFixed(2)} Hz (${cents.toFixed(2)} cents)`);
  }
}
assert.throws(() => synthesize(NaN), RangeError);
assert.throws(() => synthesize(0), RangeError);
assert.throws(() => synthesize(110, 0), RangeError);
assert.throws(() => synthesize(110, 44100, 0), RangeError);
assert.equal(synthesize(110, 44100, 0.01).length, 441);

class Param {
  constructor() { this.value = 0; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
}
class MockContext {
  constructor() { this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0; this.destination = new Node(); this.started = 0; }
  createGain() { return Object.assign(new Node(), { gain: new Param() }); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node(), { frequency: new Param(), Q: new Param(), gain: new Param() }); }
  createWaveShaper() { return new Node(); }
  createConvolver() { return new Node(); }
  createBuffer(channels, length) { const samples = Array.from({ length: channels }, () => new Float32Array(length)); return { length, sampleRate: this.sampleRate, getChannelData(channel) { return samples[channel]; } }; }
  createBufferSource() { return Object.assign(new Node(), { start: () => this.started++, stop() { this.stopped = true; } }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const original = globalThis.AudioContext;
globalThis.AudioContext = MockContext;
const audio = new GuitarAudio();
assert(audio.volume <= 0.25, 'safe low default output');
assert.equal(audio.readOutputLevel(), 0, 'reading the meter never unlocks audio');
assert.equal(audio.context, null);
await audio.unlock();
assert.equal(audio.context.state, 'running');
assert.equal(audio.readOutputLevel(), 0, 'contexts without an analyser remain supported');
assert.equal(audio.compressor.ratio.value, 4);
assert(audio.pluck(110));
// Optional auto gates share manual PCM and do not affect a replacement voice.
const gated = new GuitarAudio();await gated.unlock();gated.setPreset('mint');
gated.pluck(110,.5,1,.12);const autoVoice=gated.stringVoices[1];
assert(Math.abs(autoVoice.stopAt-autoVoice.start-.141)<1e-9);
assert.equal(gated._parameterState(autoVoice.gain.gain).events.at(-1).value,0);
gated.pluck(110,.5,1);const manualVoice=gated.stringVoices[1];
assert.equal(manualVoice.source.buffer,autoVoice.source.buffer,'auto and manual share identical PCM');
assert.equal(manualVoice.stopAt,undefined,'manual voice has no automatic gate');
assert.notEqual(manualVoice,autoVoice);autoVoice.source.onended();
assert.equal(gated.stringVoices[1],manualVoice,'old auto completion never removes newer manual voice');
assert(gated._parameterState(manualVoice.gain.gain).events.at(-1).value>0);
gated.stopAll();
const firstBuffer = audio.voices[0].source.buffer;
assert(audio.pluck(110));
assert.equal(audio.voices[1].source.buffer, firstBuffer, 'repeat notes reuse rendered sample');
for (let i = 0; i < 30; i++) assert(audio.pluck(110));
assert.equal(audio.voices.length, audio.maxVoices, 'polyphony is bounded');
audio.mute(true);
assert.equal(audio.master.gain.value, 0);
assert.equal(audio.voices.length, 0);
assert.equal(audio.pluck(110), false);
audio.mute(false);
audio.setVolume(9);
assert.equal(audio.volume, 1);
audio.setVolume(-1);
assert.equal(audio.volume, 0);
assert.equal(audio.pluck(NaN), false);
assert.equal(audio.pluck(110, 0), false);
audio.setVolume(0.2);
audio.pluck(220);
audio.stopAll();
assert.equal(audio.voices.length, 0);

class MeterContext extends MockContext {
  createAnalyser() {
    return Object.assign(new Node(), {
      reads: 0,
      level: 0.125,
      getFloatTimeDomainData(samples) {
        this.reads++;
        this.lastSamples = samples;
        for (let index = 0; index < samples.length; index++) {
          samples[index] = index % 2 ? -this.level : this.level;
        }
      },
    });
  }
}
globalThis.AudioContext = MeterContext;
const metered = new GuitarAudio();
await metered.unlock();
assert.equal(metered.outputAnalyser.fftSize, 1024);
assert.deepEqual(metered.master.connections, [metered.context.destination, metered.outputAnalyser],
  'meter is a side tap after master; the original destination path is unchanged');
assert.equal(metered.outputAnalyser.connections.length, 0, 'meter adds no destination path');
assert.equal(metered.voices.length, 0);
assert.equal(metered.readOutputLevel(), 0.125, 'RMS measures output even without active voices');
const firstSamples = metered.outputAnalyser.lastSamples;
metered.outputAnalyser.level = 0.0625;
assert.equal(metered.readOutputLevel(), 0.0625, 'meter follows real sample decay');
assert.equal(metered.outputAnalyser.lastSamples, firstSamples, 'per-frame reads reuse one buffer');
metered.context.state = 'suspended';
assert.equal(metered.readOutputLevel(), 0, 'suspended output is silent');
metered.context.state = 'interrupted';
assert.equal(metered.readOutputLevel(), 0, 'interrupted output is silent');
metered.context.state = 'running';
metered.mute(true);
assert.equal(metered.readOutputLevel(), 0, 'muting cannot leave stale waveform motion');
metered.mute(false);
metered.setVolume(0);
assert.equal(metered.readOutputLevel(), 0, 'zero volume is silent');
metered.setVolume(0.2);
metered.outputAnalyser.level = 0;
assert.equal(metered.readOutputLevel(), 0, 'silent waveform measures exactly zero');
const oldAnalyser = metered.outputAnalyser;
metered.context.state = 'closed';
assert.equal(metered.readOutputLevel(), 0, 'closed output is silent');
await metered.unlock();
assert.notEqual(metered.outputAnalyser, oldAnalyser, 'context recreation replaces the analyser');
assert.notEqual(metered.outputSamples, firstSamples, 'context recreation replaces its sample buffer');
assert.equal(metered.readOutputLevel(), 0.125);
metered.outputAnalyser.getFloatTimeDomainData = () => { throw new Error('context closed'); };
assert.equal(metered.readOutputLevel(), 0, 'a closing analyser cannot break animation');

class ByteMeterContext extends MockContext {
  createAnalyser() {
    return Object.assign(new Node(), {
      level: 16,
      getByteTimeDomainData(samples) {
        for (let index = 0; index < samples.length; index++) {
          samples[index] = 128 + (index % 2 ? -this.level : this.level);
        }
      },
    });
  }
}
globalThis.AudioContext = ByteMeterContext;
const byteMetered = new GuitarAudio();
await byteMetered.unlock();
assert(byteMetered.outputSamples instanceof Uint8Array, 'older WebKit uses byte time-domain samples');
assert.equal(byteMetered.readOutputLevel(), 0.125, 'byte samples use the same normalized RMS scale');
byteMetered.outputAnalyser.level = 0;
assert.equal(byteMetered.readOutputLevel(), 0, 'byte midpoint is silence');
globalThis.AudioContext = original;
console.log(`Audio tests passed: 84 open/fretted pitch checks at 44.1/48 kHz; maximum error ${maximumCents.toFixed(2)} cents. Finite samples, decay, headroom, gesture unlock, mute, volume, cache, voice limit, and post-master RMS meter verified.`);

await import('./test-nylon-touch.mjs');

await import('./test-audio-resources.mjs');

await import('./test-string-voices.mjs');

await import('./test-timbre-refinement.mjs');

await import('./test-harmonic-refinement.mjs');

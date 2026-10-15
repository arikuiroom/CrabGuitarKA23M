import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { GuitarAudio, synthesizeNylonTouch, synthesizeHarmonic } from '../../src/audio.js';

const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557, 659.255];
const rms = (data, sr, from, to) => {
  const start = Math.floor(sr * from), end = Math.min(data.length, Math.floor(sr * to));
  let sum = 0;
  for (let index = start; index < end; index++) sum += data[index] ** 2;
  return Math.sqrt(sum / (end - start));
};
function amplitude(data, frequency, sr) {
  const start = Math.floor(sr * 0.018), end = Math.min(data.length, Math.floor(sr * 0.11));
  let real = 0, imaginary = 0, weights = 0;
  for (let index = start; index < end; index++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index - start) / (end - start - 1));
    const phase = index * frequency * 2 * Math.PI / sr;
    real += data[index] * weight * Math.cos(phase);
    imaginary += data[index] * weight * Math.sin(phase);
    weights += weight;
  }
  return 2 * Math.hypot(real, imaginary) / weights;
}
let highestFourthRatio = 0, longestDecay = 0;
for (const sr of [8000, 44100, 48000]) for (const hz of frequencies) {
  const touch = synthesizeNylonTouch(hz, sr);
  assert.equal(touch.length, Math.ceil(sr * 0.21));
  assert.equal(touch[0], 0); assert.equal(touch.at(-1), 0);
  assert(touch.every(value => Number.isFinite(value) && Math.abs(value) <= 0.721));
  assert.deepEqual(touch, synthesizeNylonTouch(hz, sr), 'wooden excitation is deterministic');
  const modes = [1, 2, 3, 4].map(partial => amplitude(touch, hz * partial, sr));
  const fourthRatio = modes[3] / modes[0];
  const decay = rms(touch, sr, 0.14, 0.19) / rms(touch, sr, 0.012, 0.06);
  highestFourthRatio = Math.max(highestFourthRatio, fourthRatio);
  longestDecay = Math.max(longestDecay, decay);
  assert(modes[0] > 0.15, `audible fundamental for ${hz} Hz/${sr}`);
  assert(modes[0] > modes[1] * 6 && modes[1] > modes[2] * 3,
    'fundamental-led nylon modes get progressively softer');
  assert(fourthRatio < 0.002, 'no shrill ringing fourth partial');
  assert(decay < 0.09, 'naturally short decay before the final gain gate');
  const pinch = synthesizeHarmonic(hz, sr, 0.21);
  assert(amplitude(pinch, hz * 4, sr) > amplitude(pinch, hz, sr) * 15,
    'natural electric harmonic stays fourth-led despite its faint fundamental residue');
}
for (const args of [[NaN], [0], [110, 0], [110, 44100, 0], [110, 44100, 20]]) {
  assert.throws(() => synthesizeNylonTouch(...args), RangeError);
}
for (const [hz, sr, duration] of [[20, 8000, 0.001], [3599, 8000, 0.01], [6000, 48000, 0.21]]) {
  const samples = synthesizeNylonTouch(hz, sr, duration);
  assert.equal(samples.length, Math.ceil(sr * duration));
  assert(samples.every(Number.isFinite)); assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
}

class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
}
class Node {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.connections = []; }
}
class Context {
  constructor() { this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0; this.destination = new Node(); }
  createGain() { return Object.assign(new Node(), { gain: new Param(1) }); }
  createWaveShaper() { return new Node(); }
  createConvolver() { return new Node(); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node(), { frequency: new Param(), Q: new Param(), gain: new Param() }); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { length, getChannelData: channel => data[channel] }; }
  createBufferSource() { return Object.assign(new Node(), { detune: new Param(), start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } }); }
  createAnalyser() { return Object.assign(new Node(), { getFloatTimeDomainData(data) { data.fill(0.125); } }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const original = globalThis.AudioContext;
try {
  globalThis.AudioContext = Context;
  const uke = new GuitarAudio(); uke.setPreset('redbrown'); await uke.unlock();
  for (const hz of frequencies) {
    assert(uke.pluck(hz, 0.7)); const ordinary = uke.voices.at(-1);
    assert(uke.pluckHarmonic(hz, 0.7)); const touch = uke.voices.at(-1);
    assert.equal(touch.harmonic, false, 'bossa nylon API cannot activate harmonics');
    assert.equal(touch.source.buffer, ordinary.source.buffer, 'exact same cached normal waveform');
    assert.equal(touch.tone.frequency.value, ordinary.tone.frequency.value);
    assert.deepEqual(touch.gain.gain.events, ordinary.gain.gain.events);
    assert.deepEqual(touch.gain.connections, [uke.effectInput]);
    assert.equal(touch.playbackFrequency, ordinary.playbackFrequency);
  }
  const nylon = new GuitarAudio(); nylon.setPreset('darkbrown'); await nylon.unlock();
  nylon.pluck(110); const ordinary = nylon.voices.at(-1), tail = nylon.effectNodes.tail.gain.events.slice();
  nylon.pluckHarmonic(110); const touch = nylon.voices.at(-1);
  assert.deepEqual(touch.source.buffer.getChannelData(0), synthesizeNylonTouch(110));
  assert.notEqual(touch.source.buffer, ordinary.source.buffer);
  assert.equal(touch.tone.frequency.value, 1535, 'soft per-note lowpass removes attack sheen');
  assert.deepEqual(touch.gain.connections, [nylon.dryInput], 'no reverb send on nylon touch');
  assert.deepEqual(nylon.effectNodes.tail.gain.events, tail, 'normal nylon room is untouched');
  assert.equal(nylon._parameterValue(touch.gain.gain, 0.2), 0, 'fixed real-time ending');
  nylon.setBend(-4); assert.equal(touch.source.detune.value, -400);
  assert.equal(nylon._parameterValue(touch.gain.gain, 0.2), 0, 'bend cannot extend the tap');
  assert.equal(nylon.readOutputLevel(), 0.125, 'post-output metering remains available');
  nylon.setDamped(true); assert.equal(nylon.pluckHarmonic(110), false);
  nylon.setDamped(false); nylon.mute(true); assert.equal(nylon.pluckHarmonic(110), false);
  assert.equal(nylon.readOutputLevel(), 0);
  nylon.mute(false); nylon.context.currentTime = 0.5;
  assert(nylon.cutStrum(frequencies.slice(0, 6)));
  assert.equal(nylon.voices.length, 6);
  assert(nylon.voices.every(voice => voice.cut && !voice.harmonic && voice.dryOnly));
  nylon.stopAll(); assert.equal(nylon.voices.length, 0);
  for (const id of ['red', 'mint', 'black']) {
    const electric = new GuitarAudio(); electric.setPreset(id); await electric.unlock(); electric.pluckHarmonic(110);
    assert.deepEqual(electric.voices.at(-1).source.buffer.getChannelData(0), synthesizeHarmonic(110));
  }
} finally { globalThis.AudioContext = original; }
console.log(`Nylon/bossa touch tests passed: 21 soft spectra, fourth/fundamental ≤${highestFourthRatio.toFixed(4)}, late/early RMS ≤${longestDecay.toFixed(3)}; exact normal bossa API fallback; dry routing, 200 ms gate, bend, cutting, damping, mute, output meter, and distinct fourth-led electric harmonics.`);

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-nylon-touch.html', import.meta.url), `<!doctype html><meta charset="utf-8"><title>Nylon / ukulele sound QA</title>
<button id="run">Run offline audio tests</button><button id="listen">Listen to nylon pok-pok</button><pre id="result">Ready</pre>
<script type="module">
${renderNylonTouchBrowser.toString()}
window.runAudioTests = () => renderNylonTouchBrowser(new URL('../../../dist/audio.js', location.href).href);
document.querySelector('#run').onclick = async () => {
  document.querySelector('#result').textContent = 'Rendering…';
  try { document.querySelector('#result').textContent = JSON.stringify(await window.runAudioTests(), null, 2); }
  catch(error) { document.querySelector('#result').textContent = String(error.stack || error); }
};
document.querySelector('#listen').onclick = async () => {
  const { GuitarAudio } = await import('../../../dist/audio.js');
  const audio = new GuitarAudio(); audio.setPreset('darkbrown'); audio.setVolume(0.65); await audio.unlock();
  [110, 146.832384, 195.997718, 246.941651, 329.627557, 659.255].forEach((hz, index) => setTimeout(() => audio.pluckHarmonic(hz, 0.8), index * 280));
  setTimeout(() => audio.context.close(), 2200);
};
</script>`);
  console.log('Temporary browser fixture written: tests/browser/generated/qa-audio-nylon-touch.html');
}

async function renderNylonTouchBrowser(moduleUrl) {
  const { GuitarAudio } = await import(moduleUrl), original = globalThis.AudioContext;
  const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
  const rms = (data, sr, from, to) => {
    const start = Math.floor(sr * from), end = Math.min(data.length, Math.floor(sr * to));
    let sum = 0; for (let i = start; i < end; i++) sum += data[i] ** 2;
    return Math.sqrt(sum / (end - start));
  };
  const amplitude = (data, hz, sr) => {
    const start = Math.floor(sr * 0.023), end = Math.floor(sr * 0.105);
    let real = 0, imaginary = 0, weights = 0;
    for (let i = start; i < end; i++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start - 1));
      const phase = i * hz * 2 * Math.PI / sr;
      real += data[i] * weight * Math.cos(phase); imaginary += data[i] * weight * Math.sin(phase); weights += weight;
    }
    return 2 * Math.hypot(real, imaginary) / weights;
  };
  async function render(preset, sr, hz, harmonic, bend = 0) {
    const context = new OfflineAudioContext(2, sr, sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(preset); audio.setVolume(0.65); await audio.unlock();
    audio.setBend(bend, 0);
    if (harmonic) audio.pluckHarmonic(hz, 0.8); else audio.pluck(hz, 0.8);
    const voice = audio.voices.at(-1), flags = { harmonic: voice.harmonic, dry: voice.dryOnly };
    const buffer = await context.startRendering();
    return { data: buffer.getChannelData(0), right: buffer.getChannelData(1), flags };
  }
  try {
    const nylon = [], ukulele = [], bent = [];
    for (const sr of [44100, 48000]) {
      for (const hz of frequencies) {
        const { data, right, flags } = await render('darkbrown', sr, hz, true);
        let peak = 0; for (const value of data) peak = Math.max(peak, Math.abs(value));
        const fourthRatio = amplitude(data, hz * 4, sr) / amplitude(data, hz, sr);
        const row = { sr, hz, ...flags, earlyRms: rms(data, sr, 0.012, 0.065), lateRms: rms(data, sr, 0.14, 0.19),
          afterRms: rms(data, sr, 0.25, 0.95), fourthRatio, peak, finite: data.every(Number.isFinite) && right.every(Number.isFinite) };
        row.passed = row.dry && row.finite && row.earlyRms > 0.004 && row.lateRms < row.earlyRms * 0.05
          && row.afterRms < 1e-7 && fourthRatio < 0.015 && peak < 0.9;
        nylon.push(row);
        const normal = await render('redbrown', sr, hz, false), touch = await render('redbrown', sr, hz, true);
        let maxDifference = 0;
        for (let i = 0; i < normal.data.length; i++) maxDifference = Math.max(maxDifference,
          Math.abs(normal.data[i] - touch.data[i]), Math.abs(normal.right[i] - touch.right[i]));
        ukulele.push({ sr, hz, ...touch.flags, maxDifference,
          passed: !touch.flags.harmonic && !touch.flags.dry && maxDifference === 0 });
      }
      for (const bend of [-4, 4]) {
        const { data } = await render('darkbrown', sr, 110, true, bend);
        const afterRms = rms(data, sr, 0.25, 0.95);
        bent.push({ sr, bend, afterRms, passed: afterRms < 1e-7 });
      }
    }
    return { passed: [...nylon, ...ukulele, ...bent].every(row => row.passed), nylon, ukulele, bent };
  } finally { globalThis.AudioContext = original; }
}

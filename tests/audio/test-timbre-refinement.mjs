import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GuitarAudio, GUITAR_PRESETS, synthesizeTimbre, synthesizeNylonTouch } from '../../src/audio.js';

const hash = data => createHash('sha256').update(Buffer.from(data.buffer)).digest('hex');
// Golden normal excitation and soft-touch PCM from v17. Electric harmonic
// synthesis is intentionally not locked: it has a separate refinement suite.
assert.equal(hash(synthesizeTimbre(110, 44100, 3, 'steel')),
  'b65c8d36d064d3bd415d6b17aee46d33565b81c1ef55a864a8a951b65def1f36');
assert.equal(hash(synthesizeTimbre(110, 44100, 3, 'ukulele')),
  '82e59a768fb5190c80084ff820e17fc333b23b4bff3ad711e5332fac35f63bee');
assert.equal(hash(synthesizeNylonTouch(110, 44100)),
  '8d914b854fa1291f07c4396c4730a5bbeb9fd577c0012fc9598dbbf10d8d473c');

function amplitude(data, hz, sr, from = 0.02, to = 0.14) {
  const start = Math.floor(sr * from), end = Math.floor(sr * to);
  let real = 0, imaginary = 0, weights = 0;
  for (let frame = start; frame < end; frame++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (frame - start) / (end - start - 1));
    const phase = frame * hz * 2 * Math.PI / sr;
    real += data[frame] * weight * Math.cos(phase);
    imaginary += data[frame] * weight * Math.sin(phase);
    weights += weight;
  }
  return 2 * Math.hypot(real, imaginary) / weights;
}
const originalNylonUpperEnergy = [
  [82.406889, 0.037262952237968425], [110, 0.03709827021655569],
  [146.832384, 0.036785552234879546], [195.997718, 0.03620218583327296],
  [246.941651, 0.035333513249017894], [329.627557, 0.03337881414451606],
  [659.255, 0.021751268588716698],
];
const nylonClarity = [];
for (const [hz, previous] of originalNylonUpperEnergy) {
  const samples = synthesizeTimbre(hz, 44100, 1.1, 'nylon');
  const modes = Array.from({ length: 12 }, (_, index) => amplitude(samples, hz * (index + 1), 44100));
  const upper = modes.slice(2).reduce((sum, value) => sum + value ** 2, 0) / modes[0] ** 2;
  assert(upper > previous * 1.4 && upper < previous * 2,
    'nylon gains controlled upper-mode clarity without becoming a steel-string excitation');
  assert(modes[0] > modes[1] * 1.8, 'fundamental remains strongly dominant');
  nylonClarity.push(upper / previous);
}
assert.equal(GUITAR_PRESETS.darkbrown.output, 0.58, 'nylon output trim is unchanged');
assert.equal(GUITAR_PRESETS.darkbrown.wet, 0.055, 'nylon room amount is unchanged');
assert.equal(GUITAR_PRESETS.mint.output, 1.25, 'mint output trim is unchanged');
assert.equal(GUITAR_PRESETS.mint.wet, 0.025, 'mint room amount is unchanged');

class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  constructor(context, kind) { this.connections = []; context.nodes.push({ node: this, kind }); }
  connect(node) { this.connections.push(node); }
  disconnect() { this.connections = []; }
}
class Context {
  constructor() { this.nodes = []; this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100; this.destination = new Node(this, 'destination'); }
  createGain() { return Object.assign(new Node(this, 'gain'), { gain: new Param(1) }); }
  createBiquadFilter() { return Object.assign(new Node(this, 'filter'), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createWaveShaper() { return new Node(this, 'shaper'); }
  createConvolver() { return new Node(this, 'convolver'); }
  createDynamicsCompressor() { return Object.assign(new Node(this, 'compressor'), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { length, getChannelData: channel => data[channel] }; }
  createBufferSource() { return Object.assign(new Node(this, 'source'), { detune: new Param(), start() {}, stop() {} }); }
}
const originalContext = globalThis.AudioContext;
let curveChecks = 0;
try {
  globalThis.AudioContext = Context;
  let graphKinds;
  for (const id of Object.keys(GUITAR_PRESETS)) {
    const audio = new GuitarAudio(); audio.setPreset(id); await audio.unlock();
    const kinds = audio.context.nodes.map(entry => entry.kind);
    if (graphKinds) assert.deepEqual(kinds, graphKinds, 'all five presets reuse the same DSP topology');
    else graphKinds = kinds;
    const before = audio.context.nodes.length;
    audio.pluck(110);
    assert.equal(audio.context.nodes.length - before, 3, 'exactly one source, tone filter, and gain per voice');
  }
  for (const sr of [8000, 44100, 48000]) for (const hz of [82.406889, 329.627557, 659.255, 3000]) {
    if (hz >= sr * 0.45) continue;
    for (const velocity of [0.25, 0.7, 1]) for (const cut of [false, true]) {
      const audio = new GuitarAudio(); audio.setPreset('mint'); await audio.unlock(); audio.context.sampleRate = sr;
      assert(cut ? audio.pluckCut(hz, velocity) : audio.pluck(hz, velocity));
      const voice = audio.voices.at(-1), start = voice.start;
      const cutoff = value => Math.min(sr * 0.43, Math.max(hz * 2.4, value));
      assert.equal(voice.tone.Q.value, 2.05);
      assert(Math.abs(audio._parameterValue(voice.tone.frequency, start) - cutoff(650 + velocity * 350)) < 1e-8);
      assert(Math.abs(audio._parameterValue(voice.tone.frequency, start + 0.004) - cutoff(2600 + velocity * 2200)) < 1e-8);
      assert(Math.abs(audio._parameterValue(voice.tone.frequency, start + (cut ? 0.059 : 0.109)) - cutoff(600 + velocity * 600)) < 1e-8);
      assert.equal(voice.tone.frequency.events.filter(event => event[0] === 'ramp').length, 2,
        'stronger wah schedules no additional filter automation');
      if (cut) assert(Math.abs(audio._parameterValue(voice.gain.gain, start + 0.105)) < 1e-12, 'cutting endpoint is unchanged');
      else {
        const level = 0.44 * velocity ** 1.15;
        assert(Math.abs(audio._parameterValue(voice.gain.gain, start + 0.012) - level * 1.06) < 1e-12);
        assert(Math.abs(audio._parameterValue(voice.gain.gain, start + 0.109) - level * 0.72) < 1e-12);
        assert.equal(voice.source.buffer.length, sr * 3, 'normal mint sustain is not gated or extended');
      }
      curveChecks++;
    }
  }
} finally { globalThis.AudioContext = originalContext; }
console.log(`Timbre refinement tests passed: ${curveChecks} velocity/pitch/rate/cut curves, unchanged node topology and automation count; nylon upper-mode energy ×${Math.min(...nylonClarity).toFixed(2)}–${Math.max(...nylonClarity).toFixed(2)}; exact steel, ukulele, and wooden-touch PCM.`);

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  const baselinePath = process.env.KANI_TIMBRE_BASELINE;
  if (!baselinePath) throw new Error('Set KANI_TIMBRE_BASELINE to an explicit audio-module baseline file before generating a comparison fixture.');
  const fixturePath = new URL('../browser/generated/qa-audio-timbre-refinement.html', import.meta.url);
  const baselineSource = await readFile(baselinePath, 'utf8');
  const baselineUrl = `data:text/javascript;base64,${Buffer.from(baselineSource).toString('base64')}`;
  const fixture = `<!doctype html>
<meta charset="utf-8"><title>Mint / nylon native audio comparison</title>
<button id="run">Run native offline comparison</button><pre id="result">Ready</pre>
<script type="module">
${renderTimbreComparison.toString()}
window.runToneComparisons = () => renderTimbreComparison(${JSON.stringify(baselineUrl)}, new URL('../../../dist/audio.js?v=18', location.href).href);
document.querySelector('#run').onclick = async () => {
  document.querySelector('#run').disabled = true;
  document.querySelector('#result').textContent = 'Rendering…';
  try { window.timbreResults = await window.runToneComparisons(); document.querySelector('#result').textContent = JSON.stringify(window.timbreResults, null, 2); }
  catch(error) { document.querySelector('#result').textContent = String(error.stack || error); }
  document.querySelector('#run').disabled = false;
};
</script>`;
  await writeFile(fixturePath, fixture);
  console.log('Native comparison fixture: tests/browser/generated/qa-audio-timbre-refinement.html');
}

async function renderTimbreComparison(baselineUrl, candidateUrl) {
  const before = await import(baselineUrl), after = await import(candidateUrl);
  const original = globalThis.AudioContext;
  const hzList = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
  const rms = (data, sr, from, to) => {
    let sum = 0; const start = Math.floor(sr * from), end = Math.min(data.length, Math.floor(sr * to));
    for (let i = start; i < end; i++) sum += data[i] ** 2;
    return Math.sqrt(sum / (end - start));
  };
  const spectral = (data, hz, sr, from = 0.025, to = 0.14) => {
    const start = Math.floor(sr * from), end = Math.floor(sr * to);
    let real = 0, imaginary = 0, weights = 0;
    for (let i = start; i < end; i++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start - 1));
      const phase = i * hz * 2 * Math.PI / sr;
      real += data[i] * weight * Math.cos(phase); imaginary += data[i] * weight * Math.sin(phase); weights += weight;
    }
    return 2 * Math.hypot(real, imaginary) / weights;
  };
  const peak = data => { let value = 0; for (const sample of data) value = Math.max(value, Math.abs(sample)); return value; };
  const upper = (data, hz, sr) => Array.from({ length: 10 }, (_, i) => spectral(data, hz * (i + 3), sr) ** 2)
    .reduce((sum, value) => sum + value, 0) / spectral(data, hz, sr) ** 2;
  async function render(module, id, sr, hz = 110, mode = 'normal', velocity = 0.7) {
    const context = new OfflineAudioContext(2, Math.ceil(sr * 1.25), sr);
    context.resume = () => Promise.resolve(); globalThis.AudioContext = function () { return context; };
    const audio = new module.GuitarAudio(); audio.setPreset(id); audio.setVolume(mode === 'overload' ? 1 : 0.65); await audio.unlock();
    if (mode === 'overload') for (let round = 0; round < 2; round++) for (const frequency of hzList) audio.pluck(frequency, 1);
    else if (mode === 'touch') audio.pluckHarmonic(hz, velocity);
    else if (mode === 'cut') audio.pluckCut(hz, velocity);
    else audio.pluck(hz, velocity);
    const buffer = await context.startRendering();
    const data = buffer.getChannelData(0), right = buffer.getChannelData(1);
    return { data, right, peak: Math.max(peak(data), peak(right)), finite: data.every(Number.isFinite) && right.every(Number.isFinite) };
  }
  const results = [], baselineControls = [];
  // Native multivoice render accumulation is not byte-stable between separate
  // contexts. Keep single notes exact; bound overload differences in both peak
  // samples and signal-normalized RMS, and run unchanged baseline controls.
  const nativeTolerance = { maximumDifference: 0.0005, normalizedDifference: 0.0001 };
  async function compare(id, sr, hz, mode, velocity = 0.7, baselineControl = false) {
    const a = await render(before, id, sr, hz, mode, velocity), b = await render(baselineControl ? before : after, id, sr, hz, mode, velocity);
    const earlyA = rms(a.data, sr, 0.015, 0.14), earlyB = rms(b.data, sr, 0.015, 0.14);
    let difference = 0, maximumDifference = 0;
    for (let i = 0; i < a.data.length; i++) {
      const delta = b.data[i] - a.data[i]; difference += delta ** 2;
      maximumDifference = Math.max(maximumDifference, Math.abs(delta), Math.abs(b.right[i] - a.right[i]));
    }
    const row = { id, sr, hz, mode, velocity, baselineControl, peakBefore: a.peak, peakAfter: b.peak,
      earlyRmsBefore: earlyA, earlyRmsAfter: earlyB, levelRatio: earlyB / earlyA,
      lateRmsBefore: rms(a.data, sr, 0.8, 1.1), lateRmsAfter: rms(b.data, sr, 0.8, 1.1),
      maximumDifference, normalizedDifference: Math.sqrt(difference / a.data.length) / rms(a.data, sr, 0, 1.25) };
    row.passed = a.finite && b.finite && b.peak < 0.9;
    if (['red', 'black', 'redbrown'].includes(id)) row.passed &&= mode === 'overload'
      ? maximumDifference <= nativeTolerance.maximumDifference
        && row.normalizedDifference <= nativeTolerance.normalizedDifference
      : maximumDifference === 0;
    if (mode === 'normal') {
      row.passed &&= row.levelRatio > 0.68 && row.levelRatio < 1.3 && row.lateRmsAfter <= row.lateRmsBefore * 1.08;
      if (id === 'darkbrown') {
        row.upperEnergyBefore = upper(a.data, hz, sr); row.upperEnergyAfter = upper(b.data, hz, sr);
        row.clarityRatio = row.upperEnergyAfter / row.upperEnergyBefore;
        row.passed &&= row.clarityRatio > 1.35 && row.clarityRatio < 2.7;
      }
      if (id === 'mint') row.passed &&= row.normalizedDifference > 0.1;
    }
    if (mode === 'touch') {
      row.fourthRatio = spectral(b.data, hz * 4, sr) / spectral(b.data, hz, sr);
      row.afterRms = rms(b.data, sr, 0.25, 1.1);
      row.passed &&= row.fourthRatio < 0.015 && row.afterRms < 1e-7 && row.levelRatio > 0.9 && row.levelRatio < 1.12;
    }
    if (mode === 'cut') {
      row.afterRms = rms(b.data, sr, 0.25, 1.1); row.passed &&= row.afterRms < 1e-7;
    }
    (baselineControl ? baselineControls : results).push(row);
  }
  try {
    for (const sr of [44100, 48000]) {
      for (const id of ['red', 'black', 'redbrown']) await compare(id, sr, 110, 'overload', 0.7, true);
      for (const id of ['red', 'mint', 'black', 'darkbrown', 'redbrown']) {
        await compare(id, sr, 110, 'normal'); await compare(id, sr, 110, 'overload');
      }
      for (const hz of hzList) {
        if (hz !== 110) await compare('darkbrown', sr, hz, 'normal');
        await compare('darkbrown', sr, hz, 'touch');
      }
      for (const hz of [110, 329.627557]) for (const velocity of [0.3, 1]) await compare('mint', sr, hz, 'normal', velocity);
      for (const id of ['mint', 'darkbrown']) await compare(id, sr, 110, 'cut');
    }
    return { passed: [...results, ...baselineControls].every(row => row.passed), nativeOfflineAudio: true,
      count: results.length, nativeTolerance, baselineControls, results };
  } finally { globalThis.AudioContext = original; }
}

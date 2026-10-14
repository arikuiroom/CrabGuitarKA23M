import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { synthesize, synthesizeHarmonic, GuitarAudio, GUITAR_PRESETS } from '../../src/audio.js';

const ids = ['red', 'mint', 'black', 'darkbrown', 'redbrown'];
assert.deepEqual(GUITAR_PRESETS.red, { id: 'red', name: 'Clean Space', highpass: 45, bass: -1, mids: -1, treble: 2.5,
  cutoff: 11000, drive: 1, clean: 1, distorted: 0, output: 1.1, dry: 0.88, wet: 0.32 });
assert.deepEqual(GUITAR_PRESETS.mint, { id: 'mint', name: 'Funk Wah', highpass: 95, bass: -3.5, mids: 1.5, treble: 3,
  cutoff: 8200, drive: 1, clean: 1, distorted: 0, output: 1.25, dry: 0.99, wet: 0.025 });
assert.deepEqual(GUITAR_PRESETS.black, { id: 'black', name: 'Metal', highpass: 95, bass: 2, mids: -4.5, treble: 1,
  cutoff: 4200, drive: 8, clean: 0, distorted: 0.095, output: 1, dry: 1, wet: 0.016 });
assert.deepEqual(GUITAR_PRESETS.darkbrown, { id: 'darkbrown', name: 'Nylon', highpass: 28, bass: 2, mids: 1, treble: -3,
  cutoff: 5800, drive: 1, clean: 1, distorted: 0, output: 0.58, dry: 0.97, wet: 0.055 });
assert.deepEqual(GUITAR_PRESETS.redbrown, { id: 'redbrown', name: 'Ukulele', highpass: 120, bass: -5, mids: 3, treble: 4,
  cutoff: 9500, drive: 1, clean: 1, distorted: 0, output: 1.32, dry: 1, wet: 0.012 });
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
function spectral(samples, hz, sr, from = 0.045, to = 0.3) {
  const begin = Math.floor(from * sr), end = Math.min(samples.length, Math.floor(to * sr));
  let real = 0, imaginary = 0, weight = 0;
  for (let i = begin; i < end; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - begin) / (end - begin - 1));
    const angle = i * hz * Math.PI * 2 / sr;
    real += samples[i] * window * Math.cos(angle);
    imaginary += samples[i] * window * Math.sin(angle);
    weight += window;
  }
  return Math.hypot(real, imaginary) * 2 / weight;
}
let minimumDominance = Infinity, minimumRevoiceDifference = Infinity;
for (const sr of [8000, 44100, 48000]) {
  for (const frequency of [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557, 659.255]) {
    const pinch = synthesizeHarmonic(frequency, sr, 0.7);
    assert(pinch.every(value => Number.isFinite(value) && Math.abs(value) <= 0.721));
    assert.equal(pinch[0], 0); assert.equal(pinch.at(-1), 0);
    const amplitudes = [1, 2, 3, 4, 5].map(partial => spectral(pinch, frequency * partial, sr));
    const dominance = amplitudes[3] / Math.max(...amplitudes.slice(0, 3), amplitudes[4]);
    minimumDominance = Math.min(minimumDominance, dominance);
    assert(dominance > 6, `fourth partial dominates for ${frequency} Hz at ${sr} Hz: ${dominance}`);
    const normal = synthesize(frequency, sr, 0.7);
    assert(spectral(pinch, frequency * 4, sr) / Math.max(1e-9, spectral(pinch, frequency, sr)) >
      spectral(normal, frequency * 4, sr) / spectral(normal, frequency, sr) * 20);
    const shifted = synthesize(frequency * 4, sr, 0.7);
    const start = Math.floor(sr * 0.015), end = Math.floor(sr * 0.3);
    const a = pinch.slice(start, end), b = shifted.slice(start, end);
    const ar = rms(a), br = rms(b);
    const difference = rms(a.map((value, i) => value / ar - b[i] / br));
    minimumRevoiceDifference = Math.min(minimumRevoiceDifference, difference);
    assert(difference > (frequency > 500 ? (sr === 8000 ? 0.08 : 0.15) : 0.35), `pinch is distinct from a repitched normal pluck: ${difference}`);
    assert.deepEqual(synthesizeHarmonic(frequency, sr, 0.7), pinch);
  }
}
for (const args of [[NaN], [0], [110, 0], [110, 44100, 0], [110, 44100, 20]]) {
  assert.throws(() => synthesizeHarmonic(...args), RangeError);
}
assert.equal(synthesizeHarmonic(110, 44100, 0.01).length, 441);

class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
}
class Node {
  constructor(kind, context) { this.kind = kind; this.connections = []; context.nodes.push(this); }
  connect(node) { this.connections.push(node); }
  disconnect() { this.connections = []; }
}
class Context {
  constructor() {
    this.nodes = []; this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0;
    this.destination = new Node('destination', this);
  }
  createGain() { return Object.assign(new Node('gain', this), { gain: new Param(1) }); }
  createWaveShaper() { return new Node('shaper', this); }
  createConvolver() { return new Node('convolver', this); }
  createDynamicsCompressor() { return Object.assign(new Node('compressor', this), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node('filter', this), { frequency: new Param(), Q: new Param(), gain: new Param() }); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { length, getChannelData: channel => data[channel] }; }
  createBufferSource() { return Object.assign(new Node('source', this), { start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const oldContext = globalThis.AudioContext;
try {
  globalThis.AudioContext = Context;
  const untouched = new GuitarAudio();
  untouched.setDamped(true);
  assert.equal(untouched.pluck(110), false); assert.equal(untouched.pluckHarmonic(110), false);
  assert.equal(untouched.context, null, 'a held damper does not unlock or allocate audio');
  untouched.setDamped(false); assert(untouched.pluckHarmonic(110));
  assert.equal(untouched.preset, 'red');
  for (const id of ids) {
    const audio = new GuitarAudio(); audio.setPreset(id); await audio.unlock();
    assert(audio.pluck(110)); assert(audio.pluckHarmonic(110));
    for (const voice of audio.voices) {
      if (id === 'mint') {
        assert.equal(voice.tone.Q.value, 2.05, 'mint has a defined resonant envelope wah');
        assert.deepEqual(voice.tone.frequency.events.filter(event => event[0] === 'ramp'),
          [['ramp', 4140, 0.004], ['ramp', 1020, 0.109]], 'mint opens in 4 ms and closes by 109 ms');
        const attack = (voice.harmonic ? 0.38 : 0.44) * 0.7 ** 1.15;
        assert(Math.abs(audio._parameterValue(voice.gain.gain, 0.012) - attack * 1.06) < 1e-12,
          'mint has a defined but bounded transient');
        assert(Math.abs(audio._parameterValue(voice.gain.gain, 1) - attack * 0.72) < 1e-12,
          'mint settles to sustain rather than truncating notes');
      } else {
        assert.equal(voice.tone.Q.value, 0.5, 'other presets retain the original filter');
        assert.equal(voice.tone.frequency.events.length, 0, 'other presets have no wah envelope');
        assert.equal(voice.tone.frequency.value, id === 'darkbrown' && voice.harmonic
          ? 1535 : voice.harmonic ? 12100 : 7360);
      }
      const short = id === 'darkbrown' && voice.harmonic;
      assert.equal(voice.source.buffer.length, Math.ceil(44100 * (short ? 0.21 : 3)),
        'only nylon harmonics use the requested short dry buffer');
    }
    const priorToneEvents = audio.voices[0].tone.frequency.events.slice();
    const ordinaryBuffer = audio.voices[0].source.buffer, harmonicBuffer = audio.voices[1].source.buffer;
    if (id === 'redbrown') {
      assert.equal(ordinaryBuffer, harmonicBuffer, 'ukulele harmonic API uses the ordinary note/cache');
      assert.equal(audio.voices[1].harmonic, false);
    } else assert.notEqual(ordinaryBuffer, harmonicBuffer, 'other normal/touch cache entries stay separate');
    assert(audio.pluckHarmonic(110)); assert.equal(audio.voices[2].source.buffer, harmonicBuffer);
    assert.deepEqual(audio.voices[0].tone.frequency.events, priorToneEvents,
      'a new pluck never retriggers the earlier voice filter');
    const ringing = [...audio.voices], volume = audio.volume;
    audio.context.currentTime = 0.5;
    audio.setDamped(true);
    const gateEvents = [...audio.damper.gain.events];
    assert.equal(audio.damped, true); assert.equal(audio.muted, false); assert.equal(audio.volume, volume);
    assert.equal(audio.voices.length, 0); assert.equal(audio.effectNodes.tail.gain.value, 0);
    assert.deepEqual(gateEvents.at(-1), ['ramp', 0, 0.572]);
    for (const voice of ringing) assert.equal(voice.source.stopTime, 0.573);
    const nodeCount = audio.context.nodes.length;
    audio.setDamped(true); assert.deepEqual(audio.damper.gain.events, gateEvents, 'repeated hold cannot reset the fade');
    assert.equal(audio.pluck(220), false); assert.equal(audio.pluckHarmonic(220), false);
    assert.equal(audio.context.nodes.length, nodeCount, 'suppressed notes allocate no buffers or nodes');
    audio.setVolume(0.83); audio.setPreset('redbrown'); audio.mute(true); audio.mute(false);
    assert.equal(audio.damper.gain.value, 0, 'volume, preset and unmute cannot override damping');
    audio.setDamped(false);
    assert.equal(audio.muted, false); assert.equal(audio.volume, 0.83);
    assert.equal(audio.damper.gain.events.at(-1)[1], 0, 'release never opens old sound');
    assert(audio.pluckHarmonic(220));
    assert.equal(audio.voices.at(-1).source.startTime, 0.584, 'immediate fresh pluck waits only for the choke to finish');
    assert.deepEqual(audio.damper.gain.events.at(-1), ['ramp', 1, 0.596]);
    assert(audio.effectNodes.tail.gain.events.some(event => event[0] === 'target' && event[1] === 1 && event[2] >= 1.6), 'the prior room drains before reopening');
    audio.setDamped(true); audio.setDamped(false); audio.mute(true);
    assert.equal(audio.pluckHarmonic(330), false, 'release does not override permanent mute');
    audio.mute(false); audio.context.currentTime = 1;
    assert(audio.pluck(330));
    // Safe cancelScheduledValues fallback is important on older WebKit.
    audio.damper.gain.cancelAndHoldAtTime = undefined;
    audio.setDamped(true);
    assert(audio.damper.gain.events.some(event => event[0] === 'set' && event[2] === 1));
    audio.context.state = 'closed'; await audio.unlock();
    assert.equal(audio.damped, true); assert.equal(audio.damper.gain.value, 0);
    assert.equal(audio.pluckHarmonic(330), false, 'held state survives context recreation');
    audio.setDamped(false); assert(audio.pluckHarmonic(330));
  }
  const cached = new GuitarAudio(); await cached.unlock();
  for (let i = 0; i < 60; i++) {
    assert(cached.pluck(80 + i)); assert(cached.pluckHarmonic(80 + i));
    assert(cached.cache.size <= 48); assert(cached.voices.length <= cached.maxVoices);
  }
  assert.equal(cached.cache.size, 48);
  assert.equal(cached.pluckHarmonic(NaN), false); assert.equal(cached.pluckHarmonic(110, NaN), false);
} finally { globalThis.AudioContext = oldContext; }
console.log(`Technique tests passed: mint clean funk/wah, metal/nylon/ukulele presets, unchanged red; 21 harmonic spectra (fourth-partial dominance ≥${minimumDominance.toFixed(2)}×, repitched-pluck difference ≥${minimumRevoiceDifference.toFixed(2)}); 72 ms post-effects fade across all five presets; held-note suppression; silent release; fresh replay; independent mute/volume; Safari fallback; shared 48-buffer cache and 12-voice limit.`);

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-techniques.html', import.meta.url), `<!doctype html>
<meta charset="utf-8"><title>Guitar technique audio QA</title>
<button id="run">Run audio tests</button><pre id="result">Ready</pre>
<script type="module">
${renderBrowser.toString()}
document.querySelector('#run').addEventListener('click', async () => {
  document.querySelector('#run').disabled = true;
  document.querySelector('#result').textContent = 'Rendering…';
  try { document.querySelector('#result').textContent = JSON.stringify(await renderBrowser(new URL('../../../dist/audio.js', location.href).href), null, 2); }
  catch (error) { document.querySelector('#result').textContent = String(error.stack || error); }
  document.querySelector('#run').disabled = false;
});
</script>`);
  console.log('Temporary browser fixture written: tests/browser/generated/qa-audio-techniques.html');
}

async function renderBrowser(moduleUrl) {
  const { GuitarAudio, getPlaybackFrequency } = await import(moduleUrl);
  const ids = ['red', 'mint', 'black', 'darkbrown', 'redbrown'], sr = 44100;
  const original = globalThis.AudioContext;
  const rms = (data, from, to) => { let sum = 0; const start = Math.floor(from * sr), end = Math.min(data.length, Math.floor(to * sr)); for (let i = start; i < end; i++) sum += data[i] ** 2; return Math.sqrt(sum / (end - start)); };
  const peak = data => { let max = 0; for (const value of data) max = Math.max(max, Math.abs(value)); return max; };
  function amplitude(data, frequency) {
    const start = Math.floor(sr * 0.06), end = Math.floor(sr * 0.3);
    let real = 0, imaginary = 0, weights = 0;
    for (let i = start; i < end; i++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start - 1));
      const phase = i * frequency * Math.PI * 2 / sr;
      real += data[i] * weight * Math.cos(phase); imaginary += data[i] * weight * Math.sin(phase); weights += weight;
    }
    return Math.hypot(real, imaginary) * 2 / weights;
  }
  async function render(id, mode) {
    const context = new OfflineAudioContext(2, sr * 2, sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(id); audio.setVolume(mode === 'overload' ? 1 : 0.45); await audio.unlock();
    if (mode === 'tail') {
      audio.effectNodes.dry.gain.value = 0;
      const impulse = context.createBuffer(1, 1, sr); impulse.getChannelData(0)[0] = 0.4;
      const source = context.createBufferSource(); source.buffer = impulse;
      source.connect(audio.effectNodes.output); source.start(0.02);
    } else if (mode === 'overload') {
      for (let round = 0; round < 2; round++) for (const frequency of [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557]) audio.pluckHarmonic(frequency, 1);
    } else if (mode === 'normal') audio.pluck(110, 0.8);
    else if (mode === 'repitched') audio.pluck(getPlaybackFrequency(110, id) * 4, 0.8);
    else audio.pluckHarmonic(110, 0.8);
    const events = [], pending = [];
    const at = (time, run) => { pending.push(context.suspend(time).then(async () => { run(); await OfflineAudioContext.prototype.resume.call(context); })); };
    if (['damp', 'tail', 'replay'].includes(mode)) {
      at(0.4, () => { audio.setDamped(true); events.push({ kind: 'damp', time: context.currentTime, blockedNormal: !audio.pluck(220), blockedHarmonic: !audio.pluckHarmonic(220) }); });
      at(mode === 'replay' ? 0.408 : 0.48, () => {
        audio.setDamped(false); events.push({ kind: 'release', time: context.currentTime });
        if (mode === 'replay') { const played = audio.pluckHarmonic(220); events.push({ kind: 'replay', time: context.currentTime, played }); }
      });
    }
    const buffer = await context.startRendering(); await Promise.all(pending);
    return { data: buffer.getChannelData(0), right: buffer.getChannelData(1), events };
  }
  try {
    const results = [];
    for (const id of ids) {
      const normal = (await render(id, 'normal')).data;
      const harmonic = (await render(id, 'harmonic')).data;
      const repitched = (await render(id, 'repitched')).data;
      const overload = await render(id, 'overload');
      const damp = await render(id, 'damp');
      const tail = await render(id, 'tail');
      const replay = await render(id, 'replay');
      const harmonics = [1, 2, 3, 4, 5].map(partial => amplitude(harmonic, getPlaybackFrequency(110, id) * partial));
      const dominance = harmonics[3] / Math.max(...harmonics.slice(0, 3), harmonics[4]);
      const levelH = rms(harmonic, 0.06, 0.3), levelR = rms(repitched, 0.06, 0.3);
      const difference = harmonic.map((value, i) => value / levelH - repitched[i] / levelR);
      const silentStart = damp.events[0].time + 0.074;
      let normalDifference = 0;
      for (let i = 0; i < normal.length; i++) normalDifference = Math.max(normalDifference, Math.abs(normal[i] - harmonic[i]));
      const row = { id, normalRms: rms(normal, 0.06, 0.3), harmonicRms: levelH,
        touchAttackRms: rms(harmonic, 0.012, 0.065), harmonicPeak: peak(harmonic), fourthPartialDominance: dominance,
        fourthToFundamental: harmonics[3] / harmonics[0], normalDifference,
        repitchedDifference: rms(difference, 0.06, 0.3), overloadPeak: Math.max(peak(overload.data), peak(overload.right)),
        chokeRms: rms(damp.data, silentStart, 0.49), releaseRms: rms(damp.data, 0.5, 1.5),
        tailBeforeRms: rms(tail.data, 0.2, 0.35), tailAfterRms: rms(tail.data, 0.48, 1.5),
        newPluckRms: rms(replay.data, 0.51, 0.56), blockedWhileHeld: damp.events[0].blockedNormal && damp.events[0].blockedHarmonic,
        freshPluckAccepted: replay.events.at(-1).played, finite: [normal, harmonic, repitched, overload.data, damp.data, tail.data, replay.data].every(data => data.every(Number.isFinite)) };
      const touchCorrect = id === 'darkbrown' ? row.fourthToFundamental < 0.01
        : id === 'redbrown' ? row.normalDifference === 0 : row.fourthPartialDominance > 4;
      row.passed = row.finite && row.normalRms > 0.004 && row.touchAttackRms > 0.004 && row.harmonicPeak < 0.9
        && touchCorrect && row.repitchedDifference > 0.15 && row.overloadPeak < 0.9
        && row.chokeRms < 1e-7 && row.releaseRms < 1e-7 && row.tailBeforeRms > 1e-9 && row.tailAfterRms < 1e-7
        && row.newPluckRms > 0.004 && row.blockedWhileHeld && row.freshPluckAccepted;
      results.push(row);
    }
    return { passed: results.every(result => result.passed), sampleRate: sr, results };
  } finally { globalThis.AudioContext = original; }
}

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../../src/audio.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { GuitarAudio, GUITAR_PRESETS, createOutputSafetyCurve } = await import(moduleUrl);
const ids = ['red', 'mint', 'black', 'darkbrown', 'redbrown'];
assert.deepEqual(Object.keys(GUITAR_PRESETS), ids);
assert(Object.isFrozen(GUITAR_PRESETS));
for (const id of ids) assert(Object.isFrozen(GUITAR_PRESETS[id]));
const safety = createOutputSafetyCurve();
assert.equal(safety[(safety.length - 1) / 2], 0);
assert(safety.every(sample => Number.isFinite(sample) && Math.abs(sample) < 0.9));
for (let i = 0; i < safety.length; i++) {
  const input = i * 2 / (safety.length - 1) - 1;
  assert(Math.abs(safety[i] + safety[safety.length - i - 1]) < 1e-7);
  if (Math.abs(input) < 0.5) assert(Math.abs(input - safety[i]) < 1e-7, 'normal output remains linear');
}
assert.throws(() => createOutputSafetyCurve(2), RangeError);

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
  createConvolver() {
    const node = new Node('convolver', this); let buffer;
    Object.defineProperty(node, 'buffer', {
      get() { return buffer; },
      set(value) { buffer = value; node.capturedImpulse = value.getChannelData(0).slice(); },
    });
    return node;
  }
  createDynamicsCompressor() { return Object.assign(new Node('compressor', this), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node('filter', this), { frequency: new Param(), Q: new Param(), gain: new Param() }); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { length, getChannelData: channel => data[channel] }; }
  createBufferSource() { return Object.assign(new Node('source', this), { start() { this.started = true; }, stop() { this.stopped = true; } }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const originalContext = globalThis.AudioContext;
const originalWebkit = globalThis.webkitAudioContext;
try {
  globalThis.AudioContext = Context;
  const audio = new GuitarAudio();
  assert.equal(audio.preset, 'red');
  for (const id of ids) assert.equal(audio.setPreset(id), true);
  assert.equal(audio.context, null, 'preselecting a color never creates an audio context');
  assert.equal(audio.setPreset('unknown'), false);
  assert.equal(audio.setPreset(null), false);
  assert.equal(audio.setPreset('__proto__'), false);
  assert.equal(audio.preset, 'redbrown', 'invalid input preserves selected tone');
  await audio.unlock();
  const count = audio.context.nodes.length;
  const graph = audio.context.nodes.map(node => [...node.connections]);
  const roomBuffer = audio.effectNodes.room.buffer;
  assert(audio.effectNodes.room.capturedImpulse.some(sample => sample !== 0), 'convolver receives populated samples on assignment');
  const shaperCurve = audio.effectNodes.shaper.curve;
  const signatures = new Set();
  for (let index = 0; index < 500; index++) {
    const id = ids[index % ids.length], preset = GUITAR_PRESETS[id];
    audio.context.currentTime += 0.005;
    assert(audio.setPreset(id));
    const n = audio.effectNodes;
    assert.equal(audio.preset, id);
    for (const [parameter, value] of [[n.highpass.frequency, preset.highpass], [n.bass.gain, preset.bass],
      [n.mids.gain, preset.mids], [n.treble.gain, preset.treble], [n.tone.frequency, preset.cutoff],
      [n.drive.gain, preset.drive], [n.clean.gain, preset.clean], [n.distorted.gain, preset.distorted],
      [n.output.gain, preset.output], [n.dry.gain, preset.dry], [n.wet.gain, preset.wet]]) {
      assert.equal(parameter.value, value, `${id} fully replaces every parameter`);
      assert.equal(parameter.events.at(-1)[0], 'target');
      assert(parameter.events.at(-1)[3] >= 0.02, 'preset transitions are smoothed');
    }
    assert.equal(n.clean.gain.value > 0, n.distorted.gain.value === 0, 'one tone branch is selected');
    signatures.add(JSON.stringify(preset));
  }
  assert.equal(signatures.size, 5);
  assert.equal(audio.context.nodes.length, count, '500 preset switches allocate no nodes');
  audio.context.nodes.forEach((node, i) => assert.deepEqual(node.connections, graph[i], 'switches never stack or reconnect effects'));
  assert.equal(audio.effectNodes.room.buffer, roomBuffer, 'room impulse is reused');
  assert.equal(audio.effectNodes.shaper.curve, shaperCurve, 'drive curve is reused');
  assert.deepEqual(audio.compressor.connections, [audio.safety]);
  assert.deepEqual(audio.safety.connections, [audio.damper]);
  assert.deepEqual(audio.damper.connections, [audio.master]);
  audio.setPreset('mint');
  // Changing a held chord only changes frequencies of subsequent plucks. It
  // must leave the earlier chord ringing until normal release/voice stealing.
  for (const frequency of [130.8128, 164.8138]) audio.pluck(frequency);
  const ringing = [...audio.voices];
  const tailEvents = audio.effectNodes.tail.gain.events.length;
  for (const frequency of [98, 123.4708, 146.8324, 195.9977, 246.9417, 391.9954]) audio.pluck(frequency);
  assert.equal(audio.voices.length, 8, 'new chord notes add to still-ringing previous notes');
  for (const voice of ringing) {
    assert(audio.voices.includes(voice), 'changing chord frequencies preserves old voice objects');
    assert.notEqual(voice.source.stopped, true, 'a different chord never stops a sustaining note');
  }
  assert(!audio.effectNodes.tail.gain.events.slice(tailEvents).some(event => event[0] === 'target' && event[1] === 0), 'new chord notes do not gate the room');
  audio.stopAll();
  const stoppedAt = audio.context.currentTime;
  assert.equal(audio.effectNodes.tail.gain.value, 0);
  audio.pluck(220);
  assert(audio.effectNodes.tail.gain.events.some(event => event[0] === 'target' && event[1] === 1 && event[2] > stoppedAt + 1), 'immediate new notes cannot revive the stopped room');
  audio.mute(true); audio.setVolume(1);
  for (const id of ids) audio.setPreset(id);
  assert.equal(audio.master.gain.value, 0, 'color changes cannot unmute');
  assert.equal(audio.pluck(110), false);
  audio.mute(false); assert.equal(audio.master.gain.value, 1);
  audio.setPreset('darkbrown');
  const old = audio.context; old.state = 'closed';
  await audio.unlock();
  assert.notEqual(audio.context, old);
  assert.equal(audio.preset, 'darkbrown');
  assert.equal(audio.effectNodes.tone.frequency.value, GUITAR_PRESETS.darkbrown.cutoff);
  audio.setEffects({ reverb: true });
  assert.equal(audio.preset, null);
  assert.deepEqual(audio.effects, { reverb: true, distortion: false });
  audio.setPreset('black');
  assert.equal(audio.effectNodes.drive.gain.value, GUITAR_PRESETS.black.drive);
  const instruments = new GuitarAudio(); await instruments.unlock();
  const buffers = new Map();
  for (const id of ids) {
    instruments.setPreset(id); assert(instruments.pluck(110));
    buffers.set(id, instruments.voices.at(-1).source.buffer);
  }
  assert.equal(buffers.get('red'), buffers.get('mint'), 'steel voices can share their source buffer');
  assert.equal(buffers.get('red'), buffers.get('black'), 'metal tone uses the steel excitation');
  assert.notEqual(buffers.get('red'), buffers.get('darkbrown'), 'nylon has its own excitation cache');
  assert.notEqual(buffers.get('red'), buffers.get('redbrown'), 'bossa nylon has its own excitation cache');
  assert.notDeepEqual(buffers.get('darkbrown').getChannelData(0), buffers.get('redbrown').getChannelData(0), 'acoustic timbres differ in waveform, not only EQ');
  for (const id of ['darkbrown', 'redbrown']) {
    instruments.setPreset(id); assert(instruments.pluck(110));
    assert.equal(instruments.voices.at(-1).source.buffer, buffers.get(id), 'returning to an acoustic timbre reuses its exact buffer');
  }
  // Safari fallback still resumes in the same synchronous unlock call.
  globalThis.AudioContext = undefined; globalThis.webkitAudioContext = Context;
  const safari = new GuitarAudio(); safari.setPreset('mint');
  const resume = safari.unlock();
  assert.equal(safari.context.state, 'running');
  assert(safari.context.nodes.some(node => node.kind === 'source' && node.started), 'silent gesture source preserves iOS unlock');
  await resume;
} finally { globalThis.AudioContext = originalContext; globalThis.webkitAudioContext = originalWebkit; }
console.log('Preset unit tests passed: five exclusive complete tones, before-unlock selection, 500 switches without graph growth, smoothed changes, safe output curve, stop-tail draining, sustained chord changes, mute, context recreation, legacy compatibility, and iOS/WebKit unlock.');

// Generate a temporary UI fixture for the supported preview browser. The test
// button performs OfflineAudioContext renders; it makes no audible speaker output.
// Remove the fixture before publishing. Pure tests do not require a browser.
if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-presets.html', import.meta.url), `<!doctype html>
<meta charset="utf-8"><title>Preset audio QA</title>
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
  console.log('Temporary browser fixture written: tests/browser/generated/qa-audio-presets.html');
}

async function renderBrowser(moduleUrl) {
  const { GuitarAudio } = await import(moduleUrl);
  const ids = ['red', 'mint', 'black', 'darkbrown', 'redbrown'];
  const sr = 44100;
  const rms = (data, from = 0, to = data.length) => { let sum = 0; for (let i = from; i < to; i++) sum += data[i] ** 2; return Math.sqrt(sum / (to - from)); };
  async function render(id, overload = false, action = '') {
    const context = new OfflineAudioContext(2, Math.ceil(sr * 4.3), sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(id); audio.setVolume(overload ? 1 : 0.45);
    await audio.unlock();
    const notes = action === 'impulse' ? [] : overload ? [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557] : [110];
    for (let round = 0; round < (overload ? 2 : 1); round++) for (const note of notes) audio.pluck(note, overload ? 1 : 0.7);
    if (action === 'impulse') {
      audio.effectNodes.dry.gain.value = 0;
      const impulse = context.createBuffer(1, 1, sr);
      impulse.getChannelData(0)[0] = 0.2;
      const impulseSource = context.createBufferSource();
      impulseSource.buffer = impulse;
      impulseSource.connect(audio.effectNodes.output);
      impulseSource.start(0);
    }
    let suspended;
    if (action === 'stop' || action === 'mute') suspended = context.suspend(0.5).then(async () => {
      if (action === 'stop') audio.stopAll(); else audio.mute(true);
      await OfflineAudioContext.prototype.resume.call(context);
    });
    const buffer = await context.startRendering();
    if (suspended) await suspended;
    return buffer.getChannelData(0);
  }
  const samples = [], renders = [], overloadPeaks = [];
  for (const id of ids) {
    const data = await render(id); samples.push(data);
    let peak = 0; for (const value of data) peak = Math.max(peak, Math.abs(value));
    renders.push({ id, rms: rms(data, 2205, 22050), peak, finite: data.every(Number.isFinite), lateRms: rms(data, 141120, 167580) });
    const loud = await render(id, true); let loudPeak = 0; for (const value of loud) loudPeak = Math.max(loudPeak, Math.abs(value)); overloadPeaks.push(loudPeak);
  }
  const differences = [];
  for (let a = 0; a < samples.length; a++) for (let b = a + 1; b < samples.length; b++) {
    const levelA = rms(samples[a], 2205, 22050), levelB = rms(samples[b], 2205, 22050);
    let squared = 0; for (let i = 2205; i < 22050; i++) squared += (samples[a][i] / levelA - samples[b][i] / levelB) ** 2;
    differences.push(Math.sqrt(squared / (22050 - 2205)));
  }
  const stopped = await render('red', false, 'stop');
  const muted = await render('red', false, 'mute');
  const roomEnergy = {};
  for (const id of ['red', 'black', 'darkbrown']) {
    const room = await render(id, false, 'impulse');
    roomEnergy[id] = room.reduce((sum, value) => sum + value * value, 0);
  }
  const result = { renders, differences, overloadPeaks, roomEnergy,
    stoppedRms: rms(stopped, sr, sr * 3), mutedRms: rms(muted, sr, sr * 3) };
  const levels = renders.map(render => render.rms);
  result.passed = renders.every(render => render.finite && render.peak < 0.9 && render.rms > 0.005)
    && Math.max(...levels) / Math.min(...levels) < 1.8
    && differences.every(value => value > 0.08)
    && overloadPeaks.every(value => value < 0.9 && value > 0.02)
    && result.stoppedRms < 0.00001 && result.mutedRms < 0.00001
    && roomEnergy.red > 0.00001 && roomEnergy.red > roomEnergy.darkbrown * 20
    && roomEnergy.darkbrown > roomEnergy.black;
  return result;
}

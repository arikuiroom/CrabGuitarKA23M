import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../src/audio.js', import.meta.url), 'utf8');
const { synthesize, GuitarAudio, createDistortionCurve, createReverbImpulse } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const rms = samples => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
const energy = samples => samples.reduce((sum, value) => sum + value * value, 0);
const curve = createDistortionCurve();
function shape(input) {
  const position = (Math.max(-1, Math.min(1, input)) + 1) * (curve.length - 1) / 2;
  const low = Math.floor(position);
  const high = Math.min(curve.length - 1, low + 1);
  return curve[low] + (curve[high] - curve[low]) * (position - low);
}
const harmonic = (samples, frequency, sampleRate) => {
  let real = 0, imaginary = 0;
  for (let frame = 0; frame < samples.length; frame++) {
    const phase = frame * frequency * Math.PI * 2 / sampleRate;
    real += samples[frame] * Math.cos(phase);
    imaginary += samples[frame] * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) * 2 / samples.length;
};
assert.equal(curve.length, 4097);
assert.equal(curve[0], -1);
assert.equal(curve.at(-1), 1);
assert.equal(curve[(curve.length - 1) / 2], 0, 'silence must stay silent without DC');
for (let index = 0; index < curve.length; index++) {
  assert(Number.isFinite(curve[index]) && Math.abs(curve[index]) <= 1);
  assert(Math.abs(curve[index] + curve[curve.length - 1 - index]) < 1e-7, 'clipping is odd-symmetric');
  if (index) assert(curve[index] >= curve[index - 1], 'curve is monotonic');
}
const sine = Float32Array.from({ length: 8000 }, (_, frame) => 0.2 * Math.sin(2 * Math.PI * 110 * frame / 8000));
const distortedSine = sine.map(sample => shape(sample) * 0.16);
const thirdHarmonic = harmonic(distortedSine, 330, 8000) / harmonic(distortedSine, 110, 8000);
assert(thirdHarmonic > 0.1, `soft clipping must be audible: third harmonic ${thirdHarmonic}`);
assert(harmonic(sine, 330, 8000) < 1e-6, 'reference input has no third harmonic');
const sineRatio = rms(distortedSine) / rms(sine);
assert(sineRatio > 0.75 && sineRatio < 1.15, `distortion is level matched: ${sineRatio}`);
const pluck = synthesize(110, 44100, 1).map(sample => sample * 0.44 * 0.7 ** 1.15);
const distortedPluck = pluck.map(sample => shape(sample) * 0.16);
const pluckRatio = rms(distortedPluck) / rms(pluck);
assert(pluckRatio > 0.85 && pluckRatio < 1.25, `guitar remains within safe loudness range: ${pluckRatio}`);
assert(rms(pluck.map((sample, index) => sample - distortedPluck[index])) / rms(pluck) > 0.12, 'distortion changes the actual guitar waveform');
let latestTailRatio = 0;
for (const sampleRate of [8000, 44100, 48000]) {
  const impulse = createReverbImpulse(sampleRate);
  assert.equal(impulse.length, 2);
  for (const channel of impulse) {
    assert.equal(channel.length, Math.ceil(sampleRate * 1.05));
    assert(channel.every(Number.isFinite));
    assert(channel.slice(0, Math.round(sampleRate * 0.012)).every(sample => sample === 0), 'room has a short predelay');
    assert(Math.abs(energy(channel) - 0.65 ** 2) < 1e-6, 'impulse has explicit bounded energy');
    assert.equal(channel.at(-1), 0, 'room release reaches zero');
    const startRms = rms(channel.slice(sampleRate * 0.02 | 0, sampleRate * 0.15 | 0));
    const tailRms = rms(channel.slice(sampleRate * 0.8 | 0, sampleRate));
    latestTailRatio = tailRms / startRms;
    assert(latestTailRatio < 0.02 && latestTailRatio > 0, `room fades smoothly instead of staying loud: ${latestTailRatio}`);
    assert(energy(channel.slice(sampleRate * 0.25 | 0, sampleRate * 0.65 | 0)) > 0.005, 'impulse response contains audible late room energy');
    // Unit impulse convolved with the room is exactly this response: dry ends
    // immediately, while the 20% wet path persists and decays for ~1 second.
    const dry = new Float32Array(channel.length); dry[0] = 1;
    const reverberant = channel.map((sample, index) => sample * 0.2 + dry[index] * 0.9);
    assert.equal(reverberant[0], Math.fround(0.9));
    assert(energy(reverberant.slice(1)) > 0.015 && energy(reverberant.slice(1)) < 0.018);
    assert(energy(reverberant) < energy(dry), 'room mix leaves headroom for summed dry and wet');
  }
  assert.notDeepEqual(impulse[0], impulse[1], 'stereo sides are decorrelated');
  assert.deepEqual(createReverbImpulse(sampleRate), impulse, 'room generation is deterministic');
}
assert.throws(() => createDistortionCurve(2), RangeError);
assert.throws(() => createReverbImpulse(0), RangeError);
assert.throws(() => createReverbImpulse(44100, 0), RangeError);

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
class MockContext {
  constructor() {
    this.nodes = []; this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0;
    this.destination = new Node('destination', this);
  }
  createGain() { return Object.assign(new Node('gain', this), { gain: new Param(1) }); }
  createWaveShaper() { return new Node('shaper', this); }
  createConvolver() { return new Node('convolver', this); }
  createDynamicsCompressor() { return Object.assign(new Node('compressor', this), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node('filter', this), { frequency: new Param(), Q: new Param(), gain: new Param() }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData(channel) { return data[channel]; } };
  }
  createBufferSource() { return Object.assign(new Node('source', this), { start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } }); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
function allDestinationPaths(node, destination, seen = []) {
  assert(!seen.includes(node), 'effect graph must not contain feedback cycles');
  if (node === destination) return [[node]];
  return node.connections.flatMap(next => allDestinationPaths(next, destination, [...seen, node]).map(path => [node, ...path]));
}
const originalContext = globalThis.AudioContext;
try {
  globalThis.AudioContext = MockContext;
  const audio = new GuitarAudio();
  assert.equal(audio.preset, 'red');
  audio.setEffects({ reverb: true });
  audio.setEffects({ distortion: true });
  assert.equal(audio.context, null, 'tone buttons do not create or unlock audio outside the gesture');
  assert.deepEqual(audio.effects, { distortion: true, reverb: true });
  await audio.unlock();
  const { clean, distorted, dry, wet, room, shaper, tail } = audio.effectNodes;
  assert.equal(clean.gain.value, 0); assert.equal(distorted.gain.value, 0.16);
  assert.equal(dry.gain.value, 0.9); assert.equal(wet.gain.value, 0.2);
  assert.equal(shaper.oversample, '2x'); assert.deepEqual(shaper.curve, curve);
  assert.equal(room.normalize, false); assert.equal(room.buffer.numberOfChannels, 2);
  assert.notDeepEqual(room.buffer.getChannelData(0), room.buffer.getChannelData(1));
  const paths = allDestinationPaths(audio.effectInput, audio.context.destination);
  assert.equal(paths.length, 4, 'clean and distorted can each feed the dry and room paths');
  for (const path of paths) {
    assert(path.includes(audio.compressor));
    assert.equal(path.at(-2), audio.master, 'volume and mute are after every effect and tail');
  }
  const count = audio.context.nodes.length;
  const connections = audio.context.nodes.map(node => [...node.connections]);
  for (let index = 0; index < 200; index++) {
    audio.context.currentTime += 0.01;
    audio.setEffects({ distortion: index % 2 === 0, reverb: index % 3 === 0 });
  }
  assert.equal(audio.context.nodes.length, count, 'repeated toggles never allocate extra nodes');
  audio.context.nodes.forEach((node, index) => assert.deepEqual(node.connections, connections[index], 'toggles never reconnect/stack effect paths'));
  for (const node of [clean, distorted, dry, wet]) {
    assert(node.gain.events.some(event => event[0] === 'target' && event[3] >= 0.01), 'every switch uses smooth gain automation');
    assert(node.gain.events.some(event => event[0] === 'hold'), 'repeated switches hold the current gain');
  }
  audio.setEffects({ distortion: false, reverb: false });
  assert.equal(clean.gain.value, 1); assert.equal(distorted.gain.value, 0);
  assert.equal(dry.gain.value, 1); assert.equal(wet.gain.value, 0);
  audio.setEffects({ reverb: true });
  assert.equal(audio.effects.distortion, false, 'partial updates preserve the other tone');
  audio.setEffects({ reverb: 'no' }); audio.setEffects(null);
  assert.equal(audio.effects.reverb, true, 'invalid inputs do not silently flip settings');
  audio.pluck(110);
  assert.deepEqual(audio.voices[0].gain.connections, [audio.effectInput], 'played notes traverse effects');
  const beforeStop = audio.context.nodes.length;
  audio.stopAll();
  assert.equal(audio.voices.length, 0); assert.equal(tail.gain.value, 0);
  assert.equal(audio.context.nodes.length, beforeStop, 'stop preserves the reusable room');
  assert(tail.gain.events.some(event => event[0] === 'set' && event[1] === 0 && event[2] >= audio.context.currentTime + 0.072), 'room cuts only after the final output fades');
  audio.pluck(220); assert.equal(tail.gain.value, 1, 'next pluck schedules a smooth room reopening');
  audio.mute(); assert.equal(audio.master.gain.value, 0); assert.equal(tail.gain.value, 0);
  audio.setVolume(0.8); audio.setEffects({ distortion: true });
  assert.equal(audio.master.gain.value, 0, 'changing volume or effects cannot defeat mute');
  assert.equal(audio.pluck(110), false);
  audio.mute(false); assert.equal(audio.master.gain.value, 0.8);
  const oldRoom = audio.effectNodes.room;
  audio.context.state = 'closed';
  await audio.unlock();
  assert.notEqual(audio.effectNodes.room, oldRoom, 'closed contexts rebuild graph once');
  assert.deepEqual(audio.effects, { distortion: true, reverb: true }, 'preferences survive context recreation');
  assert.equal(audio.effectNodes.distorted.gain.value, 0.16); assert.equal(audio.effectNodes.wet.gain.value, 0.2);
  // Older WebKit may not provide cancelAndHoldAtTime; cover the safe fallback.
  audio.effectNodes.clean.gain.cancelAndHoldAtTime = undefined;
  audio.setEffects({ distortion: false });
  assert(audio.effectNodes.clean.gain.events.some(event => event[0] === 'cancel'));
} finally {
  globalThis.AudioContext = originalContext;
}
console.log(`Effects tests passed: third harmonic ${(thirdHarmonic * 100).toFixed(1)}%; distortion RMS ×${pluckRatio.toFixed(2)}; reverb late/early RMS ${(latestTailRatio * 100).toFixed(2)}%. Stereo decay, fixed graph, 200 toggles, combined tones, master mute/volume, stop-tail suppression, and context recreation verified.`);

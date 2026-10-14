import assert from 'node:assert/strict';
import { GuitarAudio, GUITAR_PRESETS } from '../../src/audio.js';

// Deterministic scheduling/retained-node regression. This is not a native DSP,
// device latency or browser-memory benchmark. Ended events run as time advances.
class Param {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  constructor(kind, context) {
    this.kind = kind; this.context = context; this.connections = new Set();
    context.created[kind] = (context.created[kind] || 0) + 1;
  }
  connect(node) { this.connections.add(node); this.context.connected.add(this); }
  disconnect() { this.connections.clear(); this.context.connected.delete(this); }
}
class Context {
  constructor() {
    this.currentTime = 0; this.sampleRate = 44100; this.state = 'running';
    this.created = {}; this.connected = new Set(); this.sources = new Set();
    this.destination = new Node('destination', this);
  }
  createGain() { return Object.assign(new Node('gain', this), { gain: new Param(1) }); }
  createBiquadFilter() { return Object.assign(new Node('filter', this), {
    gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createWaveShaper() { return new Node('shaper', this); }
  createConvolver() { return new Node('convolver', this); }
  createDynamicsCompressor() { return Object.assign(new Node('compressor', this),
    Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()]))); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, getChannelData: channel => data[channel] };
  }
  createBufferSource() {
    return Object.assign(new Node('source', this), { detune: new Param(), stopAt: Infinity,
      start(time) {
        this.startAt = time;
        this.endAt = time + this.buffer.length / this.buffer.sampleRate * 2 ** (4 / 12);
        this.context.sources.add(this);
      },
      stop(time) { this.stopAt = time; },
    });
  }
  advance(duration) {
    this.currentTime += duration;
    for (const source of this.sources) {
      if (Math.min(source.stopAt, source.endAt) > this.currentTime + 1e-10) continue;
      this.sources.delete(source); source.onended?.();
      assert.equal(source.connections.size, 0, 'ended source releases its connection');
    }
  }
}
const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
const original = globalThis.AudioContext;
const summaries = [];
try {
  globalThis.AudioContext = Context;
  for (const fallback of [false, true]) {
    Param.prototype.cancelAndHoldAtTime = fallback ? undefined : function () {};
    const audio = new GuitarAudio();
    for (const invalid of [-1, 6, 0.5, NaN, null, '0']) {
      assert.equal(audio.pluck(110, .7, invalid), false);
      assert.equal(audio.pluckHarmonic(110, .7, invalid), false);
    }
    assert.equal(audio.context, null, 'invalid indices do not create audio');
    await audio.unlock(); const context = audio.context; context.advance(.01);
    const fixed = context.connected.size, room = audio.effectNodes.room;
    const impulse = room.buffer, graph = audio.effectNodes, dryGraph = audio.dryNodes;
    const effects = { convolver: context.created.convolver, shaper: context.created.shaper };
    const near = (a, b, label) => assert(Math.abs(a - b) < 1e-9, label || `${a} != ${b}`);
    function inspect(maxLive = 10) {
      assert(audio.voices.length <= 6, 'indexed playing has at most six active voices');
      assert(audio.liveVoices.size <= maxLive, 'only short source releases overlap');
      assert.equal(context.connected.size, fixed + 3 * audio.liveVoices.size,
        'each unfinished voice contributes only the original source/filter/gain');
      assert.equal(audio.stringVoices.filter(Boolean).length, audio.voices.length);
      assert.equal(context.created.convolver, effects.convolver);
      assert.equal(context.created.shaper, effects.shaper);
      assert.equal(audio.effectNodes, graph); assert.equal(audio.dryNodes, dryGraph);
      assert.equal(audio.effectNodes.room, room); assert.equal(room.buffer, impulse);
      assert(audio.cache.size <= 48);
      for (const voice of audio.voices) assert.equal(audio.stringVoices[voice.stringIndex], voice);
      for (const voice of audio.liveVoices) {
        const state = audio.automation.get(voice.gain.gain);
        assert(!state || state.events.length <= 100, 'fade automation has a fixed bound');
      }
    }
    frequencies.forEach((frequency, index) => assert(audio.pluck(frequency, .7, index)));
    context.advance(.2);
    const old = audio.stringVoices[2], untouched = audio.stringVoices[3];
    const untouchedEnvelope = structuredClone(audio.automation.get(untouched.gain.gain));
    const oldLevel = audio._parameterValue(old.gain.gain, context.currentTime);
    const start = context.currentTime;
    assert(audio.pluck(164.8138, .7, 2));
    const fresh = audio.stringVoices[2];
    assert.equal(fresh.stringIndex, 2); assert.equal(fresh.source.startAt, start,
      'same-string replacement starts immediately, without waiting for the old fade');
    assert(!audio.voices.includes(old)); assert(audio.liveVoices.has(old));
    near(old.source.stopAt, start + .02, 'old vibration ends after the 20 ms fade');
    near(audio._parameterValue(old.gain.gain, start), oldLevel, 'fade starts continuously');
    near(audio._parameterValue(old.gain.gain, start + .01), oldLevel / 2, 'raised cosine midpoint');
    near(audio._parameterValue(old.gain.gain, start + .02), 0, 'fade reaches exact silence');
    assert.equal(untouched.source.stopAt, Infinity, 'other strings keep their natural lifetime');
    assert.deepEqual(audio.automation.get(untouched.gain.gain), untouchedEnvelope,
      'other strings receive no release automation');
    assert.equal(audio.effectNodes.tail.gain.value, 1, 'shared physical room is not choked');
    audio.setBend(-3, 35);
    assert.equal(old.source.detune.value, -300, 'arm still affects releasing sources');
    assert.equal(fresh.source.detune.value, -300, 'arm affects the fresh source');
    assert.equal(untouched.source.detune.value, -300, 'arm affects other strings');
    context.advance(.021); inspect();
    assert.equal(old.ended, true); assert(!audio.liveVoices.has(old));
    for (const node of [old.source, old.tone, old.gain]) assert.equal(node.connections.size, 0);
    assert.equal(audio.stringVoices[2], fresh, 'old ended callback cannot clear the replacement');

    // Every color switch preserves all voices. Subsequent normal/harmonic notes
    // share one index, even when excitation or the ukulele register changes.
    for (const preset of Object.keys(GUITAR_PRESETS)) {
      const before = [...audio.voices], beforeStops = before.map(voice => voice.source.stopAt);
      assert(audio.setPreset(preset));
      assert.deepEqual(audio.voices, before, 'preset selection does not interrupt ringing strings');
      assert.deepEqual(before.map(voice => voice.source.stopAt), beforeStops);
      context.advance(.03);
      let previous = audio.stringVoices[2];
      assert(audio.pluckHarmonic(146.832384, .8, 2));
      assert(!audio.voices.includes(previous));
      near(previous.source.stopAt, context.currentTime + .02);
      assert.equal(audio.stringVoices[2].harmonic, preset !== 'redbrown');
      context.advance(.03);
      previous = audio.stringVoices[2];
      assert(audio.pluck(146.832384, .8, 2));
      assert(!audio.voices.includes(previous));
      near(previous.source.stopAt, context.currentTime + .02);
      inspect();
    }
    context.advance(5); inspect();
    assert.equal(audio.liveVoices.size, 0); assert(audio.stringVoices.every(voice => voice === null));

    // A 200 Hz input stream is deliberately faster than ordinary hand playing.
    // Test both one repeatedly hit string and six-string strums for 1,000 hits.
    let maxLive = 0;
    for (const singleString of [true, false]) {
      for (let tick = 0; tick < 1000; tick++) {
        context.advance(.005);
        const index = singleString ? 2 : tick % 6;
        if (tick % 100 === 0) audio.setPreset(Object.keys(GUITAR_PRESETS)[tick / 100 % 5]);
        assert(tick % 2 ? audio.pluck(frequencies[index], .7, index)
          : audio.pluckHarmonic(frequencies[index], .7, index));
        inspect(singleString ? 5 : 10);
        maxLive = Math.max(maxLive, audio.liveVoices.size);
      }
      context.advance(5); inspect();
      assert.equal(context.connected.size, fixed);
    }

    // Coalesced pointer events within one audio quantum have not sounded yet.
    // Canceling those unheard predecessors prevents a burst from retaining
    // 1,000 scheduled sources while still starting the newest note immediately.
    for (let index = 0; index < 1000; index++) {
      assert(audio.pluck(110, .7, 1)); inspect(1);
      assert.equal(audio.stringVoices[1].source.startAt, context.currentTime);
    }
    context.advance(0); assert.equal(context.sources.size, 1);
    audio.mute(true); assert(audio.stringVoices.every(voice => voice === null));
    assert.equal(audio.voices.length, 0); assert.equal(audio.pluck(110, .7, 1), false);
    context.advance(5); assert.equal(context.connected.size, fixed);
    audio.mute(false); assert(audio.pluck(110, .7, 1));
    audio.setDamped(true); assert.equal(audio.pluckHarmonic(110, .7, 1), false);
    audio.setDamped(false); context.advance(5);
    assert.equal(audio.liveVoices.size, 0); assert.equal(context.connected.size, fixed);

    // Non-indexed callers retain their existing polyphonic contract.
    audio.pluck(110); audio.pluck(110); audio.pluckHarmonic(110);
    assert.equal(audio.voices.length, 3); assert(audio.stringVoices.every(voice => voice === null));
    context.state = 'closed'; await audio.unlock(); audio.context.advance(.01);
    assert.equal(audio.voices.length, 0); assert(audio.stringVoices.every(voice => voice === null));
    assert(audio.pluck(220, .8, 4)); assert.equal(audio.stringVoices[4].stringIndex, 4);
    summaries.push({ fallback, maxLiveAt200HitsPerSecond: maxLive,
      fixedConnectedNodes: fixed, convolvers: effects.convolver, shapers: effects.shaper,
      indexedHitsTested: 3000, note: 'shared room naturally decays; no per-string room DSP' });
  }
} finally {
  globalThis.AudioContext = original;
  Param.prototype.cancelAndHoldAtTime = function () {};
}
console.log('String replacement tests passed: immediate attack, 20 ms continuous fade, independent strings, normal/harmonic/preset identity, arm, mute/damping, burst cleanup and unchanged effect graph.');
console.log(JSON.stringify(summaries, null, 2));

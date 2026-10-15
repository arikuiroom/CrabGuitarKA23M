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

const original = globalThis.AudioContext;
try {
 globalThis.AudioContext = Context;
 const audio = new GuitarAudio(); await audio.unlock();
 const c=audio.context; c.advance(.2);
 for (const seconds of [.06,.11,.24,2.7,3.8]) {
   const now=c.currentTime; audio.pluckTimed(220,.55,5,seconds);
   const voice=audio.stringVoices[5];
   assert.equal(voice.source.startAt,now,'no 84ms stop/reopen delay');
   assert(Math.abs(voice.stopAt-(now+seconds+.021))<1e-9,'captured duration is not clamped to 120ms or 2s');
   assert(voice.source.buffer.length/c.sampleRate>=seconds,'PCM covers long hum');
   c.advance(seconds+.05);
 }
 for(let i=0;i<100;i++) {
   const now=c.currentTime; audio.pluckTimed(220,.55,5,.08);
   assert.equal(audio.stringVoices[5].start,now);
   c.advance(.14);
 }
 assert(audio.liveVoices.size<=1);audio.stopAll();c.advance(.2);
 assert.equal(audio.liveVoices.size,0);
 console.log('Humming audio schedule: zero added onset delay; 60/110/240/2700/3800ms gates exact plus21ms release; 100 repeated notes cleaned.');
} finally { globalThis.AudioContext=original; }

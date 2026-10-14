import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { GuitarAudio } from '../../src/audio.js';

// This is a deterministic lifecycle/resource test, not a native audio memory
// benchmark. Unlike the other mocks, it delivers ended events as audio time
// advances and does not keep a log of every historical node or AudioParam call.
// Native engine memory, rendering cost and hardware latency need browser QA.
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
    this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100;
    this.created = {}; this.connected = new Set(); this.sources = new Set();
    this.ended = 0; this.destination = new Node('destination', this);
  }
  createGain() { return Object.assign(new Node('gain', this), { gain: new Param(1) }); }
  createBiquadFilter() { return Object.assign(new Node('filter', this), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createWaveShaper() { return new Node('shaper', this); }
  createConvolver() { return new Node('convolver', this); }
  createDynamicsCompressor() {
    return Object.assign(new Node('compressor', this), Object.fromEntries(
      ['threshold', 'knee', 'ratio', 'attack', 'release'].map(name => [name, new Param()])));
  }
  createAnalyser() {
    return Object.assign(new Node('analyser', this), {
      getFloatTimeDomainData(samples) { samples.fill(0); },
    });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, numberOfChannels: channels,
      getChannelData: channel => data[channel] };
  }
  createBufferSource() {
    return Object.assign(new Node('source', this), {
      detune: new Param(), stopAt: Infinity,
      start(time) {
        // The slowest allowed bend is -4 semitones. Keep a conservative upper
        // lifetime bound without pretending this mock renders detune samples.
        this.endAt = Math.max(this.context.currentTime, time)
          + this.buffer.length / this.buffer.sampleRate * 2 ** (4 / 12);
        this.context.sources.add(this);
      },
      stop(time) { this.stopAt = time; },
    });
  }
  advance(seconds) {
    this.currentTime += seconds;
    for (const source of this.sources) {
      if (Math.min(source.stopAt, source.endAt) > this.currentTime) continue;
      this.sources.delete(source);
      source.onended?.();
      this.ended++;
      assert.equal(source.connections.size, 0, 'ended source disconnects its output');
    }
  }
}

const before = globalThis.AudioContext;
const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
const presets = ['red', 'mint', 'black', 'darkbrown', 'redbrown'];
const summary = [];
try {
  globalThis.AudioContext = Context;
  for (const fallback of [false, true]) {
    const audio = new GuitarAudio();
    await audio.unlock();
    const context = audio.context;
    context.advance(.01); // finish the single gesture-unlock source
    const fixedNodes = context.connected.size;
    const room = audio.effectNodes.room;
    const impulse = room.buffer;
    const effectNodes = audio.effectNodes;
    const dryNodes = audio.dryNodes;
    if (fallback) {
      // Match WebKit's cancelScheduledValues fallback for every new parameter.
      Param.prototype.cancelAndHoldAtTime = undefined;
    } else Param.prototype.cancelAndHoldAtTime = function () {};

    let maxLive = 0, maxEvents = 0, maxConnected = 0, notes = 0;
    function inspect() {
      assert(audio.voices.length <= 12, 'active voices stay within the polyphony cap');
      assert(audio.cache.size <= 48, 'waveform cache stays bounded');
      assert.equal(audio.liveVoices.size, context.sources.size,
        'live voices track the actual unfinished sources');
      assert.equal(context.connected.size, fixedNodes + audio.liveVoices.size * 3,
        'only unfinished voices add source/filter/gain nodes to the fixed graph');
      for (const node of context.connected) {
        for (const parameter of Object.values(node)) {
          if (!(parameter instanceof Param)) continue;
          const state = audio.automation.get(parameter);
          if (!state) continue;
          maxEvents = Math.max(maxEvents, state.events.length);
          assert(state.events.length <= 100, 'tracked automation is bounded by future ramps, not playback history');
          assert(Number.isFinite(audio._parameterValue(parameter, context.currentTime)),
            'all held automation values stay finite');
        }
      }
      maxLive = Math.max(maxLive, audio.liveVoices.size);
      maxConnected = Math.max(maxConnected, context.connected.size);
    }

    // Voice stealing must release its nodes, not merely remove the voice from
    // the active array. Run a continuous high-rate section without stopAll.
    for (let tick = 0; tick < 1000; tick++) {
      assert(audio.pluck(frequencies[tick % 6])); notes++;
      inspect();
      assert(audio.liveVoices.size <= 14, '50 notes/sec retains at most two 35 ms releases beyond 12 voices');
      context.advance(.02);
    }
    context.advance(5);
    assert.equal(audio.liveVoices.size, 0, 'ordinary notes naturally end');
    assert.equal(context.connected.size, fixedNodes, 'natural endings return to the fixed graph');

    const checkpoints = [];
    // Thirty minutes of simulated uninterrupted mixed playing. Each 150-second
    // block repeats all five presets, bends, cut batches, damping and volume.
    // Compare resource snapshots after the warm-up and at the end, rather than
    // interpreting a growing lifetime allocation count as a retained-node leak.
    for (let block = 0; block < 12; block++) {
      const started = performance.now();
      for (let tick = 0; tick < 1500; tick++) {
        if (tick % 30 === 0) {
          audio.stopAll();
          audio.setPreset(presets[Math.floor(tick / 30) % 5]);
        }
        audio.setBend((tick % 9) - 4, tick % 2 ? 35 : 80);
        audio.setVolume(.18 + (tick % 5) * .01);
        if (tick % 37 === 0) {
          audio.setDamped(true); audio.setDamped(false);
        }
        if (tick % 13 === 0) {
          assert(audio.cutStrum(frequencies)); notes += 6;
        } else {
          const frequency = frequencies[tick % 6];
          assert(tick % 3 ? audio.pluck(frequency) : audio.pluckHarmonic(frequency)); notes++;
        }
        inspect();
        context.advance(.1);
      }
      checkpoints.push({ block: block + 1, cache: audio.cache.size,
        live: audio.liveVoices.size, connected: context.connected.size,
        trackedTailEvents: audio.automation.get(audio.effectNodes.tail.gain)?.events.length || 0,
        milliseconds: Number((performance.now() - started).toFixed(1)) });
      assert.equal(context.created.convolver, 1, 'preset changes reuse a single convolver');
      assert.equal(context.created.shaper, 3, 'preset changes reuse both tone shapers and output safety');
      assert.equal(audio.effectNodes, effectNodes, 'wet effect graph is stable');
      assert.equal(audio.dryNodes, dryNodes, 'dry effect graph is stable');
      assert.equal(audio.effectNodes.room, room); assert.equal(room.buffer, impulse);
    }
    const shape = row => Object.fromEntries(Object.entries(row)
      .filter(([key]) => key !== 'block' && key !== 'milliseconds'));
    assert.deepEqual(shape(checkpoints.at(-1)), shape(checkpoints[1]),
      'the final resource snapshot matches the warmed-up snapshot after 30 simulated minutes');
    audio.stopAll(); context.advance(5);
    assert.equal(audio.voices.length, 0); assert.equal(audio.liveVoices.size, 0);
    assert.equal(context.sources.size, 0); assert.equal(context.connected.size, fixedNodes);

    // Force genuine cache eviction with more pitches than fit in the cache.
    // Ending each source also checks that evicted buffers are not retained by
    // the engine's live-voice collection.
    for (let index = 0; index < 70; index++) {
      assert(audio.pluck(100 + index)); context.advance(5); inspect();
    }
    assert.equal(audio.cache.size, 48);
    assert.equal(audio.voices.length, 0); assert.equal(audio.liveVoices.size, 0);
    assert.equal(context.connected.size, fixedNodes);
    summary.push({ fallback, simulatedMinutes: 30, notes, maxLive,
      maxTrackedEventsPerParameter: maxEvents, fixedConnectedNodes: fixedNodes,
      maxConnectedNodes: maxConnected, endedSources: context.ended,
      warm: checkpoints[1], final: checkpoints.at(-1), cacheAfterEviction: audio.cache.size });
  }
} finally {
  globalThis.AudioContext = before;
  Param.prototype.cancelAndHoldAtTime = function () {};
}
console.log('Audio resource regression passed. Deterministic lifecycle simulation; not a browser/native-memory measurement.');
console.log(JSON.stringify(summary, null, 2));

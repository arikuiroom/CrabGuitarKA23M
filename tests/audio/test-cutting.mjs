import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { GuitarAudio, GUITAR_PRESETS, getPlaybackFrequency, synthesizeTimbre } from '../../src/audio.js';

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
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const originalContext = globalThis.AudioContext;
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);
const frequencies = [82.406889, 130.812783, 164.813778, 195.997718, 261.625565, 329.627557];
function reaches(node, target, seen = new Set()) {
  if (node === target) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.connections.some(next => reaches(next, target, seen));
}
try {
  globalThis.AudioContext = Context;
  // Simulate time passing during a cold buffer's synchronous creation.
  const coldAudio = new GuitarAudio(); await coldAudio.unlock();
  let extraUnlockSources = 0;
  const createSource = coldAudio.context.createBufferSource.bind(coldAudio.context);
  coldAudio.context.createBufferSource = () => { extraUnlockSources++; return createSource(); };
  await coldAudio.unlock(); await coldAudio.unlock();
  assert.equal(extraUnlockSources, 0, 'running unlock has no repeated silent sources');
  const createBuffer = coldAudio.context.createBuffer.bind(coldAudio.context);
  coldAudio.context.createBuffer = (...args) => { coldAudio.context.currentTime += 0.03; return createBuffer(...args); };
  coldAudio.pluck(110);
  close(coldAudio.voices[0].source.startTime, 0.03, 'cold note attack is anchored after synthesis');
  coldAudio.pluck(146.832384);
  close(coldAudio.voices[1].source.startTime, 0.06, 'next cold note has no stale attack timestamp');
  for (const preset of Object.keys(GUITAR_PRESETS)) {
    const audio = new GuitarAudio(); audio.setPreset(preset); await audio.unlock();
    audio.pluck(110, 0.8); audio.pluckHarmonic(110, 0.8);
    const priorVoices = [...audio.voices];
    const priorGainEvents = priorVoices.map(voice => voice.gain.gain.events.slice());
    audio.context.currentTime = 0.5;
    const damperEvents = audio.damper.gain.events.slice();
    for (const invalid of [[], frequencies.slice(0, 5), [...frequencies, 440], new Array(6), [NaN, ...frequencies.slice(1)], [0, ...frequencies.slice(1)]]) {
      assert.equal(audio.cutStrum(invalid), false);
      assert.deepEqual(audio.voices, priorVoices, 'invalid stroke never kills a valid ringing note');
      assert.deepEqual(audio.damper.gain.events, damperEvents);
    }
    assert.equal(audio.cutStrum(frequencies, NaN), false); assert.equal(audio.cutStrum(frequencies, 0), false);
    assert.equal(audio.cutStrum(frequencies, 0.9), true);
    assert.equal(audio.voices.length, 6, 'one stroke replaces previous chord with exactly six cut voices');
    const stroke = [...audio.voices], first = stroke[0].source.startTime;
    close(first, 0.524, 'old output fades and compressor drains before the stroke');
    close(audio._parameterValue(audio.damper.gain, 0.506), 0.5, 'old full-output tail fades smoothly');
    close(audio._parameterValue(audio.damper.gain, 0.512), 0, 'old output reaches zero before stopping');
    close(audio._parameterValue(audio.effectNodes.tail.gain, 0.506), 1, 'room does not jump before the output fade');
    close(audio._parameterValue(audio.effectNodes.tail.gain, 0.512), 0, 'old room is gated after the fade');
    close(audio._parameterValue(audio.effectNodes.tail.gain, 2), 0, 'dry cut cannot reopen old reverb');
    for (const [index, voice] of priorVoices.entries()) {
      close(voice.source.stopTime, 0.513, 'prior normal and harmonic sources are stopped after the fade');
      assert.deepEqual(voice.gain.gain.events, priorGainEvents[index], 'old voices stay continuous throughout the full-output fade');
    }
    for (const [index, cut] of stroke.entries()) {
      const gain = cut.gain.gain, start = cut.source.startTime;
      close(start, first + index * 0.0035, 'ordered strings are only 3.5 ms apart');
      assert.equal(cut.frequency, frequencies[index]);
      assert.equal(cut.playbackFrequency, getPlaybackFrequency(frequencies[index], preset));
      assert.equal(cut.cut, true); assert.equal(cut.harmonic, false);
      assert.equal(cut.source.buffer.length, Math.ceil(44100 * 0.14));
      assert.deepEqual(cut.gain.connections, [audio.dryInput]);
      assert(reaches(cut.gain, audio.compressor), 'dry notes retain compressor/safety/mute/volume');
      assert(!reaches(cut.gain, audio.effectNodes.room), 'dry notes have no convolver send');
      const samples = cut.source.buffer.getChannelData(0);
      assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
      assert(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 0.821));
      const level = 0.44 * 0.9 ** 1.15;
      close(audio._parameterValue(gain, start), 0, 'cut attack starts at zero');
      close(audio._parameterValue(gain, start + 0.0012), level * 1.18, 'cut has a strong short pick attack');
      close(audio._parameterValue(gain, start + 0.038), level * 0.18, 'cut body falls quickly');
      close(audio._parameterValue(gain, start + 0.105), 0, 'cut reaches exact silence at 105 ms');
      close(audio._parameterValue(gain, start + 1), 0, 'cut cannot revive');
      let early = 0, late = 0;
      for (let frame = 0; frame < samples.length; frame++) {
        const time = frame / 44100, value = samples[frame] * audio._parameterValue(gain, start + time);
        if (time >= 0.005 && time < 0.04) early += value ** 2;
        if (time >= 0.105 && time < 0.14) late += value ** 2;
      }
      assert(early > 0.01 && late === 0, 'short stroke has an audible attack and exact zero-ended decay');
    }
    for (const field of ['highpass', 'bass', 'mids', 'treble', 'clean', 'drive', 'distorted', 'tone', 'output', 'dry']) {
      const param = ['highpass', 'tone'].includes(field) ? 'frequency' : 'gain';
      close(audio.dryNodes[field][param].value, audio.effectNodes[field][param].value, 'dry bus preserves selected preset color');
    }
    audio.setBend(4, 35);
    close(audio._parameterValue(stroke[0].source.detune, 0.535), 400, 'cut still responds to the arm');
    audio.context.currentTime = 0.51;
    assert(audio.cutStrum([...frequencies].reverse(), 0.7), 'a distinct rapid stroke is not dropped by a time guard');
    assert.equal(audio.voices.length, 6, 'rapid strokes replace rather than stack');
    assert.deepEqual(audio.voices.map(voice => voice.frequency), [...frequencies].reverse());
    for (const voice of stroke) assert(voice.source.stopTime < voice.source.startTime, 'superseded queued cut cannot play later');
    audio.context.currentTime = 0.514;
    audio.damper.gain.cancelAndHoldAtTime = undefined; audio.damper.gain.value = 999;
    const held = audio._parameterValue(audio.damper.gain, 0.514);
    assert(audio.cutStrum(frequencies));
    close(audio._parameterValue(audio.damper.gain, 0.514), held, 'rapid cut stays continuous on WebKit without cancelAndHold');
    audio.setDamped(true); assert.equal(audio.cutStrum(frequencies), false, 'held damper blocks a stroke');
    audio.setDamped(false); audio.mute(true); assert.equal(audio.cutStrum(frequencies), false, 'mute blocks a stroke');
    audio.mute(false);
    for (let index = 0; index < 60; index++) {
      audio.context.currentTime += 0.01;
      assert(audio.cutStrum(frequencies.map(hz => hz + index)));
      assert.equal(audio.voices.length, 6); assert(audio.cache.size <= 48);
    }
    for (const voice of [...audio.liveVoices]) voice.source.onended();
    assert.equal(audio.voices.length, 0); assert.equal(audio.liveVoices.size, 0);
  }
  const bossa = new GuitarAudio(); bossa.setPreset('redbrown'); await bossa.unlock();
  const open = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
  for (const [index, frequency] of open.entries()) {
    assert(bossa.pluck(frequency));
    const voice = bossa.voices.at(-1), sounding = frequency;
    assert.equal(voice.playbackFrequency, sounding);
    assert.deepEqual(voice.source.buffer.getChannelData(0), synthesizeTimbre(sounding, 44100, 3, 'bossa'),
      'bossa source waveform preserves the full guitar register');
  }
  for (const frequency of [195.9977, 195.997718, 196, 146.832384 * 2 ** (5 / 12)]) {
    assert.equal(getPlaybackFrequency(frequency, 'redbrown'), frequency, 'rounded or fretted G3 never accidentally octave-lifts');
  }
  assert.equal(getPlaybackFrequency(184.997211, 'redbrown'), 184.997211, 'F-sharp 3 remains at the requested guitar pitch');
  for (const preset of ['red', 'mint', 'black', 'darkbrown']) assert.equal(getPlaybackFrequency(110, preset), 110);
  const nylon = new GuitarAudio(); nylon.setPreset('darkbrown'); await nylon.unlock();
  nylon.pluck(110, 0.8);
  const normal = nylon.voices[0], priorGain = normal.gain.gain.events.slice(), roomEvents = nylon.effectNodes.tail.gain.events.slice();
  assert(nylon.pluckHarmonic(110, 0.8));
  const harmonic = nylon.voices[1];
  assert.equal(harmonic.source.buffer.length, Math.ceil(44100 * 0.21));
  assert.equal(normal.source.buffer.length, 44100 * 3);
  assert.deepEqual(harmonic.gain.connections, [nylon.dryInput]);
  assert(!reaches(harmonic.gain, nylon.effectNodes.room));
  assert.deepEqual(normal.gain.gain.events, priorGain); assert.equal(normal.source.stopTime, undefined);
  assert.deepEqual(nylon.effectNodes.tail.gain.events, roomEvents, 'dry harmonic leaves normal nylon/reverb untouched');
  close(nylon._parameterValue(harmonic.gain.gain, 0.2), 0, 'nylon pinch ends at 200 ms');
  assert(nylon._parameterValue(harmonic.gain.gain, 0.025) > 0.1);
  nylon.setBend(-4); close(nylon._parameterValue(harmonic.gain.gain, 0.2), 0, 'negative arm cannot stretch the short harmonic envelope');
  const shortBuffer = harmonic.source.buffer;
  nylon.setPreset('red'); nylon.pluckHarmonic(110, 0.8);
  assert.notEqual(nylon.voices.at(-1).source.buffer, shortBuffer, 'nylon cannot contaminate ordinary harmonic cache');
  assert.equal(nylon.voices.at(-1).source.buffer.length, 44100 * 3);
} finally { globalThis.AudioContext = originalContext; }
console.log('Cutting/refinement audio tests passed: five presets; six ordered dry chord notes; 12 ms smooth full-output choke; exact 105 ms cut endings; rapid strokes replace queued voices; no convolver send; unchanged arm/mute/damping; bounded cache; 200 ms dry nylon harmonics preserving ordinary nylon sustain.');

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-cut-refinements.html', import.meta.url), `<!doctype html><meta charset="utf-8"><title>Cut and acoustic sound QA</title><button id="run">Run audio tests</button><pre id="result">Ready</pre><script type="module">\n${renderRefinementsBrowser.toString()}\nconst run=async()=>{document.querySelector('#run').disabled=true;document.querySelector('#result').textContent='Rendering…';try{window.qaResult=await renderRefinementsBrowser(new URL('../../../dist/audio.js',location.href).href);document.querySelector('#result').textContent=JSON.stringify(window.qaResult,null,2);}catch(e){window.qaResult={passed:false,error:String(e.stack||e)};document.querySelector('#result').textContent=JSON.stringify(window.qaResult);}window.qaComplete=true;document.querySelector('#run').disabled=false;};document.querySelector('#run').onclick=run;if(new URLSearchParams(location.search).has('auto'))run();</script>`);
  console.log('Temporary browser fixture: tests/browser/generated/qa-audio-cut-refinements.html');
}

async function renderRefinementsBrowser(moduleUrl) {
  const { GuitarAudio } = await import(moduleUrl);
  const original = globalThis.AudioContext;
  const frequencies = [82.406889, 130.812783, 164.813778, 195.997718, 261.625565, 329.627557];
  const peak = data => { let max = 0; for (const value of data) max = Math.max(max, Math.abs(value)); return max; };
  const rms = (data, sr, from, to) => { let sum = 0; const first = Math.floor(from * sr), last = Math.min(data.length, Math.floor(to * sr)); for (let i = first; i < last; i++) sum += data[i] ** 2; return Math.sqrt(sum / (last - first)); };
  async function render(preset, sr, mode) {
    const context = new OfflineAudioContext(2, Math.ceil(sr * 2), sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(preset); audio.setVolume(0.7); await audio.unlock();
    const pending = [], events = [];
    const at = (time, run) => pending.push(context.suspend(time).then(async () => { run(); await OfflineAudioContext.prototype.resume.call(context); }));
    if (mode === 'nylonHarmonic') audio.pluckHarmonic(110, 0.9);
    else if (mode === 'nylonNormal') audio.pluck(110, 0.9);
    else if (mode === 'nylonBoth') { audio.pluck(110, 0.9); at(0.3, () => audio.pluckHarmonic(220, 0.9)); }
    else {
      if (mode !== 'freshCut') for (const hz of frequencies) audio.pluck(hz, 0.9);
      at(0.35, () => {
        const accepted = audio.cutStrum(frequencies, 0.92);
        events.push({ time: context.currentTime, accepted, voices: audio.voices.length, order: audio.voices.map(voice => voice.frequency), first: audio.voices[0]?.start });
      });
      if (mode === 'rapidCut') at(0.36, () => {
        const accepted = audio.cutStrum([...frequencies].reverse(), 0.92);
        events.push({ time: context.currentTime, accepted, voices: audio.voices.length, first: audio.voices[0]?.start });
      });
      if (mode === 'replay') at(0.6, () => { events.push({ time: context.currentTime, accepted: audio.pluck(220, 0.8) }); });
      if (mode === 'cutBend') { audio.setBend(-4, 0); }
    }
    const buffer = await context.startRendering(); await Promise.all(pending);
    return { data: buffer.getChannelData(0), right: buffer.getChannelData(1), events };
  }
  try {
    const results = [], nylon = [];
    for (const sr of [44100, 48000]) {
      for (const preset of ['red', 'mint', 'black', 'darkbrown', 'redbrown']) {
        for (const mode of ['freshCut', 'priorChord', 'rapidCut', 'replay', 'cutBend']) {
          const output = await render(preset, sr, mode);
          const row = { preset, sampleRate: sr, mode, events: output.events,
            beforeRms: rms(output.data, sr, 0.2, 0.3), cutRms: rms(output.data, sr, 0.385, 0.43),
            afterRms: rms(output.data, sr, 0.54, 0.59), lateRms: rms(output.data, sr, 0.7, 1.5),
            peak: Math.max(peak(output.data), peak(output.right)), finite: output.data.every(Number.isFinite) && output.right.every(Number.isFinite) };
          // IIR EQ settling is measured immediately after the final staggered
          // string. Require below -110 dBFS there, then strict silence later.
          row.afterDbFS = row.afterRms ? 20 * Math.log10(row.afterRms) : null;
          row.passed = row.finite && row.peak < 0.9 && row.cutRms > 0.003 && row.afterRms < 10 ** (-110 / 20)
            && (mode === 'replay' ? row.lateRms > 0.003 : row.lateRms < 1e-7)
            && output.events.every(event => event.accepted && (event.voices === undefined || event.voices === 6));
          results.push(row);
        }
      }
      const harmonic = await render('darkbrown', sr, 'nylonHarmonic');
      const normal = await render('darkbrown', sr, 'nylonNormal');
      const both = await render('darkbrown', sr, 'nylonBoth');
      const delta = both.data.map((value, index) => value - normal.data[index]);
      const row = { sampleRate: sr, harmonicAttack: rms(harmonic.data, sr, 0.015, 0.08), harmonicAfter: rms(harmonic.data, sr, 0.26, 1.5),
        ordinarySustain: rms(normal.data, sr, 0.5, 0.8), combinedSustain: rms(both.data, sr, 0.8, 1.2),
        residualAfterSeparateHarmonic: rms(delta, sr, 1.1, 1.5), peak: Math.max(peak(harmonic.data), peak(both.data)) };
      row.passed = row.harmonicAttack > 0.003 && row.harmonicAfter < 1e-7 && row.ordinarySustain > 0.003
        && row.combinedSustain > 0.003 && row.residualAfterSeparateHarmonic < 0.0001 && row.peak < 0.9;
      nylon.push(row);
    }
    return { passed: results.every(row => row.passed) && nylon.every(row => row.passed), results, nylon };
  } finally { globalThis.AudioContext = original; }
}

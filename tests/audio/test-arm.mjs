import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { GuitarAudio } from '../../src/audio.js';
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
}
class Node { connect() {} disconnect() { this.disconnected = true; } }
class Context {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100; this.destination = new Node(); }
  createGain() { return Object.assign(new Node(), { gain: new Param(1) }); }
  createWaveShaper() { return new Node(); }
  createConvolver() { return new Node(); }
  createDynamicsCompressor() { return Object.assign(new Node(), Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(x => [x, new Param()]))); }
  createBiquadFilter() { return Object.assign(new Node(), { gain: new Param(), frequency: new Param(), Q: new Param() }); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { length, getChannelData: c => data[c] }; }
  createBufferSource() { return Object.assign(new Node(), { detune: new Param(), start(time) { this.startTime = time; }, stop(time) { this.stopTime = time; } }); }
}
const before = globalThis.AudioContext;
const close = (a, b, message) => assert(Math.abs(a - b) < 1e-8, `${message}: ${a} versus ${b}`);
try {
  globalThis.AudioContext = Context;
  for (const preset of ['red', 'mint', 'black', 'darkbrown', 'redbrown']) {
    const audio = new GuitarAudio(); audio.setPreset(preset); await audio.unlock();
    audio.pluck(110); audio.pluckHarmonic(220);
    audio.context.currentTime = 0.2; audio.setBend(4);
    for (const voice of audio.liveVoices) close(audio._parameterValue(voice.source.detune, .235), 400, 'all voices bend');
    audio.context.currentTime = .2175; audio.pluck(330);
    close(audio._parameterValue(audio.voices.at(-1).source.detune, .2175), 200, 'fresh voice inherits current smooth bend');
    close(audio._parameterValue(audio.voices.at(-1).source.detune, .235), 400, 'fresh voice follows rest of bend');
    const releaseVoice = audio.voices[0]; audio._release(releaseVoice);
    assert(audio.liveVoices.has(releaseVoice), 'releasing source remains in live set');
    audio.context.currentTime = .23; audio.setBend(0, 80);
    close(audio._parameterValue(releaseVoice.source.detune, .31), 0, 'released voice receives arm return');
    audio.context.currentTime = .25; audio.setBend(-4);
    for (const voice of audio.liveVoices) close(audio._parameterValue(voice.source.detune, .285), -400, 'negative bend reaches exact pitch');
    audio.context.currentTime = .3;
    const sounding = [...audio.liveVoices];
    const gainEvents = sounding.map(v => v.gain.gain.events.length);
    audio.setDamped(true);
    close(audio._parameterValue(audio.damper.gain, .336), .5, 'halfway fade is still audible');
    close(audio._parameterValue(audio.damper.gain, .372), 0, '72 ms fade reaches zero');
    sounding.forEach((voice, i) => {
      assert.equal(voice.gain.gain.events.length, gainEvents[i], 'damping does not prematurely fade voices');
      if (voice !== releaseVoice) assert(voice.source.stopTime >= .372, 'source stops only after full-output fade');
    });
    close(audio._parameterValue(audio.effectNodes.tail.gain, .336), 1, 'room remains intact during fade');
    close(audio._parameterValue(audio.effectNodes.tail.gain, .372), 0, 'room gates once output silent');
    audio.context.currentTime = .32; audio.setDamped(false); audio.pluckHarmonic(220);
    close(audio.voices.at(-1).source.startTime, .384, 'new note waits for fade and compressor drain');
    close(audio._parameterValue(audio.damper.gain, .336), .5, 'queued reopening preserves earlier fade');
    // Poison .value to prove the WebKit fallback calculates the scheduled value.
    audio.damper.gain.cancelAndHoldAtTime = undefined; audio.damper.gain.value = 999;
    audio.context.currentTime = .336; audio.setDamped(true);
    close(audio._parameterValue(audio.damper.gain, .336), .5, 'fallback does not jump to stale AudioParam.value');
    close(audio.damper.gain.events.filter(e => e[0] === 'set' && e[2] === .336).at(-1)[1], .5, 'fallback reschedules exact held value');
    audio.context.currentTime = .35; audio.setDamped(false); audio.pluck(110);
    audio.setBend(0, 80);
    const noHold = audio.voices.at(-1).source.detune; noHold.cancelAndHoldAtTime = undefined; noHold.value = 12345;
    audio.context.currentTime = .39;
    const expected = audio._parameterValue(noHold, .39); audio.setBend(4, 35);
    close(audio._parameterValue(noHold, .39), expected, 'bend interruption remains continuous without hold API');
    audio.context.currentTime = .45; audio.mute(true); audio.setDamped(false);
    assert(!audio.pluck(110)); audio.mute(false); assert(audio.pluck(110));
    for (let i = 0; i < 80; i++) {
      audio.context.currentTime += .005; audio.setBend((i % 9) - 4);
      if (i % 3 === 0) audio.setDamped(true);
      else { audio.setDamped(false); audio.pluckHarmonic(110 + i); }
      assert(audio.voices.length <= 12);
      assert(Number.isFinite(audio._parameterValue(audio.damper.gain, audio.context.currentTime)));
      assert(audio._parameterState(audio.effectNodes.tail.gain).events.length < 20, 'room automation history stays bounded');
    }
    for (const voice of [...audio.liveVoices]) voice.source.onended();
    assert.equal(audio.liveVoices.size, 0, 'ended sources are cleaned up');
  }
  const audio = new GuitarAudio(); assert(audio.setBend(4)); assert.equal(audio.context, null);
  assert(!audio.setBend(NaN)); assert(!audio.setBend(0, NaN)); audio.setBend(99); assert.equal(audio.bend, 4);
  await audio.unlock(); audio.pluck(110); close(audio.voices[0].source.detune.value, 400, 'held arm survives first audio unlock');
} finally { globalThis.AudioContext = before; }
console.log('Arm/audio regression passed: five presets; 72 ms output-first fade; delayed stops and wet gate; cancelled/repeated fade/replay; stale-value WebKit fallback; ±4-semitone bends on live, releasing and fresh voices; 80 ms continuous return; 400 rapid bend/mute/replay operations.');

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-arm.html', import.meta.url), `<!doctype html><meta charset="utf-8"><title>Audio fade and arm waveform QA</title><button id="run">Run audio tests</button><pre id="result">Ready</pre><script type="module">\n${renderArmBrowser.toString()}\ndocument.querySelector('#run').onclick=async()=>{const out=document.querySelector('#result');out.textContent='Rendering…';try{out.textContent=JSON.stringify(await renderArmBrowser(new URL('../../../dist/audio.js',location.href).href),null,2)}catch(e){out.textContent=String(e.stack||e)}};</script>`);
  console.log('Browser fixture: tests/browser/generated/qa-audio-arm.html');
}

async function renderArmBrowser(url) {
  const { GuitarAudio, getPlaybackFrequency } = await import(url);
  const sr = 44100, original = globalThis.AudioContext;
  const rms = (data, from, to) => { let sum = 0, a = Math.floor(from * sr), b = Math.min(data.length, Math.floor(to * sr)); for (let i = a; i < b; i++) sum += data[i] ** 2; return Math.sqrt(sum / (b - a)); };
  function pitch(data, expected, from, to) {
    const a = Math.floor(from * sr), b = Math.floor(to * sr), center = sr / expected;
    const lo = Math.floor(center * .93), hi = Math.ceil(center * 1.07), scores = [];
    let best = Infinity, lag = lo;
    for (let d = lo; d <= hi; d++) { let score = 0; for (let i = a; i < b; i++) score += (data[i] - data[i+d]) ** 2; scores[d] = score; if (score < best) { best = score; lag = d; } }
    const left = scores[lag-1], right = scores[lag+1];
    const fine = (left-right)/(2*(left-2*best+right));
    return sr / (lag + (Number.isFinite(fine) ? fine : 0));
  }
  async function render(preset, mode) {
    const duration = mode.startsWith('bend') || mode === 'fresh' ? 1.5 : 1.0;
    const context = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(preset); audio.setVolume(.65);
    if (mode === 'fresh') audio.setBend(4, 0);
    await audio.unlock();
    if (mode === 'fallback' || mode === 'rapid') {
      for (const param of [audio.damper.gain, audio.effectNodes.tail.gain]) Object.defineProperty(param, 'cancelAndHoldAtTime', { value: undefined });
    }
    if (mode.startsWith('bend') || mode === 'fresh') audio.pluck(110, .9);
    else for (const hz of [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557]) audio.pluck(hz, .8);
    const pending = [], events = [];
    const at = (time, fn) => pending.push(context.suspend(time).then(async () => { fn(context.currentTime); await OfflineAudioContext.prototype.resume.call(context); }));
    if (['damp','old','fallback','replay','rapid'].includes(mode)) {
      at(.35, time => {
        events.push({kind:'damp',time});
        if (mode === 'old') {
          for (const v of [...audio.voices]) audio._release(v,.022);
          audio._smooth(audio.effectNodes.tail.gain,0,.004);
          const gate=audio.damper.gain;gate.cancelAndHoldAtTime(time);gate.linearRampToValueAtTime(0,time+.022);
        } else audio.setDamped(true);
      });
      at(.37, time => { audio.setDamped(false); if (['replay','rapid'].includes(mode)) { audio.pluckHarmonic(220); events.push({kind:'replay',time}); } });
      if (mode === 'rapid') {
        for (const [time, hold] of [[.39,true],[.41,false],[.43,true],[.45,false],[.47,true],[.49,false]]) at(time, () => { audio.setDamped(hold); if (!hold) audio.pluck(220); });
        at(.7, () => audio.setDamped(true));
      }
    }
    if (mode === 'bend' || mode === 'bend-fallback') {
      if(mode==='bend-fallback') for(const v of audio.liveVoices) Object.defineProperty(v.source.detune,'cancelAndHoldAtTime',{value:undefined});
      at(.26, () => audio.setBend(4)); at(.5, () => audio.setBend(0,80));
      at(.8, () => audio.setBend(-4)); at(1.1, () => audio.setBend(0,80));
    }
    if (mode === 'fresh') at(.5, () => audio.setBend(0,80));
    const result=await context.startRendering();await Promise.all(pending);
    return {data:result.getChannelData(0), right:result.getChannelData(1),events};
  }
  try {
    const results=[];
    for(const preset of ['red','mint','black','darkbrown','redbrown']) {
      const modes=['baseline','damp','old','fallback','replay','rapid','bend','bend-fallback','fresh'];
      const renders={};for(const mode of modes) renders[mode]=await render(preset,mode);
      const base=renders.baseline.data, t=renders.damp.events[0].time;
      function envelope(time) {
        const q=(time-t)/.072;if(q<=0)return 1;if(q>=1)return 0;
        const x=q*32,a=Math.floor(x),f=x-a;
        return 1-((.5-.5*Math.cos(Math.PI*a/32))*(1-f)+(.5-.5*Math.cos(Math.PI*(a+1)/32))*f);
      }
      function residual(mode) {
        const out=new Float32Array(base.length);
        for(let i=0;i<out.length;i++)out[i]=renders[mode].data[i]-base[i]*envelope(i/sr);
        const high=new Float32Array(base.length);
        for(let i=2;i<high.length;i++)high[i]=out[i]-2*out[i-1]+out[i-2];
        return {rms:rms(out,t-.01,t+.074),highFrequency:rms(high,t-.01,t+.074),peak:Math.max(...out.subarray(Math.floor(t*sr),Math.floor((t+.074)*sr)).map(Math.abs))};
      }
      const smooth=residual('damp'),legacy=residual('old'),fallback=residual('fallback');
      const bendErrors={}, baseFrequency=getPlaybackFrequency(110,preset);
      for(const mode of ['bend','bend-fallback']) {
        bendErrors[mode]=[[baseFrequency,.12,.23],[baseFrequency*2**(4/12),.36,.47],[baseFrequency,.65,.77],[baseFrequency*2**(-4/12),.94,1.07],[baseFrequency,1.26,1.38]].map(([hz,a,b])=>1200*Math.log2(pitch(renders[mode].data,hz,a,b)/hz));
      }
      const freshErrors=[[baseFrequency*2**(4/12),.12,.26],[baseFrequency,.65,.8]].map(([hz,a,b])=>1200*Math.log2(pitch(renders.fresh.data,hz,a,b)/hz));
      const row={preset,smoothResidual:smooth,legacyResidual:legacy,fallbackResidual:fallback,
        fadeMidpointRms:rms(renders.damp.data,t+.025,t+.045),silenceRms:rms(renders.damp.data,t+.075,.95),
        replayRms:rms(renders.replay.data,.48,.64),rapidReplayRms:rms(renders.rapid.data,.6,.68),rapidSilenceRms:rms(renders.rapid.data,.79,.98),bendCents:bendErrors,freshVoiceCents:freshErrors,
        peak:Math.max(...Object.values(renders).map(r=>r.data.reduce((a,v)=>Math.max(a,Math.abs(v)),0))),finite:Object.values(renders).every(r=>r.data.every(Number.isFinite))};
      row.passed=row.finite&&row.peak<.91&&smooth.rms<1e-5&&fallback.rms<1e-5&&smooth.highFrequency<legacy.highFrequency*.05&&row.fadeMidpointRms>.001&&row.silenceRms<1e-8&&row.replayRms>.001&&row.rapidReplayRms>.001&&row.rapidSilenceRms<1e-8&&Object.values(bendErrors).flat().every(v=>Math.abs(v)<15)&&freshErrors.every(v=>Math.abs(v)<15);
      results.push(row);
    }
    return {passed:results.every(r=>r.passed),sampleRate:sr,renders:45,results};
  } finally { globalThis.AudioContext=original; }
}

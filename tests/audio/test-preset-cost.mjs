import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { GuitarAudio, GUITAR_PRESETS } from '../../src/audio.js';
// Scheduling/synthesis only. Model follows test-audio-resources.mjs and runs no native audio DSP.
class Param { constructor(value=0){this.value=value;} setValueAtTime(v){this.value=v;} linearRampToValueAtTime(v){this.value=v;} setTargetAtTime(v){this.value=v;} cancelAndHoldAtTime(){} cancelScheduledValues(){} }
class Node { constructor(kind,c){this.kind=kind;this.context=c;this.connections=new Set();c.created[kind]=(c.created[kind]||0)+1;} connect(n){this.connections.add(n);this.context.connected.add(this);} disconnect(){this.connections.clear();this.context.connected.delete(this);} }
class Context {
 constructor(){this.currentTime=0;this.state='running';this.sampleRate=44100;this.created={};this.connected=new Set();this.sources=new Set();this.destination=new Node('destination',this);}
 createGain(){return Object.assign(new Node('gain',this),{gain:new Param(1)});}
 createBiquadFilter(){return Object.assign(new Node('filter',this),{gain:new Param(),frequency:new Param(),Q:new Param()});}
 createWaveShaper(){return new Node('shaper',this);}
 createConvolver(){return new Node('convolver',this);}
 createDynamicsCompressor(){return Object.assign(new Node('compressor',this),Object.fromEntries(['threshold','knee','ratio','attack','release'].map(n=>[n,new Param()])));}
 createAnalyser(){return Object.assign(new Node('analyser',this),{getFloatTimeDomainData(s){s.fill(0);}});}
 createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {length,sampleRate,numberOfChannels:channels,getChannelData:c=>data[c]};}
 createBufferSource(){return Object.assign(new Node('source',this),{detune:new Param(),stopAt:Infinity,start(t){this.endAt=Math.max(this.context.currentTime,t)+this.buffer.length/this.buffer.sampleRate;this.context.sources.add(this);},stop(t){this.stopAt=t;}});}
 advance(s){this.currentTime+=s;for(const source of this.sources){if(Math.min(source.stopAt,source.endAt)>this.currentTime)continue;this.sources.delete(source);source.onended?.();}}
}
const ids=Object.keys(GUITAR_PRESETS), frequencies=[82.406889,110,146.832384,195.997718,246.941651,329.627557];
const samples=Object.fromEntries(ids.map(id=>[id,{cold:[],warm:[],switch:[],graph:null}]));
const old=globalThis.AudioContext;globalThis.AudioContext=Context;
const quantile=(arr,q)=>[...arr].sort((a,b)=>a-b)[Math.floor((arr.length-1)*q)];
const measure=fn=>{const t=performance.now();fn();return performance.now()-t;};
const summarize=a=>({n:a.length,medianMs:+quantile(a,.5).toFixed(5),p95Ms:+quantile(a,.95).toFixed(5),minMs:+Math.min(...a).toFixed(5),maxMs:+Math.max(...a).toFixed(5)});
const pluckSix=a=>{for(const f of frequencies)assert(a.pluck(f));};
try {
 // Warm the JS implementation, separately from the recorded runs.
 const jit=new GuitarAudio();await jit.unlock();
 for(const id of ids){jit.setPreset(id);pluckSix(jit);jit.context.advance(5);}
 // Rotate order each round to reduce systematic first-preset/order bias.
 for(let round=0;round<7;round++)for(let i=0;i<ids.length;i++){
  const id=ids[(i+round)%ids.length],a=new GuitarAudio();a.setPreset(id);await a.unlock();a.context.advance(.01);
  const c=a.context, fixed=c.connected.size;
  if(round===0)samples[id].graph={fixedConnectedNodes:fixed,createdAfterUnlock:{...c.created},edges:[...c.connected].reduce((n,s)=>n+s.connections.size,0)};
  samples[id].cold.push(measure(()=>pluckSix(a)));
  assert.equal(a.cache.size,6);assert.equal(c.connected.size,fixed+18);
  c.advance(5);
  for(let k=0;k<240;k++){
   const elapsed=measure(()=>pluckSix(a));
   // Samples after the first 40 warm batches; source release/cleanup occurs outside timing.
   if(k>=40)samples[id].warm.push(elapsed);
   assert(a.voices.length<=12);assert.equal(c.connected.size,fixed+a.liveVoices.size*3);
   c.advance(.05);
  }
  a.stopAll();c.advance(5);assert.equal(c.connected.size,fixed);
  const before={...c.created};
  for(let k=0;k<100;k++){
   c.advance(.03);samples[id].switch.push(measure(()=>a.setPreset(id)));
  }
  assert.deepEqual(c.created,before,'switch creates no nodes');
 }
 const cacheAudio=new GuitarAudio();await cacheAudio.unlock();const reuse=[];
 for(const id of ids){cacheAudio.setPreset(id);const before=cacheAudio.cache.size;const time=measure(()=>pluckSix(cacheAudio));reuse.push({id,cacheBefore:before,cacheAfter:cacheAudio.cache.size,ms:+time.toFixed(3)});cacheAudio.context.advance(5);}
 const result={scope:'Node mocked Web Audio, 44100 Hz. Includes JS waveform synthesis, JS automation scheduling, mock node creation. Excludes native DSP/rendering, DOM/CSS/SVG/GPU, speaker latency, actual device performance.',runtime:process.version,platform:process.platform,rounds:7,batchNotes:6,results:Object.fromEntries(ids.map(id=>[id,{coldSixNotes:summarize(samples[id].cold),warmSixNotes:summarize(samples[id].warm),presetSwitch:summarize(samples[id].switch),graph:samples[id].graph}])),sequentialCacheReuse:reuse};
 console.log(JSON.stringify(result,null,2));
}finally{globalThis.AudioContext=old;}

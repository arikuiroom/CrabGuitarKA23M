import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuitarAudio, synthesizePercussion, createOutputSafetyCurve } from '../../src/audio.js';
const kinds=['kick','snare','hat','shaker','tap'];
test('deterministic short PCM is finite, quiet, zero-ended, and sample-rate safe',()=>{
  for(const sr of [8000,44100,48000,192000])for(const kind of kinds){
    const pcm=synthesizePercussion(kind,sr);assert(pcm.length<=sr*.181);assert(pcm.every(Number.isFinite));
    assert.equal(Math.abs(pcm[0]),0);assert.equal(Math.abs(pcm.at(-1)),0);assert(pcm.every(v=>Math.abs(v)<=.048));
    assert(pcm.some(v=>Math.abs(v)>.005));assert.deepEqual(pcm,synthesizePercussion(kind,sr));
    const mean=pcm.reduce((a,b)=>a+b,0)/pcm.length;assert(Math.abs(mean)<.002);
  }
  for(const [kind,sr]of [['bad',44100],['kick',0],['hat',NaN]])assert.throws(()=>synthesizePercussion(kind,sr),RangeError);
  assert(createOutputSafetyCurve().every(v=>Math.abs(v)<.9));
});
class Param{
  constructor(value=0){this.value=value;this.events=[]}
  cancelScheduledValues(t){this.events.push(['cancel',t])}setValueAtTime(v,t){this.value=v;this.events.push(['set',v,t])}
  linearRampToValueAtTime(v,t){this.value=v;this.events.push(['ramp',v,t])}
}
function fixture(){
  const audio=new GuitarAudio(),nodes=[],sources=new Set();
  const node=()=>{const n={connections:[],connect(n){this.connections.push(n)},disconnect(){this.connections=[]}};nodes.push(n);return n};
  audio.context={currentTime:0,state:'running',sampleRate:44100,
    createGain:()=>Object.assign(node(),{gain:new Param(1)}),
    createBufferSource:()=>Object.assign(node(),{start(at){this.startAt=at;sources.add(this)},stop(at){this.stopAt=at}})};
  audio.compressor=node();audio.damper={gain:new Param(1)};
  for(const kind of kinds)audio.percussionBuffers.set(kind,{length:synthesizePercussion(kind).length});
  return {audio,nodes,sources,advance(t){audio.context.currentTime+=t;for(const s of sources)if(s.stopAt<=audio.context.currentTime){sources.delete(s);s.onended?.();assert.equal(s.connections.length,0)}}};
}
test('percussion owns bounded sources, reuses five buffers and cleans naturally',()=>{
  const f=fixture(),a=f.audio,cache=[...a.percussionBuffers.values()];
  for(let i=0;i<2000;i++){a.playPercussion(kinds[i%5],.6);assert(a.percussionVoices.size<=6);assert(a.percussionVoices.size*2<=12);f.advance(.025)}
  f.advance(1);assert.equal(a.percussionVoices.size,0);assert.equal(f.sources.size,0);assert.deepEqual([...a.percussionBuffers.values()],cache);
  assert(f.nodes.slice(1).every(n=>n.connections.length===0));
});
test('cap includes releasing voices; stop fades 10ms, repeated cancellation never prolongs it',()=>{
  const f=fixture(),a=f.audio;for(let i=0;i<100;i++)a.playPercussion('kick',1);
  assert.equal(a.percussionVoices.size,6);const v=[...a.percussionVoices][0];assert.equal(v.gain.connections[0],a.compressor);
  a.stopPercussion();assert.equal(v.source.stopAt,.01);assert(v.gain.gain.events.some(e=>e[0]==='ramp'&&e[1]===0&&e[2]===.01));
  a.context.currentTime=.005;a.stopPercussion();assert.equal(v.source.stopAt,.01);f.advance(.006);
  assert.equal(a.percussionVoices.size,0);assert.equal(f.sources.size,0);
});
test('mute/damp/zero-volume/suspended context block hits; unmute cannot revive sources',()=>{
  const f=fixture(),a=f.audio;
  for(const prop of ['muted','damped']){a[prop]=true;assert.equal(a.playPercussion('kick'),false);a[prop]=false}
  a.volume=0;assert.equal(a.playPercussion('kick'),false);a.volume=.45;a.context.state='suspended';assert.equal(a.playPercussion('kick'),false);a.context.state='running';
  for(const level of [0,-1,NaN,Infinity])assert.equal(a.playPercussion('kick',level),false);
  assert.equal(a.playPercussion('bad'),false);a.playPercussion('kick');a.setVolume(0);f.advance(.02);assert.equal(a.percussionVoices.size,0);a.setVolume(.45);assert.equal(a.percussionVoices.size,0);
  for(let i=0;i<500;i++){a.playPercussion('snare');a.stopPercussion();f.advance(.02)}assert.equal(a.percussionVoices.size,0);
});

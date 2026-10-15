import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFreeMode, freeStrings } from '../../src/free-mode.js';
function fixture(overrides = {}) {
  let now = 0, id = 0, allowed = true, chord = 'open', frets = [0,0,0,0,0,0];
  const timers = new Map(), notes = [], changes = [], errors = [], delays = [];
  const mode = createFreeMode({ unlock: async () => {}, play: (i,v) => notes.push({i,v,time:now}),
    canPlay: () => allowed, getStrings: () => freeStrings(chord, frets), onChange: v => changes.push(v), onError: e => errors.push(e),
    random: () => .5, setTimer: (fn,delay) => { delays.push(delay);timers.set(++id,{fn,at:now+delay});return id; }, clearTimer: id => timers.delete(id), ...overrides });
  return {mode,timers,notes,changes,errors,delays,setAllowed:v=>allowed=v,setChord:(c,f)=>{chord=c;frets=f},
    next:()=>{assert.equal(timers.size,1);const [id,t]=[...timers][0];timers.delete(id);now=t.at;t.fn();}};
}
test('silent initial state; repeated enable owns one timer, soft bounded motifs and long rests',async()=>{
  const f=fixture();assert.equal(f.timers.size,0);assert.equal(f.mode.active,false);
  await Promise.all(Array.from({length:100},()=>f.mode.start()));
  assert.deepEqual(f.changes,[true]);assert.equal(f.timers.size,1);
  for(let i=0;i<1000;i++) f.next();
  assert(f.notes.every(n=>[0,3,4,5].includes(n.i)&&n.v>=.44&&n.v<=.54));
  assert(f.delays.some(d=>d>=1800));assert(f.delays.slice(1).every(d=>d>=460));
  f.mode.stop();assert.equal(f.timers.size,0);assert.deepEqual(f.changes,[true,false]);
});
test('chord changes are read on each note and muted strings excluded',async()=>{
  const f=fixture();await f.mode.start();f.next();
  f.setChord('C',[null,3,2,0,1,0]);for(let i=0;i<30;i++)f.next();
  assert(f.notes.slice(1).every(n=>n.i!==0));f.mode.stop();
  assert.deepEqual(freeStrings('Am',[null,0,2,2,1,0]),[1,2,3,4,5]);
});
test('manual/background/mute eligibility stops without automatic resume',async()=>{
  const f=fixture();await f.mode.start();f.next();f.setAllowed(false);f.next();
  assert.equal(f.mode.active,false);assert.equal(f.timers.size,0);f.setAllowed(true);assert.equal(f.timers.size,0);
  await f.mode.start();f.mode.stop();assert.equal(f.timers.size,0);
});
test('OFF during audio unlock cannot revive a pending start',async()=>{
  let resolve;const f=fixture({unlock:()=>new Promise(r=>resolve=r)});
  const pending=f.mode.start();assert.equal(f.mode.active,true);f.mode.stop();resolve();await pending;
  assert.equal(f.mode.active,false);assert.equal(f.timers.size,0);assert.equal(f.notes.length,0);
});
test('old unlock completion and rejection cannot affect a newer session',async()=>{
  const pending=[];const f=fixture({unlock:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  const first=f.mode.start();f.mode.stop();const second=f.mode.start();
  pending[0].reject(Error('stale'));await first;assert.equal(f.errors.length,0);assert.equal(f.mode.active,true);
  pending[1].resolve();await second;assert.equal(f.timers.size,1);f.mode.stop();
});
test('blocked enable and unlock failure stay off and timer-free',async()=>{
  const f=fixture({unlock:async()=>{throw Error('blocked')}});f.setAllowed(false);await f.mode.start();assert.deepEqual(f.changes,[]);
  f.setAllowed(true);await f.mode.start();assert.equal(f.errors.length,1);assert.equal(f.mode.active,false);assert.equal(f.timers.size,0);
});
test('rapid repeated start/stop never retains timer or stale callback',async()=>{
  const f=fixture();for(let i=0;i<500;i++){await f.mode.start();const stale=[...f.timers.values()][0].fn;f.mode.stop();stale();assert.equal(f.timers.size,0)}
  assert.equal(f.notes.length,0);
});

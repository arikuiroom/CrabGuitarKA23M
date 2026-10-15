import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFreeMode, freeStrings } from '../../src/free-mode.js';
function fixture(overrides = {}) {
  let now = 0, id = 0, allowed = true, chord = 'open', preset = 'red', frets = [0,0,0,0,0,0];
  const timers = new Map(), notes = [], changes = [], errors = [], delays = [];
  const mode = createFreeMode({ unlock: async () => {}, play: (i,v,gate) => notes.push({i,v,gate,time:now}),
    canPlay: () => allowed, getStrings: color => freeStrings(chord, frets, color), getPreset: () => preset, onChange: v => changes.push(v), onError: e => errors.push(e),
    random: () => .5, setTimer: (fn,delay) => { delays.push(delay);timers.set(++id,{fn,at:now+delay});return id; }, clearTimer: id => timers.delete(id), ...overrides });
  return {mode,timers,notes,changes,errors,delays,setAllowed:v=>allowed=v,setPreset:v=>preset=v,setChord:(c,f)=>{chord=c;frets=f},
    next:()=>{assert.equal(timers.size,1);const [id,t]=[...timers][0];timers.delete(id);now=t.at;t.fn();}};
}
test('silent initial state; repeated enable owns one timer, soft bounded motifs and long rests',async()=>{
  const f=fixture();assert.equal(f.timers.size,0);assert.equal(f.mode.active,false);
  await Promise.all(Array.from({length:100},()=>f.mode.start()));
  assert.deepEqual(f.changes,[true]);assert.equal(f.timers.size,1);
  for(let i=0;i<1000;i++) f.next();
  assert(f.notes.every(n=>[0,3,4,5].includes(n.i)&&n.v>=.44&&n.v<=.54));
  assert(f.delays.some(d=>d>=1800));assert(f.delays.slice(1).every(d=>d>=520));
  f.mode.stop();assert.equal(f.timers.size,0);assert.deepEqual(f.changes,[true,false]);
});
test('chord changes are read on each note and muted strings excluded',async()=>{
  const f=fixture();await f.mode.start();f.next();
  f.setChord('C',[null,3,2,0,1,0]);for(let i=0;i<30;i++)f.next();
  assert(f.notes.slice(1).every(n=>n.i!==0));f.mode.stop();
  assert.deepEqual(freeStrings('Am',[null,0,2,2,1,0]),[1,2,3,4,5]);
});
test('temporary holds skip notes, retain ON and resume without catch-up',async()=>{
  const f=fixture();await f.mode.start();f.next();f.setAllowed(false);
  for(let i=0;i<100;i++)f.next();
  assert.equal(f.mode.active,true);assert.equal(f.notes.length,1);assert.equal(f.timers.size,1);
  f.setAllowed(true);f.next();assert.equal(f.notes.length,2);f.mode.stop();
});
test('background/Stop pause retains ON without timers; only explicit start resumes',async()=>{
  const f=fixture();await f.mode.start();f.next();const stale=[...f.timers.values()][0].fn;
  f.mode.pause();assert.equal(f.mode.active,true);assert.equal(f.mode.paused,true);assert.equal(f.timers.size,0);
  stale();assert.equal(f.notes.length,1);await f.mode.start();assert.equal(f.mode.paused,false);f.next();
  assert.equal(f.notes.length,2);f.mode.stop();assert.equal(f.mode.active,false);
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
  let allowed=false;const f=fixture({canStart:()=>allowed,unlock:async()=>{throw Error('blocked')}});await f.mode.start();assert.deepEqual(f.changes,[]);
  allowed=true;await f.mode.start();assert.equal(f.errors.length,1);assert.equal(f.mode.active,false);assert.equal(f.timers.size,0);
});
test('rapid repeated start/stop never retains timer or stale callback',async()=>{
  const f=fixture();for(let i=0;i<500;i++){await f.mode.start();const stale=[...f.timers.values()][0].fn;f.mode.stop();stale();assert.equal(f.timers.size,0)}
  assert.equal(f.notes.length,0);
});

const chords={open:[0,0,0,0,0,0],C:[null,3,2,0,1,0],G:[3,2,0,0,0,3],Am:[null,0,2,2,1,0],Em:[0,2,2,0,0,0]};
const roots={open:4,C:0,G:7,Am:9,Em:4},midi=[40,45,50,55,59,64];
test('every color obeys every chord; black exclusively uses lowest root/fifth',async()=>{
  const expected={open:[0,4],C:[1,3],G:[0,2],Am:[1,2],Em:[0,1]};
  for(const [chord,frets]of Object.entries(chords))for(const preset of ['red','mint','black','darkbrown','redbrown']){
    const f=fixture();f.setChord(chord,frets);f.setPreset(preset);await f.mode.start();
    for(let i=0;i<50;i++)f.next();
    assert(f.notes.every(n=>freeStrings(chord,frets,preset).includes(n.i)));
    if(preset==='black'){
      assert.deepEqual(freeStrings(chord,frets,preset),expected[chord]);
      assert(f.notes.every(n=>[0,7].includes((midi[n.i]+frets[n.i]-roots[chord]+12)%12)));
      assert(f.notes.some(n=>(midi[n.i]+frets[n.i])%12===roots[chord]));
      assert(f.notes.some(n=>(midi[n.i]+frets[n.i])%12===(roots[chord]+7)%12));
    }
    f.mode.stop();
  }
});
test('five scores have distinct pitch/rhythm signatures and appropriate articulation',async()=>{
  const pitches=new Set(),rhythms=new Set();
  for(const preset of ['red','mint','black','darkbrown','redbrown']){
    const f=fixture();f.setPreset(preset);await f.mode.start();for(let i=0;i<24;i++)f.next();
    pitches.add(f.notes.map(n=>n.i).join(','));rhythms.add(f.delays.join(','));
    assert(f.notes.every(n=>n.v>0&&n.v<.65));
    if(preset==='mint'){assert(f.notes.every(n=>n.gate===.12));assert(f.delays.includes(110));assert(f.delays.includes(330));}
    if(preset==='black')assert(f.notes.slice(0,3).every(n=>n.i===0));
    if(preset==='red')assert(f.notes.every(n=>n.gate===undefined));
    if(preset==='darkbrown')assert.deepEqual(f.notes.slice(0,8).map(n=>n.i),[0,5,3,4,0,4,3,5]);
    if(preset==='redbrown')assert.deepEqual(f.notes.slice(0,6).map(n=>n.i),[0,4,5,0,4,5]);
    f.mode.stop();
  }
  assert.equal(pitches.size,5);assert.equal(rhythms.size,5);
});
test('rapid color/chord changes reset phrases without extra timers or stale notes',async()=>{
  const f=fixture();await f.mode.start();
  for(let i=0;i<500;i++){
    const preset=['mint','black','darkbrown','redbrown','red'][i%5];f.setPreset(preset);
    const chord=Object.keys(chords)[i%5];f.setChord(chord,chords[chord]);f.next();
    assert(freeStrings(chord,chords[chord],preset).includes(f.notes.at(-1).i));assert.equal(f.timers.size,1);
  }
  const stale=[...f.timers.values()][0].fn;f.mode.stop();await f.mode.start();stale();
  assert.equal(f.timers.size,1);f.mode.stop();assert.equal(f.timers.size,0);
});

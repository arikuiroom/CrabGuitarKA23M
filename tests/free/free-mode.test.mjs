import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFreeMode, freeStrings, rhythmAt } from '../../src/free-mode.js';
function fixture(overrides = {}) {
  let time=0,id=0,allowed=true,preset='red',chord='open',frets=[0,0,0,0,0,0],silences=0;
  const timers=new Map(),notes=[],hits=[],changes=[],errors=[];
  const mode=createFreeMode({unlock:async()=>{},now:()=>time,random:()=>.5,
    play:(i,v,gate)=>notes.push({i,v,gate,time}),percussion:(kind,level)=>hits.push({kind,level,time}),silence:()=>silences++,
    canPlay:()=>allowed,getPreset:()=>preset,getStrings:color=>freeStrings(chord,frets,color),onChange:v=>changes.push(v),onError:e=>errors.push(e),
    setTimer:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id},clearTimer:id=>timers.delete(id),...overrides});
  return {mode,timers,notes,hits,changes,errors,get silences(){return silences},setAllowed:v=>allowed=v,setPreset:v=>preset=v,setChord:(c,f)=>{chord=c;frets=f},
    next:(late=0)=>{assert.equal(timers.size,1);const [id,t]=[...timers][0];timers.delete(id);time=t.at+late;t.fn()},
    nextNote:()=>{const before=notes.length;for(let i=0;i<100&&notes.length===before;i++) {const [id,t]=[...timers][0];timers.delete(id);time=t.at;t.fn()}assert(notes.length>before)}};
}
test('silent initial state, one shared absolute clock; 1000 ticks have no drift',async()=>{
  const f=fixture();assert(!f.mode.active);assert.equal(f.timers.size,0);await Promise.all(Array.from({length:100},()=>f.mode.start()));
  assert.deepEqual(f.changes,[true]);for(let i=0;i<1000;i++)f.next(i%3===0?7:0);
  assert(f.notes.every(n=>[0,3,4,5].includes(n.i)&&n.v>=.44&&n.v<=.54));
  assert.equal([...f.timers.values()][0].at,167+1000*130);
  assert(f.hits.length>50);f.mode.stop();assert.equal(f.timers.size,0);assert.deepEqual(f.changes,[true,false]);
});
test('rhythm continues during guitar phrase rests on the same grid',async()=>{
  const f=fixture();f.setPreset('mint');await f.mode.start();for(let i=0;i<160;i++)f.next();
  assert(f.hits.some(h=>!f.notes.some(n=>n.time===h.time)));
  for(const event of [...f.notes,...f.hits])assert.equal((event.time-160)%110,0);
  f.mode.stop();
});
test('lag skips elapsed events without bursts and returns to original grid',async()=>{
  const f=fixture();await f.mode.start();f.next();const before=f.notes.length;f.next(10000);
  assert(f.notes.length<=before+1);const due=[...f.timers.values()][0].at;assert.equal((due-160)%130,0);f.next();assert.equal(f.timers.size,1);f.mode.stop();
});
test('holds skip both instruments, retain ON, and do not accumulate catchup',async()=>{
  const f=fixture();await f.mode.start();f.next();f.setAllowed(false);const hits=f.hits.length;
  for(let i=0;i<100;i++)f.next();assert.equal(f.notes.length,1);assert.equal(f.hits.length,hits);assert(f.mode.active);assert(f.silences>=100);
  f.setAllowed(true);f.nextNote();assert.equal(f.notes.length,2);f.mode.stop();
});
test('pause and OFF cancel clock and percussion, stale callbacks cannot resume',async()=>{
  const f=fixture();await f.mode.start();f.next();const stale=[...f.timers.values()][0].fn;
  f.mode.pause();assert(f.mode.active&&f.mode.paused);assert.equal(f.timers.size,0);stale();assert.equal(f.notes.length,1);
  await f.mode.start();f.next();assert.equal(f.notes.length,2);f.mode.stop();assert(!f.mode.active);assert.equal(f.timers.size,0);
});
test('old unlock completion/rejection cannot revive stopped or newer sessions',async()=>{
  const pending=[];const f=fixture({unlock:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
  const first=f.mode.start();f.mode.stop();const second=f.mode.start();pending[0].reject(Error('stale'));await first;
  assert.equal(f.errors.length,0);pending[1].resolve();await second;assert.equal(f.timers.size,1);f.mode.stop();
  const third=f.mode.start();f.mode.stop();pending[2].resolve();await third;assert.equal(f.timers.size,0);
});
test('blocked start, unlock failure and 500 rapid toggles leave no timers',async()=>{
  let allowed=false;const f=fixture({canStart:()=>allowed,unlock:async()=>{throw Error('blocked')}});await f.mode.start();assert.deepEqual(f.changes,[]);
  allowed=true;await f.mode.start();assert.equal(f.errors.length,1);assert(!f.mode.active);
  const g=fixture();for(let i=0;i<500;i++){await g.mode.start();const stale=[...g.timers.values()][0].fn;g.mode.stop();stale();assert.equal(g.timers.size,0)}
});
const chords={open:[0,0,0,0,0,0],C:[null,3,2,0,1,0],G:[3,2,0,0,0,3],Am:[null,0,2,2,1,0],Em:[0,2,2,0,0,0]};
test('every color obeys current chord; black uses only lowest root/fifth',async()=>{
  const expected={open:[0,4],C:[1,3],G:[0,2],Am:[1,2],Em:[0,1]};
  for(const [chord,frets]of Object.entries(chords))for(const preset of ['red','mint','black','darkbrown','redbrown']){
    const f=fixture();f.setChord(chord,frets);f.setPreset(preset);await f.mode.start();for(let i=0;i<30;i++)f.nextNote();
    assert(f.notes.every(n=>freeStrings(chord,frets,preset).includes(n.i)));
    if(preset==='black')assert.deepEqual(freeStrings(chord,frets,preset),expected[chord]);f.mode.stop();
  }
});
test('distinct scores, quiet style patterns, per-note articulation and natural endings',async()=>{
  const pitches=new Set(),rhythms=new Set();
  for(const preset of ['red','mint','black','darkbrown','redbrown']){
    const f=fixture();f.setPreset(preset);await f.mode.start();for(let i=0;i<24;i++)f.nextNote();
    pitches.add(f.notes.map(n=>n.i).join(','));rhythms.add(f.notes.map(n=>n.time).join(','));
    assert(f.notes.every(n=>n.v>0&&n.v<.65));assert(f.hits.every(h=>h.level>0&&h.level<=.8));
    if(['mint','black'].includes(preset)){assert(f.notes.some(n=>n.gate===undefined));assert(f.notes.some(n=>n.gate===(preset==='mint'?.12:.17)))}
    else assert(f.notes.every(n=>n.gate===undefined));
    f.mode.stop();
  }
  assert.equal(pitches.size,5);assert.equal(rhythms.size,5);
  assert.deepEqual(rhythmAt('mint',7),[['kick',.7]]);assert(rhythmAt('redbrown',2).some(h=>h[0]==='shaker'));
});
test('500 color/chord changes reset both instruments on one clock',async()=>{
  const f=fixture();await f.mode.start();
  const intervals={mint:110,black:95,darkbrown:155,redbrown:135,red:130};
  for(let i=0;i<500;i++){
    const preset=Object.keys(intervals)[i%5];f.setPreset(preset);const chord=Object.keys(chords)[i%5];f.setChord(chord,chords[chord]);f.next();
    const n=f.notes.at(-1);assert(freeStrings(chord,chords[chord],preset).includes(n.i));assert.equal(f.hits.at(-1).time,n.time);
    assert.equal([...f.timers.values()][0].at-n.time,intervals[preset]);
  }f.mode.stop();
});

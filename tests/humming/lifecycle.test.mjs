import test from 'node:test';
import assert from 'node:assert/strict';
import { createHummingMode, HUMMING_MAX_SECONDS } from '../../src/humming.js';

class Target {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name) { for (const fn of [...(this.listeners.get(name) ?? [])]) fn(); }
  count() { return [...this.listeners.values()].reduce((n, fns) => n + fns.size, 0); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reading = (midi = 57) => ({ midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: 0.1, confidence: 0.99 });
const quiet = { midi: null, frequency: null, rms: 0, confidence: 0 };
const makeStream = () => {
  const tracks = [new Target(), new Target()];
  for (const track of tracks) {
    track.readyState = 'live'; track.stops = 0;
    track.stop = () => { track.stops++; track.readyState = 'ended'; };
  }
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks };
};

function fixture(options = {}) {
  let time = 0, timerId = 0;
  const timers = new Map(), states = [], played = [], calls = [], stream = options.stream ?? makeStream();
  const documentTarget = new Target(), windowTarget = new Target(), context = new Target();
  documentTarget.hidden = false;
  context.state = 'running'; context.sampleRate = 48000;
  const source = { disconnects: 0, connect(target) { calls.push('connect'); assert.equal(target, analyser); },
    disconnect() { this.disconnects++; } };
  let sampleBuffer = null;
  const analyser = { fftSize: 0, disconnects: 0,
    getFloatTimeDomainData(buffer) {
      sampleBuffer = buffer;
      for (let index = 0; index < buffer.length; index++) buffer[index] = 0.15 * Math.sin(2 * Math.PI * 220 * index / context.sampleRate);
    },
    connect() { assert.fail('Microphone must never connect to destination'); },
    disconnect() { this.disconnects++; } };
  context.destination = { forbidden: true };
  context.createMediaStreamSource = target => { assert.equal(target, stream); return source; };
  context.createAnalyser = () => analyser;
  const mode = createHummingMode({ getContext: () => context,
    unlock: () => { calls.push('unlock'); return options.unlock?.(); },
    play: (midi, duration, index) => {
      calls.push('play');
      assert(stream.tracks.every(track => track.readyState === 'ended'), 'all mic tracks must stop before plucking');
      assert(source.disconnects > 0 && analyser.disconnects > 0, 'all mic nodes disconnect before plucking');
      played.push({ midi, duration, index, time });
      return options.play?.(midi, duration, index);
    },
    stopAudio: () => { calls.push('stop'); options.stopAudio?.(); },
    onState: (status, details) => { states.push({ status, ...details, time }); options.onState?.(status, details); },
    mediaDevices: options.noMedia ? null : { getUserMedia: constraints => {
      calls.push('media'); assert.equal(constraints.video, false); return options.request ? options.request() : Promise.resolve(stream);
    } },
    now: () => time,
    setTimeoutFn: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    documentTarget, windowTarget,
    ...(options.realPitch ? {} : { detectPitchFn: () => options.detect ? options.detect(time / 1000) : reading() }),
  });
  const next = (lag = 0) => {
    const entry = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
    if (!entry) return false;
    timers.delete(entry[0]); time = Math.max(time, entry[1].due) + lag; entry[1].fn(); return true;
  };
  const until = target => {
    let count = 0;
    while ([...timers.values()].some(timer => timer.due <= target)) {
      if (++count > 2000) throw Error('timer loop');
      next();
    }
    time = Math.max(time, target);
  };
  return { mode, timers, states, played, calls, context, source, analyser, stream, documentTarget, windowTarget,
    next, until, get time() { return time; }, get samples() { return sampleBuffer; } };
}

test('nothing captures before start; unlock and permission request run in the same gesture stack', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0); assert.equal(f.mode.getState().status, 'idle');
  const started = f.mode.start();
  assert.deepEqual(f.calls, ['stop', 'unlock', 'media']);
  assert.equal(f.mode.getState().status, 'requesting');
  assert.equal(await started, true);
  assert.equal(f.mode.getState().status, 'listening');
  assert.equal(f.analyser.fftSize, 4096); assert.equal(f.mode.active, true);
  f.mode.cancel(); assert.equal(f.timers.size, 0);
});

test('start is idempotent while requesting, listening and playing; explicit stop finishes early', async () => {
  const f = fixture();
  const start = f.mode.start(); assert.equal(await f.mode.start(), false); await start;
  assert.equal(await f.mode.start(), false);
  f.until(600); assert.equal(f.mode.stopListening(), true);
  assert.equal(f.mode.getState().status, 'playing');
  assert.equal(await f.mode.start(), false);
  f.until(1300); assert.equal(f.mode.getState().status, 'done');
  assert.equal(f.played.length, 1); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter(call => call === 'media').length, 1);
});

test('real synthetic PCM detects a local note; capture is capped at exactly four seconds', async () => {
  const f = fixture({ realPitch: true }); await f.mode.start();
  f.until(99); assert.equal(f.samples, null, 'old guitar stop fade has time to drain');
  f.until(100); assert(f.samples.every(value => value === 0), 'PCM cleared after every frame');
  f.until(3999); assert.equal(f.mode.getState().status, 'listening');
  f.until(4000); assert.equal(f.mode.getState().status, 'playing');
  assert(f.stream.tracks.every(track => track.stops === 1));
  const events = f.mode.getEvents(); assert.equal(events.length, 1); assert.equal(events[0].midi, 57);
  assert(events[0].duration <= HUMMING_MAX_SECONDS);
  f.until(9000); assert.equal(f.mode.getState().status, 'done'); assert.equal(f.timers.size, 0);
  assert.equal(f.context.count(), 0); assert(f.samples.every(value => value === 0));
});

test('silence auto-finishes after a heard phrase; initial silence still gets the full four seconds', async () => {
  const f = fixture({ detect: time => time < 0.4 ? reading() : quiet }); await f.mode.start();
  f.until(999); assert.equal(f.mode.getState().status, 'listening');
  f.until(1020); assert.equal(f.mode.getState().status, 'playing');
  assert.equal(f.mode.getEvents().length, 1); f.mode.cancel();
  const g = fixture({ detect: () => quiet }); await g.mode.start();
  g.until(3999); assert.equal(g.mode.getState().status, 'listening');
  g.until(4000); assert.equal(g.mode.getState().status, 'error');
  assert.equal(g.mode.getState().code, 'no-notes'); assert.equal(g.played.length, 0);
  assert.equal(g.timers.size, 0); assert(g.stream.tracks.every(track => track.stops === 1));
});

test('denied/missing/busy mic and missing API give informative errors without retrying', async () => {
  for (const [name, code] of [['NotAllowedError', 'denied'], ['SecurityError', 'denied'],
    ['NotFoundError', 'no-device'], ['NotReadableError', 'mic-error']]) {
    const f = fixture({ request: () => Promise.reject(Object.assign(Error(name), { name })) });
    assert.equal(await f.mode.start(), false); assert.equal(f.mode.getState().code, code);
    f.until(60000); assert.equal(f.calls.filter(call => call === 'media').length, 1);
    assert.equal(f.timers.size, 0); assert.equal(f.played.length, 0);
  }
  const f = fixture({ noMedia: true }); assert.equal(await f.mode.start(), false);
  assert.equal(f.mode.getState().code, 'unavailable'); assert(!f.calls.includes('unlock'));
});

test('cancel during permission releases late-granted tracks, without audio or stale state', async () => {
  const permission = deferred(); const f = fixture({ request: () => permission.promise });
  const started = f.mode.start(); f.mode.cancel('user');
  assert.equal(f.timers.size, 0); const count = f.states.length;
  permission.resolve(f.stream); assert.equal(await started, false);
  assert(f.stream.tracks.every(track => track.stops === 1));
  assert.equal(f.states.length, count); assert.equal(f.played.length, 0); assert.equal(f.source.disconnects, 0);
});

test('an old permission response cannot replace or stop a newer capture', async () => {
  const requests = [deferred(), deferred()]; let request = 0;
  const f = fixture({ request: () => requests[request++].promise });
  const first = f.mode.start(); f.mode.cancel(); const second = f.mode.start();
  requests[1].resolve(f.stream); assert.equal(await second, true);
  const old = makeStream(); requests[0].resolve(old); assert.equal(await first, false);
  assert(old.tracks.every(track => track.stops === 1));
  assert(f.stream.tracks.every(track => track.stops === 0));
  assert.equal(f.mode.getState().status, 'listening'); f.mode.cancel();
});

test('cancel after granted mic but before audio unlock releases it immediately', async () => {
  const unlocking = deferred(); const f = fixture({ unlock: () => unlocking.promise });
  const started = f.mode.start(); await Promise.resolve();
  f.mode.cancel(); assert(f.stream.tracks.every(track => track.stops === 1));
  unlocking.resolve(); assert.equal(await started, false); assert.equal(f.timers.size, 0);
});

test('unlock failure and permission timeout invalidate late permissions', async () => {
  const permission = deferred(); const f = fixture({ unlock: () => Promise.reject(Error('blocked')), request: () => permission.promise });
  const started = f.mode.start(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.mode.getState().code, 'audio-unavailable');
  permission.resolve(f.stream); assert.equal(await started, false); assert(f.stream.tracks.every(track => track.stops === 1));
  const pending = deferred(); const g = fixture({ request: () => pending.promise });
  const second = g.mode.start(); g.until(30000); assert.equal(g.mode.getState().code, 'permission-timeout');
  pending.resolve(g.stream); assert.equal(await second, false); assert(g.stream.tracks.every(track => track.stops === 1));
  assert.equal(g.timers.size, 0);
});

test('track end, background, pagehide and audio interruption stop all resources', async () => {
  for (const action of ['ended', 'hidden', 'pagehide', 'interrupted']) {
    const f = fixture(); await f.mode.start(); f.until(300);
    if (action === 'ended') { f.stream.tracks[0].readyState = 'ended'; f.stream.tracks[0].dispatch('ended'); }
    if (action === 'hidden') { f.documentTarget.hidden = true; f.documentTarget.dispatch('visibilitychange'); }
    if (action === 'pagehide') f.windowTarget.dispatch('pagehide');
    if (action === 'interrupted') { f.context.state = 'interrupted'; f.context.dispatch('statechange'); }
    assert.equal(f.mode.getState().status, action === 'ended' ? 'error' : 'idle');
    if (action === 'ended') assert.equal(f.mode.getState().code, 'track-ended');
    assert.equal(f.timers.size, 0); assert.equal(f.context.count(), 0);
    assert(f.stream.tracks.every(track => track.stops === 1 && track.count() === 0));
    f.until(10000); assert.equal(f.played.length, 0);
  }
});

test('stale capture/play/gate callbacks cannot revive cancellation or a newer clock', async () => {
  const f = fixture(); await f.mode.start();
  const captureCallbacks = [...f.timers.values()].map(timer => timer.fn);
  f.until(500); f.mode.stopListening();
  const playCallbacks = [...f.timers.values()].map(timer => timer.fn);
  f.until(600); const gateCallbacks = [...f.timers.values()].map(timer => timer.fn);
  f.mode.cancel('mute'); const count = f.played.length, states = f.states.length;
  for (const fn of [...captureCallbacks, ...playCallbacks, ...gateCallbacks]) fn();
  assert.equal(f.timers.size, 0); assert.equal(f.played.length, count); assert.equal(f.states.length, states);
});

test('playback retains absolute rhythm, gates notes, and skips a stalled phrase without bursts', async () => {
  const f = fixture({ detect: time => time < .4 ? reading(60) : time < .8 ? quiet : time < 1.2 ? reading(64) : reading(67) });
  await f.mode.start(); f.until(1600); f.mode.stopListening();
  const events = f.mode.getEvents(); assert.deepEqual(events.map(event => event.midi), [60, 64, 67]);
  const origin = 1700; f.until(4000);
  assert.equal(f.played.length, 3);
  for (let index = 0; index < 3; index++) assert(Math.abs(f.played[index].time - (origin + events[index].start * 1000)) < 0.01);
  assert.equal(f.timers.size, 0);
  const g = fixture({ detect: time => reading(time < 0.4 ? 60 : time < 0.8 ? 64 : 67) });
  await g.mode.start(); g.until(1200); g.mode.stopListening(); g.next(10000);
  assert.equal(g.played.length, 0); assert.equal(g.mode.getState().status, 'done'); assert.equal(g.timers.size, 0);
});

test('cancel inside state or play callbacks is respected with no remaining timers', async () => {
  let f;
  f = fixture({ onState: status => { if (status === 'listening') f.mode.cancel('state-cancel'); } });
  assert.equal(await f.mode.start(), false); assert.equal(f.timers.size, 0); assert.equal(f.mode.active, false);
  f = fixture({ play: () => f.mode.cancel('palm') }); await f.mode.start(); f.until(500); f.mode.stopListening(); f.until(1000);
  assert.equal(f.played.length, 1); assert.equal(f.mode.getState().status, 'idle'); assert.equal(f.timers.size, 0);
});

test('dispose removes lifecycle listeners; reset forgets note events; returned events are copied', async () => {
  const f = fixture(); await f.mode.start(); f.until(500); f.mode.stopListening();
  const copy = f.mode.getEvents(); copy[0].midi = 1; assert.notEqual(f.mode.getEvents()[0].midi, 1);
  f.mode.reset(); assert.deepEqual(f.mode.getEvents(), []); assert.equal(f.timers.size, 0);
  f.mode.dispose(); f.mode.dispose(); assert.equal(f.documentTarget.count(), 0); assert.equal(f.windowTarget.count(), 0);
  assert.equal(await f.mode.start(), false); assert.equal(f.mode.active, false);
});


test('rhythmic echo never invokes whole-output choke between notes',async()=>{
 const f=fixture({detect:t=>t<.3?reading(60):t<.5?quiet:t<.8?reading(60):t<1?quiet:reading(64)});
 await f.mode.start();f.until(1400);f.mode.stopListening();
 const events=f.mode.getEvents(), stops=f.calls.filter(x=>x==='stop').length;
 assert.equal(events.length,3);
 f.until(1500+events.at(-1).start*1000+1);
 assert.equal(f.calls.filter(x=>x==='stop').length,stops,'neither onset nor note end chokes the shared output');
 assert.deepEqual(f.played.map(x=>x.duration),events.map(x=>x.duration));
 f.mode.cancel();assert.equal(f.timers.size,0);
});

import { detectPitch, createNoteTracker, normalizeMelody } from './humming-pitch.js?v=h2';

export const HUMMING_MAX_SECONDS = 4;
const BUSY = new Set(['requesting', 'listening', 'processing', 'playing']);
const MESSAGES = {
  unavailable: 'このブラウザではマイクを使えません。HTTPS 対応のブラウザで開いてください。',
  denied: 'マイクが許可されませんでした。使う場合はブラウザのマイク設定を確認してください。',
  'no-device': '使えるマイクが見つかりません。接続を確認してください。',
  'mic-error': 'マイクを使えませんでした。ほかのアプリで使われていないか確認してください。',
  'no-notes': '鼻歌をうまく聴き取れませんでした。静かな場所で、少し長めに歌ってみてください。',
  'audio-unavailable': '音を出す準備ができませんでした。もう一度「聴いて」を押してください。',
  'track-ended': 'マイクとの接続が切れました。接続を確認して、もう一度試してください。',
  'permission-timeout': 'マイクの許可を待つのをやめました。もう一度「聴いて」から試せます。',
};

/**
 * Explicit-gesture, local-only humming capture and cancellable guitar reply.
 * Only scalar pitches/note events survive a frame; PCM is overwritten and
 * cleared on every exit. The microphone is never connected to destination.
 *
 * play(midi, seconds, index) plucks the existing guitar. The play callback owns
 * per-note duration gates; stopAudio is reserved for cancellation and completion.
 * The caller should cancel on mute/arm/palm input and disable manual plucks
 * while requesting/listening/processing/playing.
 */
export function createHummingMode({
  getContext, unlock, play, stopAudio = () => {}, onState = () => {},
  mediaDevices = globalThis.navigator?.mediaDevices,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = timer => globalThis.clearTimeout(timer),
  documentTarget = globalThis.document, windowTarget = globalThis.window,
  detectPitchFn = detectPitch,
} = {}) {
  if (typeof getContext !== 'function' || typeof unlock !== 'function' || typeof play !== 'function') {
    throw new TypeError('Humming mode requires getContext, unlock and play callbacks.');
  }
  let state = 'idle', details = {}, epoch = 0, disposed = false;
  let stream = null, source = null, analyser = null, samples = null, context = null;
  let tracker = null, events = [], captureOrigin = 0, playbackOrigin = 0, playIndex = 0;
  let frameTimer = null, limitTimer = null, permissionTimer = null, playTimer = null, gateTimer = null;
  let gateEpoch = 0, trackListeners = [];
  const emit = (next, extra = {}) => {
    state = next;
    details = { ...extra };
    onState(next, { ...details });
  };
  const silence = () => { try { stopAudio(); } catch (_) { /* cleanup must still complete */ } };
  const clear = name => {
    const timer = name === 'frame' ? frameTimer : name === 'limit' ? limitTimer
      : name === 'permission' ? permissionTimer : name === 'play' ? playTimer : gateTimer;
    if (timer !== null) clearTimeoutFn(timer);
    if (name === 'frame') frameTimer = null;
    else if (name === 'limit') limitTimer = null;
    else if (name === 'permission') permissionTimer = null;
    else if (name === 'play') playTimer = null;
    else gateTimer = null;
  };
  const stopStream = target => {
    for (const track of target?.getTracks?.() ?? []) {
      try { track.stop(); } catch (_) { /* release remaining tracks too */ }
    }
  };
  const releaseMic = () => {
    clear('frame'); clear('limit'); clear('permission');
    for (const [track, listener] of trackListeners) track.removeEventListener?.('ended', listener);
    trackListeners = [];
    const oldStream = stream;
    stream = null;
    stopStream(oldStream);
    try { source?.disconnect(); } catch (_) { /* already disconnected */ }
    try { analyser?.disconnect(); } catch (_) { /* already disconnected */ }
    source = null; analyser = null;
    if (samples) samples.fill(0);
    samples = null;
  };
  const releaseClock = () => {
    clear('play'); clear('gate'); gateEpoch++;
    context?.removeEventListener?.('statechange', contextChanged);
    context = null;
  };
  const cleanup = () => { releaseMic(); releaseClock(); silence(); };
  const fail = (code, token = epoch) => {
    if (token !== epoch || disposed) return false;
    epoch++;
    cleanup();
    tracker = null; events = [];
    emit('error', { code, message: MESSAGES[code] ?? MESSAGES['mic-error'] });
    return false;
  };
  const cancel = (reason = 'cancelled') => {
    epoch++;
    cleanup();
    tracker = null; events = [];
    if (!disposed) emit('idle', { reason });
  };
  function contextChanged() {
    if (BUSY.has(state) && context?.state !== 'running') cancel('audio-interrupted');
  }
  const backgrounded = () => {
    if (documentTarget?.hidden && BUSY.has(state)) cancel('background');
  };
  const pageHidden = () => { if (BUSY.has(state)) cancel('background'); };
  documentTarget?.addEventListener?.('visibilitychange', backgrounded);
  windowTarget?.addEventListener?.('pagehide', pageHidden);

  const playTick = token => {
    if (token !== epoch || state !== 'playing' || disposed) return;
    playTimer = null;
    if (context?.state !== 'running' || documentTarget?.hidden) { cancel('audio-interrupted'); return; }
    const elapsed = (now() - playbackOrigin) / 1000;
    // Long task / background stalls skip expired notes rather than bursting.
    while (playIndex < events.length && events[playIndex].start + events[playIndex].duration <= elapsed) playIndex++;
    const event = events[playIndex];
    if (!event) {
      clear('gate'); gateEpoch++;
      silence();
      releaseClock();
      emit('done', { events: events.map(item => ({ ...item })), noteCount: events.length, progress: 1 });
      return;
    }
    if (event.start <= elapsed + 0.002) {
      clear('gate'); gateEpoch++;
      const index = playIndex++;
      const duration = Math.max(0.02, event.duration - Math.max(0, elapsed - event.start));
      try {
        const played = play(event.midi, duration, index);
        if (played === false && token === epoch) { cancel('playback-blocked'); return; }
      } catch (_) { fail('audio-unavailable', token); return; }
      if (token !== epoch || state !== 'playing') return;
      emit('playing', { events: events.map(item => ({ ...item })), noteCount: events.length,
        noteIndex: index, pitchMidi: event.midi, elapsed, progress: elapsed / (events.at(-1).start + events.at(-1).duration) });
      if (token !== epoch || state !== 'playing') return;
    }
    const next = events[playIndex];
    const deadline = next?.start ?? (events.at(-1).start + events.at(-1).duration);
    // Absolute origin prevents drift from synthesis time or timer jitter.
    playTimer = setTimeoutFn(() => playTick(token), Math.max(1, playbackOrigin + deadline * 1000 - now()));
  };

  const finish = token => {
    if (token !== epoch || state !== 'listening' || disposed) return false;
    const elapsed = Math.min(HUMMING_MAX_SECONDS, Math.max(0, (now() - captureOrigin) / 1000));
    const raw = tracker.finish(elapsed);
    tracker = null;
    // All microphone tracks and nodes are gone before any playback callback.
    releaseMic();
    events = normalizeMelody(raw);
    emit('processing', { elapsed, noteCount: events.length });
    if (token !== epoch || disposed || state !== 'processing') return false;
    if (!events.length) return fail('no-notes', token);
    if (context?.state !== 'running' || documentTarget?.hidden) { cancel('audio-interrupted'); return false; }
    playbackOrigin = now() + 100;
    playIndex = 0;
    emit('playing', { events: events.map(event => ({ ...event })), noteCount: events.length, progress: 0 });
    if (token !== epoch || state !== 'playing') return false;
    playTimer = setTimeoutFn(() => playTick(token), 100);
    return true;
  };

  const captureFrame = token => {
    if (token !== epoch || state !== 'listening' || disposed) return;
    frameTimer = null;
    if (context?.state !== 'running' || documentTarget?.hidden) { cancel('audio-interrupted'); return; }
    const elapsed = Math.min(HUMMING_MAX_SECONDS, Math.max(0, (now() - captureOrigin) / 1000));
    let detected;
    try {
      analyser.getFloatTimeDomainData(samples);
      detected = detectPitchFn(samples, context.sampleRate);
    } catch (_) { fail('mic-error', token); return; }
    // No frame history or audio recording is kept, including between polls.
    samples.fill(0);
    const summary = tracker.push(detected, elapsed);
    emit('listening', { elapsed, progress: elapsed / HUMMING_MAX_SECONDS,
      frequency: detected.frequency, rms: detected.rms, confidence: detected.confidence,
      pitchMidi: summary.pitchMidi, noteCount: summary.noteCount });
    if (token !== epoch || state !== 'listening') return;
    if (elapsed >= HUMMING_MAX_SECONDS || summary.limitReached
      || (elapsed >= 1 && summary.hasVoiced && elapsed - summary.lastVoicedAt >= 0.60)) {
      finish(token);
      return;
    }
    frameTimer = setTimeoutFn(() => captureFrame(token), 20);
  };

  const beginCapture = token => {
    if (token !== epoch || disposed || state !== 'requesting') return false;
    try { context = getContext(); } catch (_) { return fail('audio-unavailable', token); }
    if (!context || context.state !== 'running' || typeof context.createMediaStreamSource !== 'function'
      || typeof context.createAnalyser !== 'function') return fail('audio-unavailable', token);
    if (documentTarget?.hidden) { cancel('background'); return false; }
    try {
      const tracks = stream?.getAudioTracks?.() ?? stream?.getTracks?.() ?? [];
      if (!tracks.length || tracks.some(track => track.readyState === 'ended')) return fail('track-ended', token);
      for (const track of tracks) {
        const listener = () => fail('track-ended', token);
        track.addEventListener?.('ended', listener);
        trackListeners.push([track, listener]);
      }
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = context.sampleRate > 96000 ? 8192 : 4096;
      analyser.smoothingTimeConstant = 0;
      if (typeof analyser.getFloatTimeDomainData !== 'function') return fail('unavailable', token);
      samples = new Float32Array(analyser.fftSize);
      source.connect(analyser); // Deliberately no connection to destination.
      context.addEventListener?.('statechange', contextChanged);
    } catch (_) { return fail('mic-error', token); }
    clear('permission');
    tracker = createNoteTracker();
    captureOrigin = now();
    emit('listening', { elapsed: 0, progress: 0, noteCount: 0, pitchMidi: null });
    if (token !== epoch || state !== 'listening') return false;
    limitTimer = setTimeoutFn(() => finish(token), HUMMING_MAX_SECONDS * 1000);
    // Let the guitar's bounded stop fade drain before the first microphone
    // frame, so the preceding pluck cannot be mistaken for the user's hum.
    frameTimer = setTimeoutFn(() => captureFrame(token), 100);
    return true;
  };

  const start = () => {
    if (disposed || BUSY.has(state)) return Promise.resolve(false);
    if (documentTarget?.hidden) { emit('idle', { reason: 'background' }); return Promise.resolve(false); }
    const token = ++epoch;
    cleanup();
    events = [];
    if (typeof mediaDevices?.getUserMedia !== 'function') return Promise.resolve(fail('unavailable', token));
    emit('requesting', { message: 'マイクの許可を確認しています。' });
    if (token !== epoch || state !== 'requesting') return Promise.resolve(false);
    let audioReady, request;
    try {
      // Both calls occur in the original click stack, before the first await.
      audioReady = Promise.resolve(unlock()).then(() => true, () => fail('audio-unavailable', token));
      request = mediaDevices.getUserMedia({ audio: { channelCount: 1,
        echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false });
    } catch (error) {
      const code = error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied'
        : error?.name === 'NotFoundError' ? 'no-device' : 'mic-error';
      return Promise.resolve(fail(code, token));
    }
    permissionTimer = setTimeoutFn(() => fail('permission-timeout', token), 30000);
    return Promise.resolve(request).then(async granted => {
      if (token !== epoch || disposed || state !== 'requesting') { stopStream(granted); return false; }
      stream = granted;
      const ready = await audioReady;
      if (token !== epoch || disposed || state !== 'requesting') return false;
      if (!ready) return fail('audio-unavailable', token);
      return beginCapture(token);
    }, error => {
      const code = error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied'
        : error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError' ? 'no-device' : 'mic-error';
      return fail(code, token);
    });
  };
  return {
    start,
    stopListening: () => finish(epoch),
    cancel,
    reset: () => cancel('reset'),
    dispose() {
      if (disposed) return;
      cancel('disposed');
      disposed = true;
      documentTarget?.removeEventListener?.('visibilitychange', backgrounded);
      windowTarget?.removeEventListener?.('pagehide', pageHidden);
    },
    getState: () => ({ status: state, ...details }),
    getEvents: () => events.map(event => ({ ...event })),
    get active() { return BUSY.has(state); },
  };
}

// A single, cancellable musical clock. Audio remains owned by the instrument.
const openMidi = [40, 45, 50, 55, 59, 64];
const roots = { open: 4, C: 0, G: 7, Am: 9, Em: 4 };
export function freeStrings(chord, frets, preset = 'red') {
  // Unfretted E/G/B/E form E minor; omit the open A and D strings.
  const strings = chord === 'open' ? [0, 3, 4, 5] : frets.flatMap((f, i) => f === null ? [] : [i]);
  if (preset !== 'black') return strings;
  // The lowest available root and fifth only: never a third in a power riff.
  // Read actual fretted pitches, not fixed string numbers (C/G/Am differ).
  const root = roots[chord];
  return [root, (root + 7) % 12].map(pc => strings.find(i => (openMidi[i] + frets[i]) % 12 === pc))
    .filter(i => i !== undefined);
}
// Original short phrases. Entries are [position in available pitches, beats,
// accent]. Exact subdivisions keep syncopation clear; only touch varies.
const scores = {
  red: { beat: 520, rest: 1560, velocity: .47, phrases: [
    [[1,1,0],[1,1,0],[2,1,.02],[3,2,.03],[2,1,0],[1,2,-.02]],
    [[2,1,0],[2,1,0],[1,1,-.01],[3,1,.02],[2,1,0],[1,3,-.02]]
  ] },
  mint: { beat: 440, rest: 440, velocity: .49, gate: .12, phrases: [
    [[0,.75,.04],[3,.25,-.05],[2,.5,.03],[3,1,-.04],[0,.75,.04],[2,.25,-.05],[3,.5,.02],[2,1,-.03]],
    [[0,.5,.04],[2,.25,-.05],[3,.75,.02],[2,1,-.03],[0,.75,.04],[3,.25,-.05],[2,1,.02]]
  ] },
  black: { beat: 380, rest: 380, velocity: .56, gate: .17, phrases: [
    [[0,.5,.03],[0,.5,-.02],[0,1,.02],[3,.5,.03],[0,.5,0],[0,1,.03],[3,1,.02],[0,2,.04]],
    [[0,.5,.03],[0,.5,-.02],[3,1,.03],[0,.5,0],[0,.5,-.02],[3,1,.02],[0,2,.04]]
  ] },
  darkbrown: { beat: 620, rest: 620, velocity: .45, phrases: [
    [[0,.5,.02],[3,.5,0],[1,.5,-.04],[2,.5,-.02],[0,.5,.02],[2,.5,0],[1,.5,-.04],[3,1.5,.02]],
    [[0,.5,.02],[2,.5,0],[1,.5,-.04],[3,.5,.01],[0,.5,.02],[3,.5,0],[2,.5,-.02],[1,1.5,-.03]]
  ] },
  redbrown: { beat: 540, rest: 540, velocity: .46, gate: .24, phrases: [
    [[0,1,.03],[2,.5,-.03],[3,.5,0],[0,.75,.02],[2,.75,-.03],[3,.5,.01]],
    [[0,.75,.03],[3,.75,-.02],[2,.5,0],[0,1,.02],[3,.5,-.03],[2,.5,.01]]
  ] }
};
// Every event shares a sixteenth-note grid. Rest durations are musical time.
export function rhythmAt(preset, tick) {
  const t = tick % 16;
  if (preset === 'mint') return [...(t === 0 || t === 7 || t === 10 ? [['kick', .7]] : []),
    ...(t === 4 || t === 12 ? [['snare', .55]] : []), ...(t % 2 === 0 ? [['hat', .36]] : [])];
  if (preset === 'black') return [...(t === 0 || t === 8 ? [['kick', .8]] : []),
    ...(t === 4 || t === 12 ? [['snare', .65]] : []), ...(t % 2 === 0 ? [['hat', .4]] : [])];
  if (preset === 'redbrown') return [...(t % 2 === 0 ? [['shaker', .42]] : []),
    ...(t === 0 || t === 6 || t === 10 ? [['tap', .45]] : [])];
  return t === 0 || t === 8 ? [['tap', preset === 'darkbrown' ? .4 : .35]] : [];
}
const timelines = Object.fromEntries(Object.entries(scores).map(([id, score]) => {
  let length = 0; const notes = new Map();
  for (const phrase of score.phrases) {
    for (const [index, [position, beats, accent]] of phrase.entries()) {
      // Short rhythm notes are clipped; sustained notes and phrase endings
      // retain the instrument's natural decay. Bossa is never hard-gated.
      const gate = id !== 'redbrown' && beats < 1 && index !== phrase.length - 1 ? score.gate : undefined;
      notes.set(length, { position, accent, gate }); length += beats * 4;
    }
    length += Math.round(score.rest / score.beat * 4);
  }
  return [id, { notes, length }];
}));
export function createFreeMode({ unlock, play, percussion = () => {}, silence = () => {}, getStrings, getPreset = () => 'red', canPlay, canStart = () => true, onChange = () => {}, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, now = () => performance.now() }) {
  let active = false, paused = false, timer = null, generation = 0, previousPreset = null, origin = 0, nextTick = 0;
  function cancel() {
    generation++; if (timer !== null) clearTimer(timer); timer = null; silence();
  }
  function stop() {
    cancel(); paused = false;
    if (active) { active = false; onChange(false); }
  }
  function pause() {
    if (!active || paused) return;
    cancel(); paused = true; onChange(true, true);
  }
  function schedule(token, at) {
    timer = setTimer(() => {
      if (token !== generation) return;
      timer = null; tick(token);
    }, Math.max(0, at - now()));
  }
  function tick(token) {
    if (!active || paused || token !== generation) return;
    const time = now(), requested = getPreset(), preset = Object.hasOwn(scores, requested) ? requested : 'red';
    if (preset !== previousPreset) { origin = time; nextTick = 0; previousPreset = preset; silence(); }
    const score = scores[preset], interval = score.beat / 4;
    // Absolute deadlines absorb callback cost and lateness. Skip missed grid
    // points, never issue a catch-up burst or accumulate random timing drift.
    const index = Math.max(nextTick, Math.floor((time - origin + .001) / interval));
    if (canPlay()) {
      const strings = getStrings(preset);
      if (!strings.length) { stop(); return; }
      const timeline = timelines[preset], note = timeline.notes.get(index % timeline.length);
      if (note) {
        const i = strings[Math.round(note.position / 3 * (strings.length - 1))];
        play(i, score.velocity + note.accent + (random() - .5) * .02, note.gate);
      }
      if (!active || paused || token !== generation) return;
      for (const [kind, level] of rhythmAt(preset, index)) percussion(kind, level);
    } else silence();
    if (!active || paused || token !== generation) return;
    nextTick = index + 1; schedule(token, origin + nextTick * interval);
  }
  async function start() {
    if ((active && !paused) || !canStart()) return;
    active = true; paused = false; previousPreset = null;
    const token = ++generation; onChange(true);
    try {
      await unlock();
      if (!active || paused || token !== generation) return;
      schedule(token, now() + 160);
    } catch (error) {
      if (token !== generation) return;
      stop(); onError(error);
    }
  }
  return { start, stop, pause, get active() { return active; }, get paused() { return paused; } };
}

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
  red: { beat: 520, rest: 1200, velocity: .47, phrases: [
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
export function createFreeMode({ unlock, play, getStrings, getPreset = () => 'red', canPlay, canStart = () => true, onChange = () => {}, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
  let active = false, paused = false, timer = null, generation = 0, phrase = 0, step = 0, previousPreset = null;
  function stop() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null; paused = false;
    if (active) { active = false; onChange(false); }
  }
  function pause() {
    if (!active || paused) return;
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null; paused = true; onChange(true, true);
  }
  function schedule(token, delay) {
    timer = setTimer(() => {
      if (token !== generation) return;
      timer = null; tick(token);
    }, delay);
  }
  function tick(token) {
    if (!active || paused || token !== generation) return;
    // Holds/mute skip time, rather than queueing a burst for release.
    if (!canPlay()) { schedule(token, 160); return; }
    const requested = getPreset(), preset = Object.hasOwn(scores, requested) ? requested : 'red';
    if (preset !== previousPreset) { phrase = 0; step = 0; previousPreset = preset; }
    const score = scores[preset], motif = score.phrases[phrase % score.phrases.length];
    const strings = getStrings(preset);
    if (!strings.length) { stop(); return; }
    // Re-read color and chord on every note. Never queue stale pitches.
    const [position, beats, accent] = motif[step];
    const i = strings[Math.round(position / 3 * (strings.length - 1))];
    play(i, score.velocity + accent + (random() - .5) * .02, score.gate);
    if (!active || paused || token !== generation) return;
    step++;
    let delay = beats * score.beat;
    if (step === motif.length) { step = 0; phrase++; delay += score.rest; }
    schedule(token, delay);
  }
  async function start() {
    if ((active && !paused) || !canStart()) return;
    active = true; paused = false; phrase = 0; step = 0; previousPreset = null;
    const token = ++generation;
    onChange(true);
    try {
      // Invoked synchronously from the ON click, before the first await.
      await unlock();
      if (!active || paused || token !== generation) return;
      schedule(token, 160);
    } catch (error) {
      if (token !== generation) return;
      stop(); onError(error);
    }
  }
  return { start, stop, pause, get active() { return active; }, get paused() { return paused; } };
}

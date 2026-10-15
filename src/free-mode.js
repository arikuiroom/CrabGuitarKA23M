// A single, cancellable musical clock. Audio remains owned by the instrument.
export function freeStrings(chord, frets) {
  // Unfretted E/G/B/E form E minor; omit the open A and D strings.
  return chord === 'open' ? [0, 3, 4, 5] : frets.flatMap((f, i) => f === null ? [] : [i]);
}
const motifs = [[0, 2, 1, 3], [0, 1, 2], [0, 3, 2, 1]];
export function createFreeMode({ unlock, play, getStrings, canPlay, onChange = () => {}, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
  let active = false, timer = null, generation = 0, phrase = 0, step = 0;
  function stop() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (active) { active = false; onChange(false); }
  }
  function schedule(token, delay) {
    timer = setTimer(() => { timer = null; tick(token); }, delay);
  }
  function tick(token) {
    if (!active || token !== generation) return;
    if (!canPlay()) { stop(); return; }
    const strings = getStrings(), motif = motifs[phrase % motifs.length];
    if (!strings.length) { stop(); return; }
    // Re-read the current chord for every note, rather than queuing stale pitches.
    const i = strings[Math.min(strings.length - 1, Math.round(motif[step] / 3 * (strings.length - 1)))];
    play(i, .44 + random() * .10);
    if (!active || token !== generation) return;
    step++;
    if (step === motif.length) {
      step = 0; phrase++;
      schedule(token, 1800 + random() * 500);
    } else schedule(token, 460 + random() * 140);
  }
  async function start() {
    if (active || !canPlay(false)) return;
    active = true; phrase = 0; step = 0;
    const token = ++generation;
    onChange(true);
    try {
      // Invoked synchronously from the ON click, before the first await.
      await unlock();
      if (!active || token !== generation) return;
      if (!canPlay()) { stop(); return; }
      schedule(token, 160);
    } catch (error) {
      if (token !== generation) return;
      stop(); onError(error);
    }
  }
  return { start, stop, get active() { return active; } };
}

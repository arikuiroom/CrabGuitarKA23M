// A single, cancellable musical clock. Audio remains owned by the instrument.
const openMidi = [40, 45, 50, 55, 59, 64];
const roots = { open: 4, C: 0, G: 7, Am: 9, Em: 4 };
export function freeStrings(chord, frets, preset = 'red') {
  // Unfretted E/G/B/E form E minor; omit the open A and D strings.
  const strings = chord === 'open' ? [0, 3, 4, 5] : frets.flatMap((f, i) => f === null ? [] : [i]);
  if (preset !== 'black') return strings;
  // Support uses the lowest available root and fifth, never fixed string
  // numbers. The single-note melody has its own, unrestricted pitch contour.
  const root = roots[chord];
  return [root, (root + 7) % 12].map(pc => strings.find(i => (openMidi[i] + frets[i]) % 12 === pc))
    .filter(i => i !== undefined);
}
// Estimated A/B notes only: [MIDI, onset seconds, duration seconds]. Each
// 6.2-second phrase spans 16 beats; preserve its unquantized timing ratios.
export const sourceMotifs = Object.freeze({
  A: Object.freeze([
    [67, .135, .174], [67, .530, .313], [67, .948, .662],
    [67, 1.691, .197], [60, 1.993, .151], [59, 2.329, .256],
    [60, 2.701, .139], [62, 2.875, .186], [60, 3.061, .406]
  ].map(Object.freeze)),
  B: Object.freeze([
    [60, .158, .174], [60, .564, .267], [60, .959, .639],
    [62, 1.992, .314], [60, 2.341, .348], [59, 2.689, .383],
    [60, 3.072, .674]
  ].map(Object.freeze))
});
const sourceSeconds = 6.2, phraseBeats = 16;
const styles = {
  red: { beat: 520, velocity: .47 },
  mint: { beat: 440, velocity: .49, dryGate: .12 },
  black: { beat: 380, velocity: .56, dryGate: .17 },
  darkbrown: { beat: 620, velocity: .45 },
  redbrown: { beat: 540, velocity: .46 }
};
// Keep C at the estimated pitches. G/Am use a lower octave displacement
// for a comfortable register; Em/open use the upper E register. In minor,
// lower the source B by a semitone before transposing: Am gets G, Em gets D.
export function melodyMidi(midi, chord = 'C') {
  const offsets = { C: 0, G: -5, Am: -3, Em: 4, open: 4 };
  const minor = chord === 'Am' || chord === 'Em' || chord === 'open';
  return midi + (offsets[chord] ?? 0) - (minor && midi % 12 === 11 ? 1 : 0);
}
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
// Merge arbitrary melody deadlines and the uninterrupted sixteenth grid.
// A/B repeat every 32 beats; the bounded timeline needs only one timer.
const timelines = Object.fromEntries(Object.entries(styles).map(([id, style]) => {
  const phraseMs = style.beat * phraseBeats, scale = phraseMs / sourceSeconds;
  const events = Array.from({ length: phraseBeats * 8 }, (_, tick) => ({ at: tick * style.beat / 4, tick }));
  Object.values(sourceMotifs).forEach((notes, phrase) => {
    notes.forEach(([midi, onset, duration], index) => {
      const seconds = duration * scale / 1000;
      // Preserve sung lengths, with drier short attacks for funk/rock. Each
      // final note is ungated, leaving a long natural tail and breathing space.
      const gate = index === notes.length - 1 ? undefined
        : style.dryGate && duration < sourceSeconds / phraseBeats ? Math.min(style.dryGate, seconds) : seconds;
      events.push({ at: phrase * phraseMs + onset * scale,
        note: { midi, gate, accent: index === 0 ? .025 : index === notes.length - 1 ? -.015 : 0 } });
    });
  });
  events.sort((a, b) => a.at - b.at);
  return [id, { events, duration: phraseMs * 2 }];
}));
// First event strictly after elapsed, in an indefinitely repeating timeline.
// Binary search skips arbitrarily long stalls without catch-up loops.
function after(timeline, elapsed) {
  const cycle = Math.floor(Math.max(0, elapsed) / timeline.duration);
  const local = elapsed - cycle * timeline.duration;
  let low = 0, high = timeline.events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timeline.events[middle].at <= local + .001) low = middle + 1;
    else high = middle;
  }
  return cycle * timeline.events.length + low;
}
function deadline(timeline, index) {
  return Math.floor(index / timeline.events.length) * timeline.duration
    + timeline.events[index % timeline.events.length].at;
}
export function createFreeMode({ unlock, play, percussion = () => {}, silence = () => {}, getStrings, getChord = () => 'C',
  getSupportStrings = () => [], getPreset = () => 'red', canPlay, canStart = () => true, onChange = () => {}, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, now = () => performance.now() }) {
  let active = false, paused = false, timer = null, generation = 0, previousPreset = null, origin = 0, nextEvent = 0;
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
  const current = token => active && !paused && token === generation;
  function schedule(token, at) {
    timer = setTimer(() => {
      if (!current(token)) return;
      timer = null; tick(token);
    }, Math.max(0, at - now()));
  }
  function tick(token) {
    if (!current(token)) return;
    const time = now(), requested = getPreset(), preset = Object.hasOwn(styles, requested) ? requested : 'red';
    if (preset !== previousPreset) { origin = time; nextEvent = 0; previousPreset = preset; silence(); }
    const style = styles[preset], timeline = timelines[preset];
    // Only the latest due event is eligible after a stall. All deadlines are
    // calculated from the origin, never from callback completion time.
    const index = Math.max(nextEvent, after(timeline, time - origin) - 1);
    const at = origin + deadline(timeline, index);
    if (at > time + .001) { schedule(token, at); return; }
    const event = timeline.events[index % timeline.events.length];
    if (canPlay()) {
      const strings = getStrings('red'), melodyString = strings.at(-1);
      if (melodyString === undefined) { stop(); return; }
      if (event.note) {
        const note = event.note, frequency = 440 * 2 ** ((melodyMidi(note.midi, getChord()) - 69) / 12);
        // A fixed treble string retains the instrument's same-string mono
        // release; changing notes never stacks several melodic voices.
        play(melodyString, style.velocity + note.accent + (random() - .5) * .02, note.gate, frequency);
      }
      if (!current(token)) return;
      // Optional low root/fifth support, once per eight beats in rock only.
      // Never reuse the melody string and never synthesize extra chord tones.
      if (preset === 'black' && event.tick !== undefined && event.tick % 32 === 0) {
        const support = getSupportStrings();
        const i = support[(event.tick / 32) % 2] ?? support[0];
        if (i !== undefined && i !== melodyString) play(i, .31, .17);
      }
      if (!current(token)) return;
      if (event.tick !== undefined) for (const [kind, level] of rhythmAt(preset, event.tick)) {
        percussion(kind, level);
        if (!current(token)) return;
      }
    } else silence();
    if (!current(token)) return;
    // Callback work can itself cross deadlines. Skip those too, rather than
    // scheduling a zero-delay burst, while keeping the original phase.
    nextEvent = Math.max(index + 1, after(timeline, now() - origin));
    schedule(token, origin + deadline(timeline, nextEvent));
  }
  async function start() {
    if ((active && !paused) || !canStart()) return;
    active = true; paused = false; previousPreset = null;
    const token = ++generation; onChange(true);
    try {
      await unlock();
      if (!current(token)) return;
      schedule(token, now() + 160);
    } catch (error) {
      if (token !== generation) return;
      stop(); onError(error);
    }
  }
  return { start, stop, pause, get active() { return active; }, get paused() { return paused; } };
}

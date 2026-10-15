import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { synthesize, synthesizeTimbre, GUITAR_PRESETS } from '../../src/audio.js';

const rms = (data, sr, from, to) => {
  let sum = 0; const start = Math.floor(from * sr), end = Math.floor(to * sr);
  for (let index = start; index < end; index++) sum += data[index] ** 2;
  return Math.sqrt(sum / (end - start));
};
function amplitude(data, hz, sr) {
  const start = Math.floor(sr * 0.02), end = Math.floor(sr * 0.14);
  let real = 0, imaginary = 0, weights = 0;
  for (let index = start; index < end; index++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (index - start) / (end - start - 1));
    const phase = index * hz * Math.PI * 2 / sr;
    real += data[index] * window * Math.cos(phase);
    imaginary += data[index] * window * Math.sin(phase);
    weights += window;
  }
  return Math.hypot(real, imaginary) * 2 / weights;
}
function pitch(data, hz, sr) {
  const start = Math.floor(sr * 0.07), length = Math.floor(sr * 0.1);
  const low = Math.floor(sr / hz * 0.9), high = Math.ceil(sr / hz * 1.1);
  const differences = new Map(); let best = Infinity, lag = low;
  for (let shift = low; shift <= high; shift++) {
    let difference = 0;
    for (let index = start; index < start + length; index++) difference += (data[index] - data[index + shift]) ** 2;
    differences.set(shift, difference);
    if (difference < best) { best = difference; lag = shift; }
  }
  const left = differences.get(lag - 1), right = differences.get(lag + 1);
  const adjust = (left - right) / (2 * (left - 2 * best + right));
  return sr / (lag + (Number.isFinite(adjust) ? adjust : 0));
}
let maxCents = 0;
for (const sr of [44100, 48000]) for (const hz of [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557]) {
  const rows = {};
  for (const timbre of ['steel', 'nylon', 'ukulele', 'bossa']) {
    const samples = synthesizeTimbre(hz, sr, 2, timbre);
    assert.equal(samples.length, sr * 2);
    assert.equal(samples[0], 0); assert.equal(samples.at(-1), 0);
    assert(samples.every(value => Number.isFinite(value) && Math.abs(value) <= 0.821));
    assert.deepEqual(samples, synthesizeTimbre(hz, sr, 2, timbre), 'timbre buffers remain deterministic');
    const cents = Math.abs(1200 * Math.log2(pitch(samples, hz, sr) / hz));
    maxCents = Math.max(cents, maxCents);
    assert(cents < 10, `${timbre} preserves ${hz} Hz rather than retuning it: ${cents} cents`);
    const harmonics = Array.from({ length: 12 }, (_, index) => amplitude(samples, hz * (index + 1), sr));
    rows[timbre] = {
      centroid: harmonics.reduce((sum, value, index) => sum + (index + 1) * value ** 2, 0)
        / harmonics.reduce((sum, value) => sum + value ** 2, 0),
      decay: rms(samples, sr, 0.8, 1) / rms(samples, sr, 0.03, 0.2),
    };
    if (timbre === 'steel') assert.deepEqual(samples, synthesize(hz, sr, 2));
  }
  assert(rows.bossa.centroid > rows.nylon.centroid, 'bossa nylon has a clearer attack than dark nylon');
  assert(rows.bossa.centroid < rows.steel.centroid, 'bossa retains rounded nylon rather than steel-string brightness');
  assert(rows.bossa.decay < rows.nylon.decay * 0.85, 'bossa phrasing has a tighter natural decay');
  assert(rows.bossa.decay > rows.ukulele.decay * 2, 'bossa keeps a guitar body rather than a short ukulele plonk');
  assert(rows.nylon.centroid < rows.steel.centroid * 0.8, 'nylon has a clearly rounder string spectrum');
  assert(rows.nylon.decay > rows.steel.decay * 1.12, 'nylon low modes sing instead of sounding like the short ukulele');
  assert(rows.ukulele.centroid > rows.steel.centroid * 1.05, 'ukulele has a brighter plucked attack');
  assert(rows.ukulele.decay < rows.steel.decay * 0.4, 'ukulele has a distinctly shorter natural decay');
  assert(rows.ukulele.decay < 0.08, 'revised ukulele has a lighter, fast-decaying body instead of the old guitar-like sustain');
  assert(rows.ukulele.centroid > (hz < 150 ? 2.65 : hz < 250 ? 2.3 : 2.04),
    'compact ukulele body resonance noticeably lifts the upper string modes across all six pitches');
}
assert.throws(() => synthesizeTimbre(110, 44100, 3, 'unknown'), RangeError);
assert.throws(() => synthesizeTimbre(110, 44100, 3, '__proto__'), RangeError);
assert.equal(GUITAR_PRESETS.black.drive, 8); assert.equal(GUITAR_PRESETS.black.clean, 0);
for (const id of ['darkbrown', 'redbrown']) {
  assert.equal(GUITAR_PRESETS[id].clean, 1); assert.equal(GUITAR_PRESETS[id].distorted, 0);
}
console.log(`Instrument synthesis tests passed: 48 six-string/rate/timbre checks; nylon is rounder and longer, bossa clearer and tighter, legacy ukulele brighter and shorter; exact requested pitches (max ${maxCents.toFixed(2)} cents), finite click-free buffers, clean acoustic branches, and high-gain metal.`);

if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  await writeFile(new URL('../browser/generated/qa-audio-instruments.html', import.meta.url), `<!doctype html>
<meta charset="utf-8"><title>Instrument timbre audio QA</title>
<button id="run">Run audio tests</button><pre id="result">Ready</pre>
<script type="module">
${renderBrowser.toString()}
document.querySelector('#run').addEventListener('click', async () => {
  document.querySelector('#run').disabled = true;
  document.querySelector('#result').textContent = 'Rendering…';
  try { document.querySelector('#result').textContent = JSON.stringify(await renderBrowser(new URL('../../../dist/audio.js', location.href).href), null, 2); }
  catch (error) { document.querySelector('#result').textContent = String(error.stack || error); }
  document.querySelector('#run').disabled = false;
});
</script>`);
  console.log('Temporary browser fixture written: tests/browser/generated/qa-audio-instruments.html');
}

async function renderBrowser(moduleUrl) {
  const { GuitarAudio } = await import(moduleUrl);
  const originalContext = globalThis.AudioContext;
  const rms = (data, sr, from, to) => {
    let sum = 0; const start = Math.floor(from * sr), end = Math.floor(to * sr);
    for (let index = start; index < end; index++) sum += data[index] ** 2;
    return Math.sqrt(sum / (end - start));
  };
  const peak = data => { let value = 0; for (const sample of data) value = Math.max(value, Math.abs(sample)); return value; };
  async function render(id, sr, mode) {
    const context = new OfflineAudioContext(2, Math.ceil(sr * 3.5), sr);
    context.resume = () => Promise.resolve();
    globalThis.AudioContext = function () { return context; };
    const audio = new GuitarAudio(); audio.setPreset(id); audio.setVolume(mode === 'overload' ? 1 : 0.45);
    await audio.unlock();
    if (mode === 'overload') {
      for (let round = 0; round < 2; round++) for (const hz of [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557]) audio.pluck(hz, 1);
    } else if (mode === 'cut') audio.pluckCut(110, 0.8);
    else audio.pluck(110, 0.8);
    const buffer = await context.startRendering();
    return { data: buffer.getChannelData(0), right: buffer.getChannelData(1) };
  }
  try {
    const results = [], differences = [];
    for (const sr of [44100, 48000]) {
      const normal = new Map();
      for (const id of ['red', 'mint', 'black', 'darkbrown', 'redbrown']) {
        const ordinary = await render(id, sr, 'normal'); normal.set(id, ordinary.data);
        const cut = await render(id, sr, 'cut');
        const overloaded = await render(id, sr, 'overload');
        const row = { id, sampleRate: sr,
          normalRms: rms(ordinary.data, sr, 0.03, 0.2),
          normalLateRms: rms(ordinary.data, sr, 0.8, 1),
          cutAttackRms: rms(cut.data, sr, 0.006, 0.055),
          cutBodyRms: rms(cut.data, sr, 0.35, 0.5),
          normalBodyRms: rms(ordinary.data, sr, 0.35, 0.5),
          peak: Math.max(...[ordinary, cut, overloaded].flatMap(rendered => [peak(rendered.data), peak(rendered.right)])),
          finite: [ordinary, cut, overloaded].every(rendered => rendered.data.every(Number.isFinite) && rendered.right.every(Number.isFinite)) };
        row.decayRatio = row.normalLateRms / row.normalRms;
        row.passed = row.finite && row.normalRms > 0.005 && row.cutAttackRms > 0.004
          && row.cutBodyRms < row.normalBodyRms * 0.12 && row.peak < 0.9;
        results.push(row);
      }
      const entries = [...normal.entries()];
      for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
        const levelA = rms(entries[a][1], sr, 0.03, 0.2), levelB = rms(entries[b][1], sr, 0.03, 0.2);
        const delta = entries[a][1].map((value, index) => value / levelA - entries[b][1][index] / levelB);
        differences.push({ sampleRate: sr, pair: `${entries[a][0]}/${entries[b][0]}`, normalizedRms: rms(delta, sr, 0.03, 0.2) });
      }
    }
    const acousticDecay = [44100, 48000].every(sr => {
      const rows = results.filter(row => row.sampleRate === sr);
      return rows.find(row => row.id === 'redbrown').decayRatio < rows.find(row => row.id === 'darkbrown').decayRatio * 0.85;
    });
    return { passed: results.every(row => row.passed) && differences.every(row => row.normalizedRms > 0.12) && acousticDecay,
      acousticDecay, results, differences };
  } finally { globalThis.AudioContext = originalContext; }
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { synthesizeHarmonic } from '../../src/audio.js';

const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557, 659.255];
const rms = (data, sr, from, to) => {
  const start = Math.floor(from * sr), end = Math.min(data.length, Math.floor(to * sr));
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] ** 2;
  return Math.sqrt(sum / (end - start));
};
function amplitude(data, hz, sr, from, to) {
  const start = Math.floor(from * sr), end = Math.min(data.length, Math.floor(to * sr));
  let real = 0, imaginary = 0, weights = 0;
  for (let i = start; i < end; i++) {
    const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start - 1));
    const phase = i * hz * 2 * Math.PI / sr;
    real += data[i] * weight * Math.cos(phase);
    imaginary += data[i] * weight * Math.sin(phase);
    weights += weight;
  }
  return 2 * Math.hypot(real, imaginary) / weights;
}
function peakPitchCents(data, hz, sr, from, to) {
  const levels = [];
  for (let cents = -4; cents <= 4; cents += 0.5) {
    levels.push(amplitude(data, hz * 2 ** (cents / 1200), sr, from, to));
  }
  const best = levels.indexOf(Math.max(...levels));
  assert(best > 0 && best < levels.length - 1, 'singing pitch stays inside the narrow ±4-cent search');
  const a = levels[best - 1], b = levels[best], c = levels[best + 1];
  return -4 + 0.5 * (best + (a - c) / (2 * (a - 2 * b + c)));
}
const summary = { cases: 0, maximumPitchCents: 0, maximumPitchDriftCents: 0,
  maximumAttackRatio: 0, minimumResidue: Infinity, maximumResidue: 0,
  maximumUpperModeDecayRatio: 0, minimumTailRatio: Infinity, maximumTailRatio: 0 };
for (const sr of [8000, 44100, 48000]) for (const frequency of frequencies) {
  const data = synthesizeHarmonic(frequency, sr, 1.4), label = `${frequency} Hz at ${sr} Hz`;
  assert(data.every(value => Number.isFinite(value) && Math.abs(value) <= 0.720001), `bounded finite PCM: ${label}`);
  assert.equal(data[0], 0); assert.equal(data.at(-1), 0);
  assert.deepEqual(data, synthesizeHarmonic(frequency, sr, 1.4), 'cached waveform remains deterministic');
  const earlyPitch = peakPitchCents(data, frequency * 4, sr, 0.06, 0.3);
  const latePitch = peakPitchCents(data, frequency * 4, sr, 0.55, 0.9);
  const pitch = Math.max(Math.abs(earlyPitch), Math.abs(latePitch));
  const drift = Math.abs(latePitch - earlyPitch);
  assert(pitch < 2 && drift < 2, `tiny shimmer must not become a siren or broad vibrato: ${label}, ${pitch}/${drift} cents`);
  const onset = rms(data, sr, 0, 0.002) / rms(data, sr, 0.01, 0.035);
  assert(onset > 0 && onset < 0.18, `delicate, non-instantaneous attack: ${label}, ${onset}`);
  const residue = amplitude(data, frequency, sr, 0.018, 0.11) / amplitude(data, frequency * 4, sr, 0.018, 0.11);
  const lateResidue = amplitude(data, frequency, sr, 0.55, 0.95) / amplitude(data, frequency * 4, sr, 0.55, 0.95);
  assert(residue > 0.025 && residue < 0.08, `faint real-string fundamental survives the onset: ${label}, ${residue}`);
  assert(lateResidue < residue * 0.15, `touch progressively damps the fundamental: ${label}`);
  if (frequency * 8 < sr * 0.43) {
    const earlyUpper = amplitude(data, frequency * 8, sr, 0.04, 0.18) / amplitude(data, frequency * 4, sr, 0.04, 0.18);
    const lateUpper = amplitude(data, frequency * 8, sr, 0.65, 0.95) / amplitude(data, frequency * 4, sr, 0.65, 0.95);
    assert(earlyUpper > 0.12 && earlyUpper < 0.3, `quiet but substantial upper string partial: ${label}`);
    assert(lateUpper < earlyUpper * 0.75, `upper modes decay faster than the singing mode: ${label}`);
    summary.maximumUpperModeDecayRatio = Math.max(summary.maximumUpperModeDecayRatio, lateUpper / earlyUpper);
  }
  const tail = rms(data, sr, 0.9, 1.1) / rms(data, sr, 0.05, 0.2);
  assert(tail > 0.2 && tail < 0.6, `audible decaying sustain, without a flat electronic tail: ${label}`);
  summary.cases++;
  summary.maximumPitchCents = Math.max(summary.maximumPitchCents, pitch);
  summary.maximumPitchDriftCents = Math.max(summary.maximumPitchDriftCents, drift);
  summary.maximumAttackRatio = Math.max(summary.maximumAttackRatio, onset);
  summary.minimumResidue = Math.min(summary.minimumResidue, residue);
  summary.maximumResidue = Math.max(summary.maximumResidue, residue);
  summary.minimumTailRatio = Math.min(summary.minimumTailRatio, tail);
  summary.maximumTailRatio = Math.max(summary.maximumTailRatio, tail);
}
for (const [hz, sr, duration] of [[20, 8000, 0.00001], [20, 8000, 0.001],
  [3599, 8000, 0.01], [6000, 48000, 0.08], [86399, 192000, 0.01], [110, 192000, 0.08]]) {
  const data = synthesizeHarmonic(hz, sr, duration);
  assert.equal(data.length, Math.max(1, Math.ceil(sr * duration)));
  assert(data.every(value => Number.isFinite(value) && Math.abs(value) <= 0.720001));
  assert.equal(data[0], 0); assert.equal(data.at(-1), 0);
}
console.log('Natural harmonic tests passed:', JSON.stringify(summary));

// A standalone, app-owned native graph fixture. The browser runs only the
// application's real Web Audio nodes; no substitute DSP or audio mocks.
async function nativeOfflineAudio() {
  const { GuitarAudio } = await import('../../../dist/audio.js');
  const frequencies = [82.406889, 110, 146.832384, 195.997718, 246.941651, 329.627557];
  const original = globalThis.AudioContext, results = [];
  const peak = data => { let value = 0; for (const sample of data) value = Math.max(value, Math.abs(sample)); return value; };
  const rms = (data, sr, from, to) => {
    const start = Math.floor(from * sr), end = Math.min(data.length, Math.floor(to * sr));
    let sum = 0; for (let i = start; i < end; i++) sum += data[i] ** 2;
    return Math.sqrt(sum / (end - start));
  };
  const amplitude = (data, hz, sr) => {
    const start = Math.floor(sr * 0.06), end = Math.floor(sr * 0.3);
    let re = 0, im = 0, weights = 0;
    for (let i = start; i < end; i++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - start) / (end - start - 1)), phase = i * hz * 2 * Math.PI / sr;
      re += data[i] * weight * Math.cos(phase); im += data[i] * weight * Math.sin(phase); weights += weight;
    }
    return 2 * Math.hypot(re, im) / weights;
  };
  try {
    for (const sr of [44100, 48000]) for (const preset of ['red', 'mint', 'black']) {
      for (const frequency of frequencies) {
        const context = new OfflineAudioContext(2, Math.ceil(sr * 4.35), sr);
        context.resume = () => Promise.resolve();
        globalThis.AudioContext = function () { return context; };
        const audio = new GuitarAudio(); audio.setPreset(preset); audio.setVolume(0.45); await audio.unlock();
        audio.pluckHarmonic(frequency, 0.8);
        const buffer = await context.startRendering(), data = buffer.getChannelData(0);
        const modes = [1, 2, 3, 4, 5].map(partial => amplitude(data, frequency * partial, sr));
        const body = rms(data, sr, 0.04, 0.2), tail = rms(data, sr, 0.9, 1.1);
        const row = { sr, preset, frequency, peak: peak(data), attackRms: rms(data, sr, 0.008, 0.035),
          bodyRms: body, tailRms: tail, tailRatio: tail / body,
          lateRms: rms(data, sr, 2.65, 2.85), finalRms: rms(data, sr, 4.15, 4.3),
          fourthDominance: modes[3] / Math.max(...modes.slice(0, 3), modes[4]), finite: data.every(Number.isFinite) };
        // Metal saturation/compression intentionally sustains near-constant
        // early loudness. Judge its later decay and complete natural ending;
        // source-mode decay itself is checked by the pure-PCM suite above.
        const decays = preset === 'black' ? row.lateRms < row.tailRms * 0.95
          : row.tailRatio < 0.9 && row.lateRms < row.bodyRms * 0.35;
        row.passed = row.finite && row.peak < 0.9 && row.attackRms > 0.002 && row.bodyRms > 0.004
          && row.tailRatio > 0.05 && decays && row.finalRms < 1e-7 && row.fourthDominance > 4;
        results.push(row);
      }
      const context = new OfflineAudioContext(2, Math.ceil(sr * 0.8), sr);
      context.resume = () => Promise.resolve();
      globalThis.AudioContext = function () { return context; };
      const audio = new GuitarAudio(); audio.setPreset(preset); audio.setVolume(1); await audio.unlock();
      for (let round = 0; round < 2; round++) for (const frequency of frequencies) audio.pluckHarmonic(frequency, 1);
      const stopped = context.suspend(0.3).then(async () => {
        audio.stopAll(); await OfflineAudioContext.prototype.resume.call(context);
      });
      const buffer = await context.startRendering(); await stopped;
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      const row = { sr, preset, mode: '12-voice-overload-and-stop', peak: Math.max(peak(left), peak(right)),
        stoppedRms: Math.max(rms(left, sr, 0.42, 0.78), rms(right, sr, 0.42, 0.78)),
        finite: left.every(Number.isFinite) && right.every(Number.isFinite) };
      row.passed = row.finite && row.peak < 0.9 && row.stoppedRms < 1e-7;
      results.push(row);
    }
    return { passed: results.every(row => row.passed), cases: results.length, results };
  } finally { globalThis.AudioContext = original; }
}
if (process.argv.includes('--write-browser-fixture')) {
  await mkdir(new URL('../browser/generated/', import.meta.url), { recursive: true });
  const fixture = `<!doctype html><meta charset="utf-8"><title>Natural harmonic audio QA</title>
<button id="run">Run native harmonic tests</button><pre id="result">Ready</pre>
<script type="module">${nativeOfflineAudio.toString()}
window.nativeOfflineAudio = nativeOfflineAudio;
window.runAudioTests = async () => {
  document.querySelector('#result').textContent = 'Rendering…';
  try { const result = await nativeOfflineAudio(); document.querySelector('#result').textContent = JSON.stringify(result, null, 2); return result; }
  catch (error) { document.querySelector('#result').textContent = String(error.stack || error); throw error; }
};
document.querySelector('#run').onclick = window.runAudioTests;
</script>`;
  await writeFile(new URL('../browser/generated/qa-harmonic-refinement.html', import.meta.url), fixture);
  console.log('Native fixture written: tests/browser/generated/qa-harmonic-refinement.html');
}

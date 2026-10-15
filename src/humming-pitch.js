/** Local, frame-by-frame humming analysis. No recording or network API is used. */
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const midiToFrequency = midi => 440 * 2 ** ((midi - 69) / 12);
export const frequencyToMidi = frequency => 69 + 12 * Math.log2(frequency / 440);

/**
 * Bounded YIN pitch estimate, using an averaged ~8 kHz working frame. The
 * returned result contains only scalar measurements; it never retains PCM.
 */
export function detectPitch(samples, sampleRate, options = {}) {
  const { minFrequency = 80, maxFrequency = 1000, minRms = 0.006 } = options;
  const empty = { frequency: null, midi: null, confidence: 0, rms: 0 };
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate < 8000
      || sampleRate > 192000 || minFrequency <= 0 || maxFrequency <= minFrequency) return empty;
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const count = Math.min(2048, Math.floor(samples.length / stride));
  const rate = sampleRate / stride;
  const minLag = Math.max(2, Math.floor(rate / maxFrequency));
  const maxLag = Math.min(Math.ceil(rate / minFrequency) + 1, Math.floor(count / 2));
  if (maxLag <= minLag + 1) return empty;
  const frame = new Float32Array(count);
  let mean = 0;
  for (let index = 0; index < count; index++) {
    let sum = 0;
    for (let part = 0; part < stride; part++) sum += samples[index * stride + part];
    frame[index] = sum / stride;
    mean += frame[index];
  }
  mean /= count;
  let energy = 0;
  for (let index = 0; index < count; index++) {
    frame[index] -= mean;
    energy += frame[index] * frame[index];
  }
  const rms = Math.sqrt(energy / count);
  if (!Number.isFinite(rms) || rms < minRms) return { ...empty, rms: Number.isFinite(rms) ? rms : 0 };
  const normalized = new Float32Array(maxLag + 1);
  const windowLength = count - maxLag;
  let running = 0;
  normalized[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let index = 0; index < windowLength; index++) {
      const delta = frame[index] - frame[index + lag];
      difference += delta * delta;
    }
    running += difference;
    normalized[lag] = running > 0 ? difference * lag / running : 1;
  }
  let lag = -1;
  // First good trough avoids choosing a subharmonic of an ordinary pure tone.
  for (let candidate = minLag; candidate < maxLag; candidate++) {
    if (normalized[candidate] < 0.18) {
      while (candidate + 1 < maxLag && normalized[candidate + 1] < normalized[candidate]) candidate++;
      lag = candidate;
      break;
    }
  }
  if (lag < 0) return { ...empty, rms };
  // A much deeper octave-related trough can reveal a weak fundamental under
  // a strong second harmonic. Tiny numerical improvements never halve pitch.
  const doubled = lag * 2;
  if (doubled + 1 < maxLag) {
    let best = doubled;
    for (let candidate = doubled - 1; candidate <= doubled + 1; candidate++) {
      if (normalized[candidate] < normalized[best]) best = candidate;
    }
    if (normalized[best] + 0.045 < normalized[lag]) lag = best;
  }
  const left = normalized[lag - 1], middle = normalized[lag], right = normalized[lag + 1];
  const denominator = left - 2 * middle + right;
  const correction = denominator ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0;
  const frequency = rate / (lag + correction);
  const confidence = clamp(1 - middle, 0, 1);
  if (!Number.isFinite(frequency) || frequency < minFrequency * 0.98
      || frequency > maxFrequency * 1.02 || confidence < 0.80) return { ...empty, rms, confidence };
  return { frequency, midi: frequencyToMidi(frequency), confidence, rms };
}

/** Stable monophonic segmentation with short-rest, vibrato and octave hysteresis. */
export function createNoteTracker(options = {}) {
  const { minNote = 0.08, restLength = 0.08, changeLength = 0.06,
    octaveLength = 0.12, maxNotes = 24 } = options;
  const events = [];
  let active = null, candidate = null, silenceAt = null, lastVoicedAt = null;
  let voiced = false, history = [], lastTime = 0;
  let rmsLevel = 0, valley = null;
  const close = time => {
    if (active && time - active.start >= minNote - 1e-7 && events.length < maxNotes) {
      events.push({ midi: active.midi, start: active.start, duration: Math.max(minNote, time - active.start) });
    }
    active = null;
    rmsLevel = 0;
    valley = null;
  };
  const info = () => ({ noteCount: events.length + (active ? 1 : 0),
    pitchMidi: active?.midi ?? null, lastVoicedAt, hasVoiced: lastVoicedAt !== null,
    limitReached: events.length >= maxNotes });
  return {
    push(result, time) {
      if (!Number.isFinite(time) || time < lastTime || events.length >= maxNotes) return info();
      lastTime = time;
      const accepted = result && Number.isFinite(result.midi) && Number.isFinite(result.frequency)
        && result.rms >= (voiced ? 0.006 : 0.010)
        && result.confidence >= (voiced ? 0.80 : 0.86);
      const rms = Number.isFinite(result?.rms) ? Math.max(0, result.rms) : null;
      // A confidence dropout alone is not a new hum. Require a deep RMS
      // valley lasting at least 50 ms and a sustained same-pitch return.
      // The wider entry threshold accommodates overlapping analyser frames;
      // only a trough below 60% of the previous level can retrigger.
      if (valley && time - valley.start > 0.20 && valley.returnAt === null) {
        valley = null;
        if (accepted) rmsLevel = rms; // A sustained quieter note is a new level.
      }
      if (active && rms !== null && rmsLevel > 0 && time - active.start >= minNote) {
        if (!valley && rms < rmsLevel * 0.72) {
          valley = { start: time, end: null, returnAt: null, level: rmsLevel, minimum: rms };
        }
        if (valley) {
          if (rms < valley.level * 0.72) {
            if (valley.end !== null) {
              valley.start = time;
              valley.minimum = rms;
            }
            valley.minimum = Math.min(valley.minimum, rms);
            valley.end = null;
            valley.returnAt = null;
          } else {
            valley.end ??= time;
            if (valley.end - valley.start < 0.05 - 1e-7 || valley.minimum > valley.level * 0.60) {
              valley = null;
            } else if (accepted && rms >= valley.level * 0.90 && Math.abs(result.midi - active.midi) < 0.68) {
              valley.returnAt ??= time;
              if (time - valley.returnAt >= 0.04 - 1e-7) {
                const next = { midi: active.midi, start: valley.end };
                close(valley.start);
                if (events.length < maxNotes) active = next;
                candidate = null;
                history = [];
              }
            } else valley.returnAt = null;
          }
        }
      }
      if (!valley && accepted) {
        // Follow rising loudness quickly, but do not let the falling edge of
        // an overlapping analysis window erase its own valley reference.
        const weight = rms < rmsLevel ? 0.02 : 0.2;
        rmsLevel = rmsLevel ? rmsLevel + (rms - rmsLevel) * weight : rms;
      }
      if (!accepted) {
        if (silenceAt === null) silenceAt = time;
        candidate = null;
        if (time - silenceAt >= restLength - 1e-7) {
          close(silenceAt);
          history = [];
          voiced = false;
        }
        return info();
      }
      voiced = true;
      lastVoicedAt = time;
      silenceAt = null;
      history.push(result.midi);
      if (history.length > 3) history.shift();
      const sorted = [...history].sort((a, b) => a - b);
      const midi = sorted[Math.floor(sorted.length / 2)];
      // Keep a note stable around a semitone boundary instead of chattering.
      const rounded = active && Math.abs(midi - active.midi) < 0.68 ? active.midi : Math.round(midi);
      if (active?.midi === rounded) {
        candidate = null;
        return info();
      }
      if (candidate?.midi !== rounded) candidate = { midi: rounded, start: time };
      const threshold = active && Math.abs(candidate.midi - active.midi) === 12 ? octaveLength : changeLength;
      if (time - candidate.start >= threshold - 1e-7) {
        close(candidate.start);
        if (events.length < maxNotes) active = candidate;
        candidate = null;
      }
      return info();
    },
    finish(time = lastTime) {
      const end = Math.max(lastTime, Number.isFinite(time) ? time : lastTime);
      close(silenceAt ?? end);
      candidate = null;
      history = [];
      return events.map(event => ({ ...event }));
    },
    getState: info,
  };
}

/** Move the whole phrase by octaves, never folding/clamping individual notes. */
export function normalizeMelody(events, options = {}) {
  const { minMidi = 45, maxMidi = 81, maxNotes = 24 } = options;
  const valid = events.filter(event => Number.isFinite(event.midi) && Number.isFinite(event.start)
    && Number.isFinite(event.duration) && event.duration >= 0.06)
    .slice(0, maxNotes).sort((a, b) => a.start - b.start);
  if (!valid.length) return [];
  let shift = 0, bestScore = Infinity;
  for (let octaves = -4; octaves <= 4; octaves++) {
    const offset = octaves * 12;
    const rangePenalty = valid.reduce((sum, event) => sum
      + Math.max(0, minMidi - event.midi - offset) ** 2
      + Math.max(0, event.midi + offset - maxMidi) ** 2, 0);
    const center = valid.reduce((sum, event) => sum + event.midi + offset, 0) / valid.length;
    const score = rangePenalty * 100 + Math.abs(offset) + Math.abs(center - 62) * 0.05;
    if (score < bestScore) { bestScore = score; shift = offset; }
  }
  const origin = valid[0].start;
  return valid.map(event => ({ midi: Math.round(event.midi) + shift,
    start: Math.round((event.start - origin) * 1000) / 1000,
    duration: Math.round(Math.max(0.08, event.duration) * 1000) / 1000 }));
}

/**
 * Sample-free acoustic guitar. A plucked string is rendered as damped modes:
 * pluck-position comb, string stiffness, frequency-dependent losses, and a
 * short bridge/pick transient. All presets preserve the requested guitar pitch.
 * No network, microphone, or third-party audio assets are used.
 */
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const DISTORTION_LEVEL = 0.16;
const REVERB_DRY = 0.9;
const REVERB_WET = 0.2;
const CHOKE_TIME = 0.072;
const OUTPUT_DRAIN_TIME = 0.012;
const CUT_CHOKE_TIME = 0.012;
const CUT_NOTE_DURATION = 0.14;
const CUT_STRING_SPACING = 0.0035;
const NYLON_HARMONIC_DURATION = 0.21;
const STRING_RELEASE_TIME = 0.02;
const STRING_COUNT = 6;

/** Color and sound are one selection. Every preset replaces all DSP settings. */
export const GUITAR_PRESETS = Object.freeze(Object.fromEntries(Object.entries({
  red: { name: 'Clean Space', highpass: 45, bass: -1, mids: -1, treble: 2.5,
    cutoff: 11000, drive: 1, clean: 1, distorted: 0, output: 1.1, dry: 0.88, wet: 0.32 },
  mint: { name: 'Funk Wah', highpass: 95, bass: -3.5, mids: 1.5, treble: 3,
    cutoff: 8200, drive: 1, clean: 1, distorted: 0, output: 1.25, dry: 0.99, wet: 0.025 },
  black: { name: 'Metal', highpass: 95, bass: 2, mids: -4.5, treble: 1,
    cutoff: 4200, drive: 8, clean: 0, distorted: 0.095, output: 1, dry: 1, wet: 0.016 },
  darkbrown: { name: 'Nylon', highpass: 28, bass: 2, mids: 1, treble: -3,
    cutoff: 5800, drive: 1, clean: 1, distorted: 0, output: 0.58, dry: 0.97, wet: 0.055 },
  redbrown: { name: 'Bossa Nylon', highpass: 32, bass: 1.5, mids: 1.2, treble: -0.5,
    cutoff: 6800, drive: 1, clean: 1, distorted: 0, output: 0.66, dry: 0.99, wet: 0.025 },
}).map(([id, settings]) => [id, Object.freeze({ id, ...settings })])));

/** Every color keeps the supplied guitar register, including the bass strings. */
export function getPlaybackFrequency(frequency, preset) {
  return frequency;
}

// A last safety stage is linear at ordinary levels and gently bounds overloads.
// It follows compression, so rapid twelve-note strums cannot digitally clip.
export function createOutputSafetyCurve(length = 4097) {
  if (!Number.isInteger(length) || length < 3 || length > 65537) {
    throw new RangeError('curve length must be an integer between 3 and 65537');
  }
  return Float32Array.from({ length }, (_, index) => {
    const input = index * 2 / (length - 1) - 1;
    const magnitude = Math.abs(input);
    return Math.sign(input) * (magnitude <= 0.55 ? magnitude
      : 0.55 + 0.35 * Math.tanh((magnitude - 0.55) / 0.35));
  });
}

/** Odd, DC-free soft clipping. Output trim lives in the reusable wet branch. */
export function createDistortionCurve(length = 4097) {
  if (!Number.isInteger(length) || length < 3 || length > 65537) {
    throw new RangeError('curve length must be an integer between 3 and 65537');
  }
  const curve = new Float32Array(length);
  const normalization = Math.tanh(8);
  for (let index = 0; index < length; index++) {
    const input = index * 2 / (length - 1) - 1;
    curve[index] = Math.tanh(8 * input) / normalization;
  }
  return curve;
}

/** Deterministic stereo room, including predelay and a one-second fading tail. */
export function createReverbImpulse(sampleRate = 44100, duration = 1.05) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 4) {
    throw new RangeError('reverb duration must be between 0.2 and 4 seconds');
  }
  const length = Math.ceil(sampleRate * duration);
  return [0, 1].map(channel => {
    const samples = new Float32Array(length);
    const predelay = Math.round(sampleRate * 0.012);
    const release = Math.round(sampleRate * 0.06);
    // Independent deterministic noise on each side creates stereo width.
    let seed = channel ? 0x4e631ac9 : 0x71b59d23;
    let damped = 0;
    for (let frame = predelay; frame < length; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed >>> 0) / 2147483648 - 1;
      damped += 0.32 * (noise - damped);
      const progress = (frame - predelay) / (length - predelay);
      const fade = frame >= length - release
        ? 0.5 - 0.5 * Math.cos(Math.PI * (length - 1 - frame) / release) : 1;
      samples[frame] = damped * Math.exp(-6 * progress) * fade;
    }
    // Small early reflections keep the room audible without a long wash.
    for (const [time, level] of [[0.019, 0.4], [0.033, 0.28], [0.057, 0.19], [0.091, 0.12]]) {
      const frame = Math.round((time + channel * 0.0017) * sampleRate);
      if (frame < length) samples[frame] += level;
    }
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    // Explicit energy normalization avoids browser-dependent automatic gain.
    const scale = energy ? 0.65 / Math.sqrt(energy) : 0;
    for (let frame = 0; frame < length; frame++) samples[frame] *= scale;
    samples[length - 1] = 0;
    return samples;
  });
}

// These synthesis profiles alter excitation/decay, not the supplied pitch.
// Steel preserves the original red instrument's waveform exactly.
const PLUCK_TIMBRES = {
  steel: { position: 0.185, stiffness: 0.000018, brightness: 3900, slope: 1.22,
    decay: 1.05, pitchDecay: 0.18, modeLoss: 0.09, lossPower: 1.3,
    pickDuration: 0.024, pickLevel: 0.017, pickDecay: 0.006, attack: 0.0015, release: 0.055 },
  nylon: { position: 0.235, stiffness: 0.000006, brightness: 3200, slope: 1.58,
    decay: 1.3, pitchDecay: 0.16, modeLoss: 0.15, lossPower: 1.35,
    pickDuration: 0.018, pickLevel: 0.006, pickDecay: 0.004, attack: 0.0022, release: 0.055 },
  // A tighter fingerpicked nylon voice for bossa: rounded bass and clear treble.
  bossa: { position: 0.215, stiffness: 0.000006, brightness: 3900, slope: 1.48,
    decay: 0.92, pitchDecay: 0.16, modeLoss: 0.14, lossPower: 1.35,
    pickDuration: 0.016, pickLevel: 0.0065, pickDecay: 0.004, attack: 0.002, release: 0.055 },
  ukulele: { position: 0.135, stiffness: 0.000003, brightness: 8000, slope: 1.28,
    decay: 0.31, pitchDecay: 0.04, modeLoss: 0.065, lossPower: 1.12,
    pickDuration: 0.012, pickLevel: 0.01, pickDecay: 0.0028, attack: 0.0008, release: 0.035,
    bodyFrequency: 720, bodyGain: 1.3, bodyWidth: 0.9 },
};

/** Render a mono steel-string pluck. Pure and deterministic for buffer caching. */
export function synthesize(frequency, sampleRate = 44100, duration = 3) {
  return synthesizeTimbre(frequency, sampleRate, duration, 'steel');
}

/** Nylon and ukulele-style excitation preserve the exact requested pitch. */
export function synthesizeTimbre(frequency, sampleRate = 44100, duration = 3, timbre = 'steel') {
  if (!Object.hasOwn(PLUCK_TIMBRES, timbre)) throw new RangeError('unknown string timbre');
  const profile = PLUCK_TIMBRES[timbre];
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (!Number.isFinite(frequency) || frequency < 20 || frequency >= sampleRate * 0.45) {
    throw new RangeError('frequency must be audible and below the Nyquist limit');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 12) {
    throw new RangeError('duration must be greater than zero and at most 12 seconds');
  }
  const length = Math.max(1, Math.ceil(sampleRate * duration));
  const output = new Float32Array(length);
  const pluckPosition = profile.position;
  const stiffness = profile.stiffness;
  const modes = Math.min(40, Math.floor(sampleRate * 0.43 / frequency));
  const baseDecay = profile.decay * Math.pow(110 / frequency, profile.pitchDecay);

  for (let harmonic = 1; harmonic <= modes; harmonic++) {
    const hz = frequency * harmonic * Math.sqrt(
      (1 + stiffness * harmonic * harmonic) / (1 + stiffness)
    );
    if (hz >= sampleRate * 0.45) break;
    const brightness = 1 / Math.sqrt(1 + Math.pow(hz / profile.brightness, 4));
    // A compact wooden soundbox emphasizes upper string modes. This adds the
    // light, hollow ukulele 'plonk' without octaving or silently retuning E2.
    const body = profile.bodyFrequency ? 1 + profile.bodyGain * Math.exp(-0.5
      * (Math.log2(hz / profile.bodyFrequency) / profile.bodyWidth) ** 2) : 1;
    const amplitude = Math.sin(Math.PI * harmonic * pluckPosition)
      / Math.pow(harmonic, profile.slope) * brightness * body;
    // High modes lose energy sooner: a bright attack naturally becomes warm.
    const decay = baseDecay / (1 + profile.modeLoss * Math.pow(harmonic - 1, profile.lossPower));
    const radius = Math.exp(-1 / (sampleRate * decay));
    const omega = TAU * hz / sampleRate;
    const coefficient = 2 * radius * Math.cos(omega);
    const radiusSquared = radius * radius;
    let previous = 0;
    let current = amplitude * Math.sin(omega) * radius;
    for (let frame = 1; frame < length; frame++) {
      output[frame] += current;
      const next = coefficient * current - radiusSquared * previous;
      previous = current;
      current = next;
    }
  }

  // A little non-pitched pick/bridge energy, restricted to the initial attack.
  // Its level stays well below the string, preserving a clear pitch on E2.
  let seed = Math.round(frequency * 8191) | 0;
  let previousNoise = 0;
  for (let frame = 0; frame < Math.min(length, sampleRate * profile.pickDuration); frame++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1;
    const highpassed = noise - previousNoise;
    previousNoise = noise;
    output[frame] += highpassed * profile.pickLevel * Math.exp(-frame / (sampleRate * profile.pickDecay));
  }

  // Raised-cosine attack and release make even stolen/short buffers click-free.
  const attack = Math.max(1, Math.min(length, Math.round(sampleRate * profile.attack)));
  const release = Math.max(1, Math.min(length, Math.round(sampleRate * profile.release)));
  let peak = 0;
  for (let frame = 0; frame < length; frame++) {
    let envelope = frame < attack ? 0.5 - 0.5 * Math.cos(Math.PI * frame / attack) : 1;
    if (frame >= length - release) {
      envelope *= 0.5 - 0.5 * Math.cos(Math.PI * (length - 1 - frame) / release);
    }
    output[frame] *= envelope;
    peak = Math.max(peak, Math.abs(output[frame]));
  }
  const normalization = peak ? 0.82 / peak : 1;
  for (let frame = 0; frame < length; frame++) output[frame] *= normalization;
  output[0] = 0;
  output[length - 1] = 0;
  return output;
}

/**
 * A lightly touched steel string: the fourth mode blooms above faint, briefly
 * surviving lower modes. Higher modes lose energy faster; a quiet near-unison
 * polarization adds slow natural beating without bending the nominal pitch.
 * All motion is rendered once into deterministic, bounded cached PCM.
 */
export function synthesizeHarmonic(frequency, sampleRate = 44100, duration = 3) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (!Number.isFinite(frequency) || frequency < 20 || frequency >= sampleRate * 0.45) {
    throw new RangeError('frequency must be audible and below the Nyquist limit');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 12) {
    throw new RangeError('duration must be greater than zero and at most 12 seconds');
  }
  const length = Math.max(1, Math.ceil(sampleRate * duration));
  const output = new Float32Array(length);
  // Retain a real available mode at extreme pitches instead of folding an
  // out-of-band fourth mode back into the audible range.
  const dominant = Math.min(4, Math.max(1, Math.floor(sampleRate * 0.43 / frequency)));
  const baseDecay = 1.16 * Math.pow(110 / frequency, 0.14);
  const addMode = (hz, level, decay, rise, phase = 0) => {
    if (hz >= sampleRate * 0.45) return;
    const radius = Math.exp(-1 / (sampleRate * decay));
    const omega = TAU * hz / sampleRate;
    const coefficient = 2 * radius * Math.cos(omega);
    const radiusSquared = radius * radius;
    // The two initial states retain a small mode-dependent phase while the
    // excitation rise keeps the physical string onset soft and click-free.
    let previous = level * Math.sin(phase);
    let current = level * Math.sin(omega + phase) * radius;
    const riseRadius = Math.exp(-1 / (sampleRate * rise));
    let contact = riseRadius;
    for (let frame = 1; frame < length; frame++) {
      output[frame] += current * (1 - contact);
      const next = coefficient * current - radiusSquared * previous;
      previous = current;
      current = next;
      // Drop an inaudible contact residue before it becomes a denormal.
      contact = contact > 1e-7 ? contact * riseRadius : 0;
    }
  };
  // Touching a node damps, rather than perfectly deletes, the lower modes.
  // The faint fundamental outlasts the touch noise but never takes over pitch.
  for (let partial = 1; partial < dominant; partial++) {
    addMode(frequency * partial, [0, 0.072, 0.044, 0.028][partial],
      partial === 1 ? 0.2 : 0.105 - partial * 0.012, 0.0012, partial * 0.17);
  }
  const stiffness = 0.000012;
  const levels = [1, 0.235, 0.082, 0.031, 0.011];
  for (let multiple = 1; multiple <= levels.length; multiple++) {
    const partial = dominant * multiple;
    // Anchor the singing mode exactly; only the quieter upper string modes
    // acquire the tiny inharmonic stretch of a stiff real string.
    const hz = frequency * partial * Math.sqrt((1 + stiffness * partial * partial)
      / (1 + stiffness * dominant * dominant));
    const decay = baseDecay / (1 + 0.92 * Math.pow(multiple - 1, 1.35));
    const rise = multiple === 1 ? 0.0046 : 0.0023;
    addMode(hz, levels[multiple - 1], decay, rise, (multiple - 1) * 0.21);
    if (multiple === 1) {
      // Two vibration directions couple slightly differently to the bridge.
      // A quiet 0.9–1.6 cent companion creates restrained, non-periodic-feeling
      // shimmer as it decays; there is no LFO, pitch sweep or realtime DSP.
      const separation = 0.9 + 0.7 * Math.min(1, frequency / 440);
      addMode(hz * 2 ** (separation / 1200), 0.14, decay * 0.73, 0.0065, 0.32);
    }
  }
  // Imperfect contact leaves one neighbouring mode only at the onset.
  addMode(frequency * (dominant + 1), 0.026, 0.065, 0.0018, 0.28);
  let seed = Math.round(frequency * 7907) | 0, softenedNoise = 0;
  const noiseBlend = 1 - Math.exp(-TAU * 1800 / sampleRate);
  for (let frame = 0; frame < Math.min(length, sampleRate * 0.018); frame++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1;
    softenedNoise += noiseBlend * (noise - softenedNoise);
    output[frame] += softenedNoise * 0.007 * Math.exp(-frame / (sampleRate * 0.004));
  }
  const attack = Math.max(1, Math.min(length, Math.round(sampleRate * 0.0032)));
  const release = Math.max(1, Math.min(length, Math.round(sampleRate * 0.065)));
  let peak = 0;
  for (let frame = 0; frame < length; frame++) {
    let envelope = frame < attack ? 0.5 - 0.5 * Math.cos(Math.PI * frame / attack) : 1;
    if (frame >= length - release) {
      envelope *= 0.5 - 0.5 * Math.cos(Math.PI * (length - 1 - frame) / release);
    }
    output[frame] *= envelope;
    peak = Math.max(peak, Math.abs(output[frame]));
  }
  const normalization = peak ? 0.72 / peak : 1;
  for (let frame = 0; frame < length; frame++) output[frame] *= normalization;
  output[0] = output[length - 1] = 0;
  return output;
}

/**
 * A lightly stopped nylon touch: round fundamental, a few soft string modes,
 * and a very short wooden-body knock. Unlike the electric pinch excitation,
 * it never selects a ringing fourth partial or adds a bright pick-noise click.
 * The pitch stays on the fretted string while the body makes a dry "pok".
 */
export function synthesizeNylonTouch(frequency, sampleRate = 44100, duration = NYLON_HARMONIC_DURATION) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be between 8000 and 192000 Hz');
  }
  if (!Number.isFinite(frequency) || frequency < 20 || frequency >= sampleRate * 0.45) {
    throw new RangeError('frequency must be audible and below the Nyquist limit');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 12) {
    throw new RangeError('duration must be greater than zero and at most 12 seconds');
  }
  const length = Math.max(1, Math.ceil(sampleRate * duration));
  const output = new Float32Array(length);
  const decay = 0.052 * Math.pow(110 / frequency, 0.08);
  const modes = [[frequency, 1, decay], [frequency * 2, 0.24, decay * 0.64],
    [frequency * 3, 0.055, decay * 0.4], [frequency * 4, 0.014, decay * 0.27],
    [185, 0.12, 0.012], [370, 0.055, 0.008]];
  for (const [hz, level, time] of modes) {
    if (hz >= sampleRate * 0.45) continue;
    const radius = Math.exp(-1 / (sampleRate * time));
    const omega = TAU * hz / sampleRate;
    const coefficient = 2 * radius * Math.cos(omega);
    const radiusSquared = radius * radius;
    let previous = 0, current = level * Math.sin(omega) * radius;
    for (let frame = 1; frame < length; frame++) {
      output[frame] += current;
      const next = coefficient * current - radiusSquared * previous;
      previous = current;
      current = next;
    }
  }
  const attack = Math.max(1, Math.min(length, Math.round(sampleRate * 0.0035)));
  const release = Math.max(1, Math.min(length, Math.round(sampleRate * 0.035)));
  let peak = 0;
  for (let frame = 0; frame < length; frame++) {
    let envelope = frame < attack ? 0.5 - 0.5 * Math.cos(Math.PI * frame / attack) : 1;
    if (frame >= length - release) {
      envelope *= 0.5 - 0.5 * Math.cos(Math.PI * (length - 1 - frame) / release);
    }
    output[frame] *= envelope;
    peak = Math.max(peak, Math.abs(output[frame]));
  }
  const normalization = peak ? 0.72 / peak : 1;
  for (let frame = 0; frame < length; frame++) output[frame] *= normalization;
  output[0] = output[length - 1] = 0;
  return output;
}

/** Short deterministic percussion, precomputed once per context. No samples,
 * oscillators, effects graph or timer per hit. PCM peaks stay below .05. */
export function synthesizePercussion(kind, sampleRate = 44100) {
  const durations = { kick: .18, snare: .13, hat: .045, shaker: .07, tap: .085 };
  if (!Object.hasOwn(durations, kind) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Invalid percussion buffer');
  const data = new Float32Array(Math.ceil(durations[kind] * sampleRate));
  let seed = 0x723ab19, previous = 0;
  for (let i = 0; i < data.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1, t = i / sampleRate;
    const high = (noise - previous) * .5; previous = noise;
    const envelope = Math.min(1, t / .002) * Math.exp(-t * (kind === 'kick' ? 28 : 50)) * Math.min(1, (data.length - 1 - i) / (sampleRate * .008));
    const wave = kind === 'kick' ? Math.sin(TAU * (48 * t + 1.8 * (1 - Math.exp(-30 * t))))
      : kind === 'tap' ? .65 * Math.sin(TAU * 330 * t) + .35 * high
      : kind === 'snare' ? .75 * noise + .25 * Math.sin(TAU * 175 * t) : high;
    data[i] = wave * envelope * .048;
  }
  return data;
}

export class GuitarAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.outputAnalyser = null;
    this.outputSamples = null;
    this.compressor = null;
    this.safety = null;
    this.damper = null;
    this.damped = false;
    this.damperClosed = false;
    this.dampSafeAt = 0;
    this.preset = 'red';
    this.effects = { distortion: false, reverb: true };
    this.tailSafeAt = 0;
    this.effectInput = null;
    this.effectNodes = null;
    this.dryInput = null;
    this.dryNodes = null;
    this.volume = 0.22;
    this.muted = false;
    this.maxVoices = 12;
    this.voices = [];
    this.stringVoices = Array(STRING_COUNT).fill(null);
    // Releasing/stolen sources remain bendable until their actual ended event.
    this.liveVoices = new Set();
    this.automation = new WeakMap();
    this.bend = 0;
    this.bendEnvelope = { from: 0, to: 0, start: 0, end: 0 };
    this.cache = new Map();
    this.percussionBuffers = new Map();
    this.percussionVoices = new Set();
    this.maxPercussionVoices = 6;
  }

  /** Call from pointerdown/keydown. Creation and resume occur in that gesture. */
  unlock() {
    if (this.context?.state === 'running') return Promise.resolve();
    try {
      if (!this.context || this.context.state === 'closed') {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) return Promise.reject(new Error('Web Audio is unavailable in this browser.'));
        this.context = new Context({ latencyHint: 'interactive' });
        this.outputAnalyser = null;
        this.outputSamples = null;
        this.cache.clear();
        for (const voice of this.percussionVoices) this._endPercussion(voice);
        this.percussionBuffers.clear();
        for (const kind of ['kick', 'snare', 'hat', 'shaker', 'tap']) {
          const pcm = synthesizePercussion(kind, this.context.sampleRate);
          const buffer = this.context.createBuffer(1, pcm.length, this.context.sampleRate);
          buffer.getChannelData(0).set(pcm); this.percussionBuffers.set(kind, buffer);
        }
        this.voices = [];
        this.stringVoices.fill(null);
        this.liveVoices.clear();
        this.automation = new WeakMap();
        this.bendEnvelope = { from: this.bend, to: this.bend, start: 0, end: 0 };
        this.tailSafeAt = 0;
        this.dampSafeAt = 0;
        this.damperClosed = this.damped;
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.compressor = this.context.createDynamicsCompressor();
        this.compressor.threshold.value = -18;
        this.compressor.knee.value = 12;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.16;
        this.safety = this.context.createWaveShaper();
        this.safety.curve = createOutputSafetyCurve();
        this.damper = this.context.createGain();
        this.damper.gain.value = this.damped ? 0 : 1;
        this.compressor.connect(this.safety);
        this.safety.connect(this.damper);
        this.damper.connect(this.master);
        this.master.connect(this.context.destination);
        // Observe the final signal without adding another audible output path.
        // The unconnected analyser output cannot change the instrument's DSP.
        if (typeof this.context.createAnalyser === 'function') {
          const analyser = this.context.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0;
          const floatSamples = typeof analyser.getFloatTimeDomainData === 'function';
          if (floatSamples || typeof analyser.getByteTimeDomainData === 'function') {
            this.outputSamples = floatSamples ? new Float32Array(analyser.fftSize)
              : new Uint8Array(analyser.fftSize);
            this.outputAnalyser = analyser;
            this.master.connect(analyser);
          }
        }
        this._createEffects();
      }
      // Starting a silent source in the gesture also unlocks older iOS WebKit.
      const silence = this.context.createBufferSource();
      silence.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      silence.connect(this.master);
      silence.onended = () => silence.disconnect();
      silence.start(0);
      return this.context.state !== 'running' ? this.context.resume() : Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Actual post-volume RMS, including effect tails. Never starts audio. */
  readOutputLevel() {
    if (!this.context || this.context.state !== 'running' || this.muted
      || this.volume <= 0 || !this.outputAnalyser || !this.outputSamples) return 0;
    const samples = this.outputSamples;
    const floatSamples = samples instanceof Float32Array;
    try {
      if (floatSamples) this.outputAnalyser.getFloatTimeDomainData(samples);
      else this.outputAnalyser.getByteTimeDomainData(samples);
    } catch (_) { return 0; /* A context can close between animation frames. */ }
    let energy = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = floatSamples ? samples[index] : (samples[index] - 128) / 128;
      energy += sample * sample;
    }
    return Number.isFinite(energy) ? Math.sqrt(energy / samples.length) : 0;
  }

  /**
   * Start immediately. A physical string (0–5) replaces only its own vibration
   * with a short release. Omitting the index preserves the legacy polyphony.
   * The shared room is allowed to decay naturally, like a real acoustic space.
   */
  pluck(frequency, velocity = 0.7, stringIndex, gate) {
    return this._pluck(frequency, velocity, false, false, 0, stringIndex, gate);
  }

  /** Dark nylon uses a woody stopped touch; bossa nylon plays its ordinary note. */
  pluckHarmonic(frequency, velocity = 0.7, stringIndex) {
    return this.preset === 'redbrown' ? this.pluck(frequency, velocity, stringIndex)
      : this._pluck(frequency, velocity, true, false, 0, stringIndex);
  }

  /** A single short dry note. Gestures should call cutStrum once instead. */
  pluckCut(frequency, velocity = 0.8) {
    return this._pluck(frequency, velocity, false, true);
  }

  /**
   * One complete cutting stroke. Frequencies must contain six actual chord
   * pitches, in the order the pick crosses the strings. Returns true only when
   * all six are scheduled; false never chokes a sounding note. The UI owns
   * per-gesture deduplication. A distinct rapid stroke replaces pending voices
   * as well as sounding ones, rather than dropping it or queuing another tail.
   */
  cutStrum(frequencies, velocity = 0.84) {
    if (!Array.isArray(frequencies) || frequencies.length !== 6
      || Array.from(frequencies).some(frequency => !Number.isFinite(frequency) || frequency < 20 || frequency > 6000)
      || !Number.isFinite(velocity) || velocity <= 0 || this.muted || this.damped) return false;
    if (!this.context || this.context.state !== 'running') this.unlock().catch(() => {});
    const context = this.context;
    if (!context || context.state === 'closed'
      || frequencies.some(frequency => frequency >= context.sampleRate * 0.45)) return false;
    // Smoothly remove the entire previous output, including the convolver and
    // compressor, before the tightly ordered dry stroke starts 24 ms later.
    this._chokeAll(CUT_CHOKE_TIME);
    const start = this.dampSafeAt;
    for (let index = 0; index < frequencies.length; index++) {
      this._pluck(frequencies[index], velocity, false, true, start + index * CUT_STRING_SPACING);
    }
    return true;
  }

  _pluck(frequency, velocity, harmonic, cut = false, scheduledStart = 0, stringIndex, gate) {
    if (stringIndex !== undefined && (!Number.isInteger(stringIndex)
      || stringIndex < 0 || stringIndex >= STRING_COUNT)) return false;
    if (!Number.isFinite(frequency) || frequency < 20 || frequency > 6000) return false;
    if (!Number.isFinite(velocity) || velocity <= 0 || this.muted || this.damped) return false;
    if (!this.context || this.context.state !== 'running') {
      // Invoke resume synchronously in this gesture, then schedule the note.
      this.unlock().catch(() => {});
    }
    const context = this.context;
    if (!context || context.state === 'closed') return false;
    const requestedFrequency = frequency;
    frequency = getPlaybackFrequency(frequency, this.preset);
    if (frequency >= context.sampleRate * 0.45) return false;
    const shortHarmonic = harmonic && this.preset === 'darkbrown';
    const dryOnly = cut || shortHarmonic;
    const timbre = this.preset === 'darkbrown' ? 'nylon' : this.preset === 'redbrown' ? 'bossa' : 'steel';
    const key = `${cut ? 'cut' : shortHarmonic ? 'nylon-touch' : harmonic ? 'harmonic' : 'normal'}:${shortHarmonic ? 'nylon' : harmonic ? 'pinch' : timbre}:${frequency.toFixed(5)}:${context.sampleRate}`;
    let buffer = this.cache.get(key);
    if (!buffer) {
      const samples = shortHarmonic ? synthesizeNylonTouch(frequency, context.sampleRate)
        : harmonic ? synthesizeHarmonic(frequency, context.sampleRate, 3)
        : synthesizeTimbre(frequency, context.sampleRate, cut ? CUT_NOTE_DURATION : 3, timbre);
      buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.getChannelData(0).set(samples);
      if (this.cache.size >= 48) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, buffer);
    }
    // Cold synthesis can consume several audio quanta. Anchor the envelope
    // after the buffer exists, rather than putting its attack in the past.
    const start = Math.max(context.currentTime, this.dampSafeAt, scheduledStart);
    // Release alone stays silent. Only a fresh note opens this post-effects
    // gate, after old voices (and the compressor's short lookahead) have ended.
    if (this.damperClosed) {
      this._ramp(this.damper.gain, 1, start, cut ? 0.003 : 0.012, true);
      this.damperClosed = false;
    }
    // Stop silences existing room energy; a new gesture can reopen its output.
    const tail = this.effectNodes.tail.gain;
    const tailStart = Math.max(context.currentTime, this.tailSafeAt);
    if (!dryOnly && tailStart > context.currentTime) {
      // A just-stopped room must drain before reopening, even on an immediate
      // new note. This prevents old notes from returning after Stop or mute.
      // Preserve the pending post-effects fade: do not cut this tail early.
      this._smooth(tail, 1, 0.018, tailStart);
    } else if (!dryOnly) this._smooth(tail, 1, 0.018);
    if (stringIndex !== undefined && this.stringVoices[stringIndex]) {
      this._release(this.stringVoices[stringIndex], STRING_RELEASE_TIME, true);
    }
    while (this.voices.length >= this.maxVoices) this._release(this.voices[0]);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const tone = context.createBiquadFilter();
    source.buffer = buffer;
    if (source.detune) {
      source.detune.value = this._bendAt(context.currentTime) * 100;
      if (context.currentTime < this.bendEnvelope.end) {
        this._ramp(source.detune, this.bend * 100, context.currentTime,
          this.bendEnvelope.end - context.currentTime);
      }
    }
    tone.type = 'lowpass';
    tone.frequency.value = shortHarmonic ? Math.min(context.sampleRate * 0.43,
      Math.max(frequency * 1.45, 1150 + clamp(velocity, 0, 1) * 550))
      : harmonic ? 6500 + clamp(velocity, 0, 1) * 8000
      : 2600 + clamp(velocity, 0, 1) * 6800;
    tone.Q.value = 0.5;
    gain.gain.value = 0;
    const level = (harmonic ? 0.38 : 0.44) * Math.pow(clamp(velocity, 0, 1), 1.15);
    if (this.preset === 'mint') {
      // A quick, resonant down-wah gives funk its articulate "chaka".
      // Close well below the attack peak instead of leaving a bright plateau.
      // Reuse this voice's filter, so every pluck has its own clean attack;
      // earlier notes keep ringing and no shared effect is retriggered.
      const touch = clamp(velocity, 0, 1);
      const minimum = frequency * (harmonic ? 5 : 2.4);
      const cutoff = hz => clamp(Math.max(minimum, hz), 20, context.sampleRate * 0.43);
      tone.Q.value = 2.05;
      tone.frequency.value = cutoff(650 + touch * 350);
      this._ramp(tone.frequency, cutoff(2600 + touch * 2200), start, 0.004);
      this._ramp(tone.frequency, cutoff(600 + touch * 600), start + 0.004, cut ? 0.055 : 0.105);
    }
    if (cut) {
      // A compact 'chatt': six strings speak together, then stop before any
      // room tail can form. The separate dry bus retains each color's EQ/drive.
      this._ramp(gain.gain, level * 1.18, start, 0.0012);
      this._ramp(gain.gain, level * 0.18, start + 0.006, 0.032, true);
      this._ramp(gain.gain, 0, start + 0.038, 0.067, true);
    } else if (shortHarmonic) {
      this._ramp(gain.gain, level, start, 0.0025);
      this._ramp(gain.gain, level * 0.24, start + 0.012, 0.073, true);
      this._ramp(gain.gain, 0, start + 0.085, 0.115, true);
    } else if (this.preset === 'mint') {
      this._ramp(gain.gain, level * 1.06, start, harmonic ? 0.001 : 0.0012);
      this._ramp(gain.gain, level * 0.72, start + 0.012, 0.097);
    } else {
      this._ramp(gain.gain, level, start, harmonic ? 0.001 : 0.002);
    }
    source.connect(tone);
    tone.connect(gain);
    gain.connect(dryOnly ? this.dryInput : this.effectInput);
    const voice = { source, gain, tone, harmonic, cut, dryOnly, stringIndex,
      frequency: requestedFrequency, playbackFrequency: frequency, start };
    this.voices.push(voice);
    if (stringIndex !== undefined) this.stringVoices[stringIndex] = voice;
    this.liveVoices.add(voice);
    source.onended = () => this._finishVoice(voice);
    source.start(start);
    // Auto phrases can clip a note using its existing gain. No new nodes,
    // timers, PCM, or shared-effect changes; manual calls omit this option.
    if (Number.isFinite(gate) && gate > 0) {
      const end = start + clamp(gate, 0.12, 2);
      this._ramp(gain.gain, 0, end, 0.02, true);
      voice.stopAt = end + 0.021;
      source.stop(voice.stopAt);
    }
    return true;
  }

  _finishVoice(voice) {
    if (voice.ended) return;
    voice.ended = true;
    this.liveVoices.delete(voice);
    const index = this.voices.indexOf(voice);
    if (index !== -1) this.voices.splice(index, 1);
    if (this.stringVoices[voice.stringIndex] === voice) this.stringVoices[voice.stringIndex] = null;
    voice.source.disconnect();
    voice.tone.disconnect();
    voice.gain.disconnect();
  }

  _release(voice, releaseTime = 0.035, replaceString = false) {
    const index = this.voices.indexOf(voice);
    if (index !== -1) this.voices.splice(index, 1);
    const now = this.context.currentTime;
    if (this.stringVoices[voice.stringIndex] === voice) this.stringVoices[voice.stringIndex] = null;
    if (replaceString && voice.start >= now) {
      // Several input crossings can arrive in one audio quantum. An unheard
      // scheduled note needs no fade and must not accumulate pending nodes.
      voice.stopAt = now;
      try { voice.source.stop(now); } catch (_) { /* already ended */ }
      this._finishVoice(voice);
      return;
    }
    if (replaceString) this._ramp(voice.gain.gain, 0, now, releaseTime, true);
    else this._smooth(voice.gain.gain, 0, 0.004);
    voice.stopAt = Math.min(voice.stopAt ?? Infinity, now + releaseTime);
    try { voice.source.stop(voice.stopAt); } catch (_) { /* already ended */ }
  }

  _bendAt(time) {
    const { from, to, start, end } = this.bendEnvelope;
    return end <= start ? to : from + (to - from) * clamp((time - start) / (end - start), 0, 1);
  }

  /** Semitones, ±4 maximum. Release with setBend(0, 80). No audio allocation. */
  setBend(semitones, transitionMs = 35) {
    if (!Number.isFinite(semitones) || !Number.isFinite(transitionMs)) return false;
    const now = this.context?.currentTime || 0;
    const duration = clamp(transitionMs, 0, 1000) / 1000;
    const from = this._bendAt(now);
    this.bend = clamp(semitones, -4, 4);
    this.bendEnvelope = { from, to: this.bend, start: now, end: now + duration };
    for (const voice of this.liveVoices) {
      if (voice.source.detune) this._ramp(voice.source.detune, this.bend * 100, now, duration);
    }
    return true;
  }

  _createEffects() {
    const context = this.context;
    const input = context.createGain();
    const highpass = context.createBiquadFilter();
    const bass = context.createBiquadFilter();
    const mids = context.createBiquadFilter();
    const treble = context.createBiquadFilter();
    const clean = context.createGain();
    const drive = context.createGain();
    const shaper = context.createWaveShaper();
    const distorted = context.createGain();
    const mix = context.createGain();
    const tone = context.createBiquadFilter();
    const output = context.createGain();
    const dry = context.createGain();
    const room = context.createConvolver();
    const wet = context.createGain();
    const tail = context.createGain();
    input.gain.value = mix.gain.value = tail.gain.value = 1;
    highpass.type = 'highpass'; highpass.Q.value = 0.5;
    bass.type = 'lowshelf'; bass.frequency.value = 180;
    mids.type = 'peaking'; mids.frequency.value = 850; mids.Q.value = 0.75;
    treble.type = 'highshelf'; treble.frequency.value = 2200;
    tone.type = 'lowpass'; tone.Q.value = 0.5;
    shaper.curve = createDistortionCurve();
    shaper.oversample = '2x';
    const impulse = createReverbImpulse(context.sampleRate);
    room.normalize = false;
    const roomBuffer = context.createBuffer(2, impulse[0].length, context.sampleRate);
    impulse.forEach((samples, channel) => roomBuffer.getChannelData(channel).set(samples));
    // Convolver acquires the buffer on assignment; populate it first.
    room.buffer = roomBuffer;

    input.connect(highpass);
    highpass.connect(bass);
    bass.connect(mids);
    mids.connect(treble);
    treble.connect(clean);
    treble.connect(drive);
    drive.connect(shaper);
    shaper.connect(distorted);
    clean.connect(mix);
    distorted.connect(mix);
    mix.connect(tone);
    tone.connect(output);
    output.connect(dry);
    output.connect(room);
    room.connect(wet);
    wet.connect(tail);
    dry.connect(this.compressor);
    tail.connect(this.compressor);
    // Both paths end at the original compressor and master, never destination.
    this.effectInput = input;
    this.effectNodes = { input, highpass, bass, mids, treble, clean, drive,
      shaper, distorted, mix, tone, output, dry, room, wet, tail };
    this._createDryEffects();
    this._applyPreset(true);
  }

  // Fixed, reusable copy of the preset tone path without a convolver send.
  // Dry techniques never alter the wet routing of an ordinary ringing note.
  _createDryEffects() {
    const context = this.context;
    const input = context.createGain();
    const highpass = context.createBiquadFilter();
    const bass = context.createBiquadFilter();
    const mids = context.createBiquadFilter();
    const treble = context.createBiquadFilter();
    const clean = context.createGain();
    const drive = context.createGain();
    const shaper = context.createWaveShaper();
    const distorted = context.createGain();
    const mix = context.createGain();
    const tone = context.createBiquadFilter();
    const output = context.createGain();
    const dry = context.createGain();
    input.gain.value = mix.gain.value = 1;
    highpass.type = 'highpass'; highpass.Q.value = 0.5;
    bass.type = 'lowshelf'; bass.frequency.value = 180;
    mids.type = 'peaking'; mids.frequency.value = 850; mids.Q.value = 0.75;
    treble.type = 'highshelf'; treble.frequency.value = 2200;
    tone.type = 'lowpass'; tone.Q.value = 0.5;
    shaper.curve = createDistortionCurve(); shaper.oversample = '2x';
    input.connect(highpass); highpass.connect(bass); bass.connect(mids);
    mids.connect(treble); treble.connect(clean); treble.connect(drive);
    drive.connect(shaper); shaper.connect(distorted);
    clean.connect(mix); distorted.connect(mix); mix.connect(tone);
    tone.connect(output); output.connect(dry); dry.connect(this.compressor);
    this.dryInput = input;
    this.dryNodes = { input, highpass, bass, mids, treble, clean, drive,
      shaper, distorted, mix, tone, output, dry };
  }

  // Track our automation explicitly. AudioParam.value is not a reliable
  // snapshot of an in-progress ramp/target on older WebKit implementations.
  _parameterState(parameter) {
    if (!this.automation.has(parameter)) this.automation.set(parameter,
      { initial: parameter.value, events: [] });
    return this.automation.get(parameter);
  }

  _parameterValue(parameter, at) {
    const state = this._parameterState(parameter);
    let value = state.initial, time = 0, target = null;
    for (const event of state.events) {
      if (event.time > at) {
        if (target) return target.value + (value - target.value) * Math.exp(-(at - time) / target.constant);
        if (event.kind === 'linear' && event.time > time)
          return value + (event.value - value) * clamp((at - time) / (event.time - time), 0, 1);
        return value;
      }
      if (target) value = target.value + (value - target.value) * Math.exp(-(event.time - time) / target.constant);
      if (event.kind === 'target') target = event;
      else { value = event.value; target = null; }
      time = event.time;
    }
    return target ? target.value + (value - target.value) * Math.exp(-(at - time) / target.constant) : value;
  }

  _hold(parameter, at) {
    const state = this._parameterState(parameter);
    const value = this._parameterValue(parameter, at);
    const next = state.events.find(event => event.time >= at);
    if (parameter.cancelAndHoldAtTime) parameter.cancelAndHoldAtTime(at);
    else {
      parameter.cancelScheduledValues(at);
      // Restore a truncated ramp's endpoint, rather than jumping to .value.
      if (next?.kind === 'linear') parameter.linearRampToValueAtTime(value, at);
    }
    parameter.setValueAtTime(value, at);
    state.events = state.events.filter(event => event.time < at);
    if (next?.kind === 'linear') state.events.push({ kind: 'linear', value, time: at });
    state.events.push({ kind: 'set', value, time: at });
    // Immediate interruption no longer needs old events. A future hold
    // preserves them so the currently audible fade remains exactly intact.
    const now = this.context.currentTime;
    const current = at <= now ? value : this._parameterValue(parameter, now);
    let last;
    for (const event of state.events) if (event.time <= now) last = event;
    const future = state.events.filter(event => event.time > now);
    state.initial = current;
    state.events = [{ kind: 'set', value: current, time: now }];
    if (at > now && last?.kind === 'target') {
      state.events.push({ ...last, time: now });
    }
    state.events.push(...future);
    return value;
  }

  _ramp(parameter, value, start, duration, eased = false) {
    const from = this._hold(parameter, start);
    const state = this._parameterState(parameter);
    const steps = eased && duration > 0 ? 32 : 1;
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      const amount = eased ? 0.5 - 0.5 * Math.cos(Math.PI * fraction) : fraction;
      const next = from + (value - from) * amount, time = start + duration * fraction;
      parameter.linearRampToValueAtTime(next, time);
      state.events.push({ kind: 'linear', value: next, time });
    }
  }

  _smooth(parameter, value, timeConstant = 0.018, start = this.context.currentTime) {
    this._hold(parameter, start);
    parameter.setTargetAtTime(value, start, timeConstant);
    this._parameterState(parameter).events.push({ kind: 'target', value, time: start, constant: timeConstant });
  }

  _applyPreset(immediate = false) {
    if (!this.effectNodes) return;
    const preset = GUITAR_PRESETS[this.preset] || {
      highpass: 20, bass: 0, mids: 0, treble: 0, cutoff: 20000, drive: 1,
      clean: this.effects.distortion ? 0 : 1,
      distorted: this.effects.distortion ? DISTORTION_LEVEL : 0,
      output: 1, dry: this.effects.reverb ? REVERB_DRY : 1,
      wet: this.effects.reverb ? REVERB_WET : 0,
    };
    for (const nodes of [this.effectNodes, this.dryNodes]) {
      if (!nodes) continue;
      const { highpass, bass, mids, treble, clean, drive, distorted, tone, output, dry, wet } = nodes;
      const targets = [
        [highpass.frequency, preset.highpass], [bass.gain, preset.bass],
        [mids.gain, preset.mids], [treble.gain, preset.treble],
        [tone.frequency, Math.min(preset.cutoff, this.context.sampleRate * 0.45)],
        [drive.gain, preset.drive], [clean.gain, preset.clean],
        [distorted.gain, preset.distorted], [output.gain, preset.output],
        [dry.gain, preset.dry],
        ...(wet ? [[wet.gain, preset.wet]] : []),
      ];
      for (const [parameter, value] of targets) {
        if (immediate) { parameter.value = value; this.automation.delete(parameter); }
        else this._smooth(parameter, value, 0.025);
      }
    }
  }

  /** Select one complete color/sound preset, without creating an AudioContext. */
  setPreset(id) {
    if (!Object.hasOwn(GUITAR_PRESETS, id)) return false;
    this.preset = id;
    const preset = GUITAR_PRESETS[id];
    this.effects = { distortion: preset.distorted > 0, reverb: preset.wet > 0 };
    this._applyPreset();
    return true;
  }

  /** Legacy independent effect controls. setPreset() restores a complete tone. */
  setEffects(effects = {}) {
    if (!effects || typeof effects !== 'object') return;
    if (typeof effects.distortion !== 'boolean' && typeof effects.reverb !== 'boolean') return;
    // Start legacy controls from a clean state, rather than inheriting a color.
    if (this.preset !== null) this.effects = { distortion: false, reverb: false };
    this.preset = null;
    if (typeof effects.distortion === 'boolean') this.effects.distortion = effects.distortion;
    if (typeof effects.reverb === 'boolean') this.effects.reverb = effects.reverb;
    this._applyPreset();
  }

  playPercussion(kind, level = .5) {
    const context = this.context, buffer = this.percussionBuffers.get(kind);
    if (!buffer || context?.state !== 'running' || this.muted || this.damped || this.volume <= 0 || !Number.isFinite(level) || level <= 0) return false;
    while (this.percussionVoices.size >= this.maxPercussionVoices) this._endPercussion(this.percussionVoices.values().next().value);
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; gain.gain.value = clamp(level, 0, 1);
    source.connect(gain); gain.connect(this.compressor); // Same final safety, mute and volume; no guitar coloration.
    const voice = { source, gain }; this.percussionVoices.add(voice);
    source.onended = () => this._endPercussion(voice, false);
    const start = Math.max(context.currentTime, this.dampSafeAt);
    if (this.damperClosed) { this._ramp(this.damper.gain, 1, start, .012, true); this.damperClosed = false; }
    source.start(start); source.stop(start + buffer.length / context.sampleRate);
    return true;
  }

  _endPercussion(voice, stop = true) {
    if (!this.percussionVoices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) { try { voice.source.stop(this.context.currentTime); } catch (_) { /* ended */ } }
    voice.source.disconnect(); voice.gain.disconnect();
  }

  stopPercussion() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const voice of this.percussionVoices) {
      if (voice.releasing) continue;
      voice.releasing = true;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + .01);
      try { voice.source.stop(now + .01); } catch (_) { this._endPercussion(voice, false); }
    }
  }

  mute(muted = true) {
    this.muted = Boolean(muted);
    if (this.master) this._smooth(this.master.gain, this.muted ? 0 : this.volume, 0.012);
    if (this.muted) this.stopAll();
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) return;
    this.volume = clamp(volume, 0, 1);
    if (this.volume === 0) this.stopPercussion();
    if (this.master && !this.muted) {
      this._smooth(this.master.gain, this.volume, 0.012);
    }
  }

  /** Hold-to-choke body touch, separate from the user's permanent mute/volume. */
  setDamped(damped = true) {
    damped = Boolean(damped);
    if (damped === this.damped) return;
    this.damped = damped;
    if (!damped) return; // Never revive old notes or room energy on release.
    this.stopAll();
  }

  stopAll() {
    this.stopPercussion();
    this._chokeAll(CHOKE_TIME);
  }

  _chokeAll(duration) {
    this.damperClosed = true;
    if (!this.context || this.context.state === 'closed') return;
    const now = this.context.currentTime;
    const fadeEnd = now + duration;
    // Fade the FULL post-effects signal first. Sources, convolution, and
    // compressor keep running untouched until the output is exactly silent.
    this._ramp(this.damper.gain, 0, now, duration, true);
    for (const voice of this.liveVoices) {
      voice.stopAt = Math.min(voice.stopAt ?? Infinity, fadeEnd + 0.001);
      try { voice.source.stop(voice.stopAt); } catch (_) { /* already ended */ }
    }
    this.voices = [];
    this.stringVoices.fill(null);
    this.dampSafeAt = fadeEnd + OUTPUT_DRAIN_TIME;
    if (this.effectNodes) {
      const tail = this.effectNodes.tail.gain;
      this._hold(tail, fadeEnd);
      tail.setValueAtTime(0, fadeEnd);
      this._parameterState(tail).events.push({ kind: 'set', value: 0, time: fadeEnd });
      this.tailSafeAt = fadeEnd
        + this.effectNodes.room.buffer.length / this.context.sampleRate + 0.05;
    }
  }
}

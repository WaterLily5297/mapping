/**
 * Audio playback with a smooth clock (HTMLAudioElement time is coarse, so we
 * interpolate with performance.now()), plus decoding for analysis/waveform.
 */
export class AudioPlayer {
  readonly el = new Audio();
  bytes: Uint8Array | null = null;
  fileName = '';
  private lastAudioT = 0;
  private lastPerf = 0;
  private ctx: AudioContext | null = null;
  /** mono samples at ANALYSIS_RATE, for waveform + auto-map */
  samples: Float32Array | null = null;
  /** left and right channels at ANALYSIS_RATE (stereo files only), for sound direction */
  stereo: [Float32Array, Float32Array] | null = null;
  /** peak envelope, one value per ENVELOPE_MS */
  envelope: Float32Array | null = null;
  static readonly ANALYSIS_RATE = 22050;
  static readonly ENVELOPE_MS = 5;
  /** when not playing, the editor owns the time */
  private pausedTime = 0;
  /** lead-in before 0 so the start of a song can be edited */
  durationMs = 0;
  onLoaded: () => void = () => {};

  constructor() {
    this.el.preload = 'auto';
    (this.el as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    this.el.addEventListener('loadedmetadata', () => {
      this.durationMs = this.el.duration * 1000;
      this.onLoaded();
    });
    this.el.addEventListener('ended', () => { this.pausedTime = this.durationMs; });
  }

  get loaded(): boolean { return !!this.bytes; }
  get playing(): boolean { return !this.el.paused; }

  async load(bytes: Uint8Array, fileName: string): Promise<void> {
    this.bytes = bytes;
    this.fileName = fileName;
    const type = fileName.toLowerCase().endsWith('.ogg') ? 'audio/ogg'
      : fileName.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    if (this.el.src) URL.revokeObjectURL(this.el.src);
    this.el.src = URL.createObjectURL(new Blob([bytes], { type }));
    this.pausedTime = 0;
    this.samples = null;
    this.stereo = null;
    this.envelope = null;
    await this.decode().catch((e) => console.warn('decode failed', e));
  }

  /** Decode to mono 22.05 kHz for analysis; also builds the waveform envelope. */
  private async decode(): Promise<void> {
    if (!this.bytes) return;
    this.ctx ??= new AudioContext();
    const buf = await this.ctx.decodeAudioData(this.bytes.slice().buffer);
    const rate = AudioPlayer.ANALYSIS_RATE;
    const ch = buf.numberOfChannels >= 2 ? 2 : 1;
    const off = new OfflineAudioContext(ch, Math.ceil(buf.duration * rate), rate);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    if (ch === 2) {
      const L = rendered.getChannelData(0).slice(), R = rendered.getChannelData(1).slice();
      const mono = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2;
      this.samples = mono;
      this.stereo = [L, R];
    } else this.samples = rendered.getChannelData(0).slice();
    const per = Math.round((rate * AudioPlayer.ENVELOPE_MS) / 1000);
    const env = new Float32Array(Math.ceil(this.samples.length / per));
    let max = 0;
    for (let i = 0; i < env.length; i++) {
      let p = 0;
      for (let j = i * per; j < Math.min(this.samples.length, (i + 1) * per); j++) p = Math.max(p, Math.abs(this.samples[j]));
      env[i] = p;
      max = Math.max(max, p);
    }
    if (max > 0) for (let i = 0; i < env.length; i++) env[i] /= max;
    this.envelope = env;
  }

  /** current time in ms (smooth while playing) */
  now(): number {
    if (!this.playing) return this.pausedTime;
    const t = this.el.currentTime * 1000;
    const p = performance.now();
    if (t !== this.lastAudioT) {
      this.lastAudioT = t;
      this.lastPerf = p;
      return t;
    }
    return t + (p - this.lastPerf) * this.el.playbackRate;
  }

  seek(ms: number): void {
    const t = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.pausedTime = t;
    if (this.loaded) this.el.currentTime = t / 1000;
    this.lastAudioT = t;
    this.lastPerf = performance.now();
  }

  async toggle(): Promise<void> {
    if (!this.loaded) return;
    if (this.playing) {
      this.pausedTime = this.now();
      this.el.pause();
    } else {
      this.el.currentTime = this.pausedTime / 1000;
      await this.el.play();
    }
  }

  pause(): void {
    if (this.playing) {
      this.pausedTime = this.now();
      this.el.pause();
    }
  }

  setRate(r: number): void { this.el.playbackRate = r; }
  setVolume(v: number): void { this.el.volume = v; }

  /** short click used as a hitsound when notes cross the judgement line */
  tick(volume = 0.3): void {
    this.ctx ??= new AudioContext();
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 1800;
    g.gain.setValueAtTime(volume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.035);
  }
}

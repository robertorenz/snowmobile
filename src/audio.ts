/** Synthesised sound: engine drone, wind, and a few one-shot effects. No audio files. */
export class AudioEngine {
  private ctx?: AudioContext;
  private master?: GainNode;
  private engineGain?: GainNode;
  private engineFilter?: BiquadFilterNode;
  private oscA?: OscillatorNode;
  private oscB?: OscillatorNode;
  private windGain?: GainNode;
  private noise?: AudioBuffer;
  muted = false;

  /** Browsers only allow audio after a user gesture, so call this from one. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    const master = (this.master = ctx.createGain());
    master.gain.value = this.muted ? 0 : 0.5;
    master.connect(ctx.destination);

    const filter = (this.engineFilter = ctx.createBiquadFilter());
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 2;
    const eg = (this.engineGain = ctx.createGain());
    eg.gain.value = 0;
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    const mixB = ctx.createGain();
    mixB.gain.value = 0.5;
    this.oscA.connect(filter);
    this.oscB.connect(mixB).connect(filter);
    filter.connect(eg).connect(master);
    this.oscA.start();
    this.oscB.start();

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 700;
    windFilter.Q.value = 0.6;
    const wg = (this.windGain = ctx.createGain());
    wg.gain.value = 0;
    wind.connect(windFilter).connect(wg).connect(master);
    wind.start();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  /** speed is 0..1+ of top speed. Pass active=false to silence the engine (menus, pause). */
  setEngine(speed: number, throttle: number, boosting: boolean, active: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.oscA || !this.oscB || !this.engineGain || !this.engineFilter || !this.windGain) return;
    const t = ctx.currentTime;
    const f = 48 + speed * 105 + throttle * 16 + (boosting ? 22 : 0);
    this.oscA.frequency.setTargetAtTime(f, t, 0.06);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(300 + speed * 900 + throttle * 500, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.1 + throttle * 0.1 : 0, t, 0.1);
    this.windGain.gain.setTargetAtTime(active ? Math.min(0.5, speed * speed * 0.3) : 0, t, 0.15);
  }

  beep(freq: number, dur = 0.15, vol = 0.25) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + dur);
  }

  thud(strength: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, 0.15 + strength * 0.05), ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    src.connect(f).connect(g).connect(this.master);
    src.start(ctx.currentTime, Math.random());
    src.stop(ctx.currentTime + 0.3);
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.28, 0.22), i * 130));
  }
}

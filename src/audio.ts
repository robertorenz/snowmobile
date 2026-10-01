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
    this.setMusic(this.musicOn);
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

  // ---------- Crowd and train ----------

  private crowdGain?: GainNode;

  /** How loud the crowd is, 0..1: main sets this from how near the start line the player is. */
  setCrowd(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (!this.crowdGain) {
      // A crowd is roughly noise in the range of voices, swelling and falling.
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1100;
      band.Q.value = 0.7;
      const swell = ctx.createGain();
      swell.gain.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.45;
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      lfo.connect(depth).connect(swell.gain);
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      src.connect(band).connect(swell).connect(this.crowdGain).connect(this.master);
      src.start();
      lfo.start();
    }
    this.crowdGain.gain.setTargetAtTime(Math.min(1, Math.max(0, level)) * 0.16, ctx.currentTime, 0.25);
  }

  /** A steam whistle: two notes a third apart, with a wobble. */
  whistle(volume: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || volume <= 0.01) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(volume * 0.22, t + 0.08);
    out.gain.setValueAtTime(volume * 0.22, t + 0.9);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 1800;
    soften.connect(out).connect(this.master);
    for (const f of [587, 740]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const wob = ctx.createOscillator();
      wob.frequency.value = 6;
      const amt = ctx.createGain();
      amt.gain.value = 5;
      wob.connect(amt).connect(o.frequency);
      o.connect(soften);
      o.start(t);
      wob.start(t);
      o.stop(t + 1.35);
      wob.stop(t + 1.35);
    }
  }

  // ---------- Music: a short looping tune, synthesised note by note ----------

  private musicGain?: GainNode;
  private musicTimer = 0;
  private musicStep = 0;
  private musicNext = 0;
  private musicOn = true;

  setMusic(on: boolean) {
    this.musicOn = on;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this.musicGain) {
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.master);
    }
    this.musicGain.gain.setTargetAtTime(on ? 0.16 : 0, ctx.currentTime, 0.3);
    if (on && !this.musicTimer) {
      this.musicNext = ctx.currentTime + 0.1;
      // Notes are scheduled a quarter of a second ahead, so timing doesn't depend on the frame rate.
      this.musicTimer = window.setInterval(() => this.scheduleMusic(), 90);
    } else if (!on && this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = 0;
    }
  }

  private scheduleMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain) return;
    // Four bars: A minor, F, C, G. Each is a root for the bass and three chord notes for the arpeggio.
    const bars = [
      [110, 220, 261.63, 329.63],
      [87.31, 174.61, 220, 261.63],
      [130.81, 261.63, 329.63, 392],
      [98, 196, 246.94, 293.66],
    ];
    const order = [1, 2, 3, 2, 1, 3, 2, 3];
    const eighth = 60 / 132 / 2;
    while (this.musicNext < ctx.currentTime + 0.25) {
      const step = this.musicStep++;
      const bar = bars[Math.floor(step / 8) % bars.length];
      const beat = step % 8;
      this.tone(bar[order[beat]] * 2, this.musicNext, eighth * 1.6, 0.22, 'triangle');
      if (beat === 0 || beat === 3 || beat === 6) this.tone(bar[0], this.musicNext, eighth * 2.6, 0.5, 'sine');
      // Every other pass, a slow line over the top.
      if (Math.floor(step / 32) % 2 === 1 && beat % 4 === 0) this.tone(bar[3] * 2, this.musicNext, eighth * 3.8, 0.13, 'sine');
      this.musicNext += eighth;
    }
  }

  private tone(freq: number, at: number, dur: number, vol: number, type: OscillatorType) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.musicGain!);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.28, 0.22), i * 130));
  }
}

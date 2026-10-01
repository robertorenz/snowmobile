import { TRACKS, DIFFICULTIES, Difficulty, TrackDef } from './tracks';
import { trackOutline } from './track';
import { SaveData, resultKey } from './storage';
import type { Standing } from './race';
import { formatTime, ordinal } from './util';

export interface UICallbacks {
  onSelectTrack(index: number): void;
  onDifficulty(d: Difficulty): void;
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onNext(): void;
  onToggleMute(): void;
}

export interface HudState {
  place: number;
  total: number;
  lapLabel: string;
  lapValue: string;
  time: number;
  speedKmh: number;
  boost: number;
  boosting: boolean;
  banner: string;
  bannerTone: 'count' | 'go' | 'warn' | 'info' | '';
  hint: string;
  racers: { x: number; z: number; color: string; isPlayer: boolean }[];
}

export interface ResultsData {
  track: TrackDef;
  difficulty: Difficulty;
  standings: Standing[];
  playerPlace: number;
  playerTime: number;
  newBest: boolean;
  unlockedName: string | null;
  hasNext: boolean;
}

const el = <T extends HTMLElement = HTMLElement>(html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Fits a track outline into a square canvas. Returns the world→canvas mapping. */
function fitOutline(outline: [number, number][], size: number, pad: number) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of outline) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const scale = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
  const ox = (size - (maxX - minX) * scale) / 2;
  const oz = (size - (maxZ - minZ) * scale) / 2;
  return (x: number, z: number): [number, number] => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
}

function drawOutline(canvas: HTMLCanvasElement, def: TrackDef, stroke: string, width: number, pad: number) {
  const outline = trackOutline(def);
  const size = canvas.width;
  const map = fitOutline(outline, size, pad);
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const path = () => {
    g.beginPath();
    outline.forEach(([x, z], i) => {
      const [cx, cy] = map(x, z);
      if (i === 0) g.moveTo(cx, cy);
      else g.lineTo(cx, cy);
    });
  };
  path();
  g.strokeStyle = 'rgba(4, 12, 20, 0.75)';
  g.lineWidth = width + 3;
  g.stroke();
  path();
  g.strokeStyle = stroke;
  g.lineWidth = width;
  g.stroke();
  // Start marker
  const [sx, sy] = map(outline[0][0], outline[0][1]);
  g.fillStyle = '#f6a821';
  g.beginPath();
  g.arc(sx, sy, width * 1.1, 0, Math.PI * 2);
  g.fill();
  return map;
}

export class UI {
  private menu: HTMLElement;
  private hud: HTMLElement;
  private modalLayer: HTMLElement;
  private loading: HTMLElement;
  private mapBase = document.createElement('canvas');
  private mapCanvas!: HTMLCanvasElement;
  private mapXform: ((x: number, z: number) => [number, number]) | null = null;
  private refs: Record<string, HTMLElement> = {};
  private selected = 0;

  constructor(
    private root: HTMLElement,
    private save: SaveData,
    private cb: UICallbacks,
  ) {
    this.menu = el(`<div class="menu"></div>`);
    this.hud = el(`<div class="hud hidden"></div>`);
    this.modalLayer = el(`<div class="modal-layer"></div>`);
    this.loading = el(`<div class="loading hidden"><div class="spinner"></div><span>Grooming the track…</span></div>`);
    root.append(this.menu, this.hud, this.loading, this.modalLayer);
    this.buildHud();
    this.selected = Math.min(save.lastTrack, save.unlocked - 1);
    this.renderMenu();
  }

  // ---------- Menu ----------

  renderMenu() {
    const save = this.save;
    const diffButtons = (Object.keys(DIFFICULTIES) as Difficulty[])
      .map(
        (d) =>
          `<button class="seg ${d === save.difficulty ? 'active' : ''}" data-diff="${d}">${DIFFICULTIES[d].label}</button>`,
      )
      .join('');

    const cards = TRACKS.map((t, i) => {
      const locked = i >= save.unlocked;
      const res = save.results[resultKey(t.id, save.difficulty)];
      const meta = locked
        ? `Finish top 3 on ${TRACKS[i - 1].name} to unlock`
        : res
          ? `Best: ${ordinal(res.bestPlace)} · ${formatTime(res.bestTime)}`
          : t.closed
            ? `${t.laps} laps · circuit`
            : 'Point-to-point descent';
      return `
        <button class="track-card ${i === this.selected ? 'selected' : ''} ${locked ? 'locked' : ''}" data-track="${i}" ${locked ? 'disabled' : ''}>
          <canvas width="112" height="112"></canvas>
          <span class="track-text">
            <span class="track-level">Level ${i + 1}${res && res.bestPlace <= 3 ? `<span class="medal m${res.bestPlace}">${ordinal(res.bestPlace)}</span>` : ''}</span>
            <span class="track-name">${t.name}</span>
            <span class="track-meta">${meta}</span>
          </span>
          ${locked ? '<span class="lock" aria-label="Locked"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4V7Z"/></svg></span>' : ''}
        </button>`;
    }).join('');

    const sel = TRACKS[this.selected];
    this.menu.innerHTML = `
      <div class="menu-panel">
        <header class="brand">
          <div class="brand-mark">POWDER<span>RUSH</span></div>
          <div class="brand-sub">Snowmobile Racing</div>
        </header>
        <div class="section-label">Track</div>
        <div class="track-list">${cards}</div>
        <div class="section-label">Difficulty</div>
        <div class="segmented">${diffButtons}</div>
        <p class="diff-blurb">${DIFFICULTIES[save.difficulty].blurb}</p>
        <button class="btn primary big" data-act="start">Race ${sel.name}</button>
        <div class="menu-foot">
          <button class="btn ghost" data-act="help">How to play</button>
          <button class="btn ghost" data-act="mute">${save.muted ? 'Sound: Off' : 'Sound: On'}</button>
        </div>
      </div>
      <div class="menu-blurb">
        <div class="blurb-title">${sel.name}</div>
        <div class="blurb-text">${sel.blurb}</div>
      </div>`;

    this.menu.querySelectorAll<HTMLCanvasElement>('.track-card canvas').forEach((c, i) => {
      drawOutline(c, TRACKS[i], i >= save.unlocked ? '#5d7387' : '#e9f3fa', 5, 14);
    });
    this.menu.querySelectorAll<HTMLButtonElement>('[data-track]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.track);
        if (i === this.selected) return;
        this.selected = i;
        this.renderMenu();
        this.cb.onSelectTrack(i);
      }),
    );
    this.menu.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((b) =>
      b.addEventListener('click', () => {
        this.cb.onDifficulty(b.dataset.diff as Difficulty);
        this.renderMenu();
      }),
    );
    this.menu.querySelector('[data-act="start"]')!.addEventListener('click', () => this.cb.onStart());
    this.menu.querySelector('[data-act="help"]')!.addEventListener('click', () => this.showHelp());
    this.menu.querySelector('[data-act="mute"]')!.addEventListener('click', () => {
      this.cb.onToggleMute();
      this.renderMenu();
    });
  }

  get selectedTrack() {
    return this.selected;
  }

  selectTrack(i: number) {
    this.selected = i;
  }

  showMenu(show: boolean) {
    if (show) this.renderMenu();
    this.menu.classList.toggle('hidden', !show);
  }

  showLoading(show: boolean) {
    this.loading.classList.toggle('hidden', !show);
  }

  // ---------- HUD ----------

  private buildHud() {
    this.hud.innerHTML = `
      <div class="hud-tl">
        <div class="place"><span data-ref="place">1st</span><small data-ref="total">/ 6</small></div>
        <div class="lap"><span data-ref="lapLabel">LAP</span><b data-ref="lapValue">1/3</b></div>
      </div>
      <div class="hud-tc"><div class="timer" data-ref="time">0:00.00</div></div>
      <div class="hud-tr"><canvas class="minimap" width="360" height="360"></canvas></div>
      <div class="hud-br">
        <div class="speed"><span data-ref="speed">0</span><small>km/h</small></div>
        <div class="boost"><div class="boost-label">BOOST</div><div class="boost-bar"><div class="boost-fill" data-ref="boost"></div></div></div>
      </div>
      <div class="hud-center"><div class="banner" data-ref="banner"></div></div>
      <div class="hud-hint" data-ref="hint"></div>`;
    this.hud.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (this.refs[n.dataset.ref!] = n));
    this.mapCanvas = this.hud.querySelector('.minimap')!;
  }

  showHud(show: boolean, def?: TrackDef) {
    this.hud.classList.toggle('hidden', !show);
    if (show && def) {
      this.mapBase.width = this.mapBase.height = this.mapCanvas.width;
      this.mapXform = drawOutline(this.mapBase, def, 'rgba(233, 243, 250, 0.92)', 9, 30);
    }
  }

  updateHud(s: HudState) {
    const r = this.refs;
    r.place.textContent = ordinal(s.place);
    r.total.textContent = `/ ${s.total}`;
    r.lapLabel.textContent = s.lapLabel;
    r.lapValue.textContent = s.lapValue;
    r.time.textContent = formatTime(s.time);
    r.speed.textContent = String(Math.round(s.speedKmh));
    r.boost.style.width = `${Math.round(s.boost * 100)}%`;
    r.boost.classList.toggle('active', s.boosting);
    if (r.banner.textContent !== s.banner) r.banner.textContent = s.banner;
    r.banner.className = `banner ${s.bannerTone}`;
    if (r.hint.textContent !== s.hint) r.hint.textContent = s.hint;

    const g = this.mapCanvas.getContext('2d')!;
    const size = this.mapCanvas.width;
    g.clearRect(0, 0, size, size);
    g.drawImage(this.mapBase, 0, 0);
    if (!this.mapXform) return;
    // Player last so their dot sits on top.
    for (const racer of [...s.racers].sort((a, b) => Number(a.isPlayer) - Number(b.isPlayer))) {
      const [x, y] = this.mapXform(racer.x, racer.z);
      g.beginPath();
      g.arc(x, y, racer.isPlayer ? 11 : 7.5, 0, Math.PI * 2);
      g.fillStyle = racer.color;
      g.fill();
      g.lineWidth = racer.isPlayer ? 4 : 2.5;
      g.strokeStyle = racer.isPlayer ? '#ffffff' : 'rgba(4,12,20,0.85)';
      g.stroke();
    }
  }

  // ---------- Modals ----------

  get modalOpen() {
    return this.modalLayer.childElementCount > 0;
  }

  closeModal() {
    this.modalLayer.innerHTML = '';
  }

  private openModal(content: string, wide = false) {
    this.modalLayer.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${content}</div></div>`;
    const first = this.modalLayer.querySelector<HTMLButtonElement>('button');
    first?.focus();
    return this.modalLayer.firstElementChild as HTMLElement;
  }

  private bind(modal: HTMLElement, actions: Record<string, () => void>) {
    modal.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => actions[b.dataset.act!]?.()),
    );
  }

  showPause() {
    const m = this.openModal(`
      <h2>Paused</h2>
      <div class="modal-actions column">
        <button class="btn primary" data-act="resume">Resume</button>
        <button class="btn" data-act="restart">Restart race</button>
        <button class="btn" data-act="help">Controls</button>
        <button class="btn ghost" data-act="quit">Quit to menu</button>
      </div>`);
    this.bind(m, {
      resume: () => this.cb.onResume(),
      restart: () => this.cb.onRestart(),
      quit: () => this.cb.onQuit(),
      help: () => this.showHelp(() => this.showPause()),
    });
  }

  showHelp(onClose?: () => void) {
    const m = this.openModal(
      `
      <h2>How to play</h2>
      <p class="modal-lead">Beat the other five riders to the finish. A top-3 finish unlocks the next level.</p>
      <table class="keys">
        <tr><td><kbd>W</kbd> / <kbd>↑</kbd></td><td>Throttle</td></tr>
        <tr><td><kbd>S</kbd> / <kbd>↓</kbd></td><td>Brake, then reverse</td></tr>
        <tr><td><kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd></td><td>Steer</td></tr>
        <tr><td><kbd>Shift</kbd> / <kbd>Space</kbd></td><td>Boost — recharges slowly, faster in the air</td></tr>
        <tr><td><kbd>R</kbd></td><td>Reset onto the track</td></tr>
        <tr><td><kbd>Esc</kbd> / <kbd>P</kbd></td><td>Pause</td></tr>
        <tr><td><kbd>M</kbd></td><td>Mute</td></tr>
      </table>
      <p class="modal-note">Stay between the blue (left) and red (right) lines — deep powder off the groomed track slows you down. Brake before tight corners. A gamepad works too: stick to steer, triggers for throttle and brake, A to boost.</p>
      <div class="modal-actions"><button class="btn primary" data-act="close">Got it</button></div>`,
      true,
    );
    this.bind(m, {
      close: () => {
        this.closeModal();
        onClose?.();
      },
    });
  }

  showResults(d: ResultsData) {
    const headline = d.playerPlace === 1 ? 'Victory!' : d.playerPlace <= 3 ? 'Podium finish' : 'Race complete';
    const rows = d.standings
      .map(
        (s) => `
        <tr class="${s.sled.isPlayer ? 'me' : ''}">
          <td class="pos">${s.place}</td>
          <td><span class="swatch" style="background:${hex(s.sled.color)}"></span>${s.sled.name}</td>
          <td class="time">${formatTime(s.time)}${s.estimated ? '<span class="est">est.</span>' : ''}</td>
        </tr>`,
      )
      .join('');
    const notes: string[] = [];
    if (d.newBest) notes.push(`<div class="note good">New personal best on ${DIFFICULTIES[d.difficulty].label}</div>`);
    if (d.unlockedName) notes.push(`<div class="note good">Level unlocked: ${d.unlockedName}</div>`);
    else if (d.playerPlace > 3) notes.push(`<div class="note">Finish in the top 3 to unlock the next level.</div>`);

    const m = this.openModal(
      `
      <div class="result-head p${Math.min(d.playerPlace, 4)}">
        <div class="result-place">${ordinal(d.playerPlace)}</div>
        <div>
          <h2>${headline}</h2>
          <div class="result-sub">${d.track.name} · ${DIFFICULTIES[d.difficulty].label} · ${formatTime(d.playerTime)}</div>
        </div>
      </div>
      ${notes.join('')}
      <table class="standings">${rows}</table>
      <div class="modal-actions">
        ${d.hasNext ? '<button class="btn primary" data-act="next">Next track</button>' : ''}
        <button class="btn ${d.hasNext ? '' : 'primary'}" data-act="restart">Race again</button>
        <button class="btn ghost" data-act="quit">Menu</button>
      </div>`,
      true,
    );
    this.bind(m, {
      next: () => this.cb.onNext(),
      restart: () => this.cb.onRestart(),
      quit: () => this.cb.onQuit(),
    });
  }

  showError(message: string) {
    const m = this.openModal(`
      <h2>Something went wrong</h2>
      <p class="modal-lead">${message}</p>
      <div class="modal-actions"><button class="btn primary" data-act="close">Close</button></div>`);
    this.bind(m, { close: () => this.closeModal() });
  }
}

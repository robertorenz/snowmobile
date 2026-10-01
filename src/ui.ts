import { TRACKS, CUPS, MEDAL_FACTORS, DIFFICULTIES, Difficulty, TrackDef } from './tracks';
import { trackOutline } from './track';
import { SaveData, GameMode, resultKey } from './storage';
import type { Standing } from './race';
import { formatTime, ordinal } from './util';
import { SLEDS, sledById } from './sleds';

export interface UICallbacks {
  onSelectTrack(index: number): void;
  onDifficulty(d: Difficulty): void;
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onNext(): void;
  onToggleMute(): void;
  onMode(mode: GameMode): void;
  onCup(index: number): void;
  onSled(id: string): void;
  /** Picture of a snowmobile model, as an image URL. */
  sledThumb(id: string): string;
  /** A switch in the settings dialog was flipped. */
  onSetting(key: SettingKey, on: boolean): void;
  /** Create or join an online room. Rejects with a message to show the player. */
  onOnline(action: 'host' | 'join', name: string, code: string): Promise<void>;
  onLeaveRoom(): void;
}

export type SettingKey = 'ice' | 'stone' | 'grass' | 'mirror' | 'sound';

/** The online room this player is in, as shown on the menu. */
export interface RoomView {
  code: string;
  isHost: boolean;
  racing: boolean;
  track: number;
  difficulty: Difficulty;
  players: { name: string; me: boolean; host: boolean }[];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface HudState {
  place: number;
  total: number;
  lapLabel: string;
  lapValue: string;
  time: number;
  speedKmh: number;
  boost: number;
  boosting: boolean;
  /** Short notices shown above the speed: item held, shield up, in a slipstream. */
  status: string[];
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
  online: boolean;
  /** Time trial: medal earned (0 gold, 1 silver, 2 bronze, -1 none), the three target times, and the best time on record. */
  trial?: { medal: number; targets: number[]; best: number; improved: boolean };
  /** Championship: where this race falls in the cup and the points table; final is the finishing position once the cup is over. */
  champ?: { cup: string; race: number; races: number; table: { name: string; points: number; me: boolean }[]; final: number };
  eliminated?: boolean;
}

const standingRows = (standings: Standing[]) =>
  standings
    .map(
      (s) => `
        <tr class="${s.sled.isPlayer ? 'me' : ''}">
          <td class="pos">${s.place}</td>
          <td><span class="swatch" style="background:${hex(s.sled.color)}"></span>${escapeHtml(s.sled.name)}</td>
          <td class="time">${s.out ? 'Out' : formatTime(s.time)}${s.estimated ? '<span class="est">est.</span>' : ''}</td>
        </tr>`,
    )
    .join('');

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
  private room: RoomView | null = null;

  /** Shows (or clears) the online room on the menu. */
  setRoom(room: RoomView | null) {
    this.room = room;
    if (room) this.selected = room.track;
    else this.selected = Math.min(this.selected, this.save.unlocked - 1);
    this.renderMenu();
  }

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
    const room = this.room;
    // Guests see the host's choices but can't change them.
    const guest = !!room && !room.isHost;
    const difficulty = room ? room.difficulty : save.difficulty;
    const diffButtons = (Object.keys(DIFFICULTIES) as Difficulty[])
      .map(
        (d) =>
          `<button class="seg ${d === difficulty ? 'active' : ''}" data-diff="${d}" ${guest ? 'disabled' : ''}>${DIFFICULTIES[d].label}</button>`,
      )
      .join('');

    const mode: GameMode = room ? 'race' : save.mode;
    const cards = TRACKS.map((t, i) => {
      // Every track is open in an online room.
      const locked = !room && i >= save.unlocked;
      const res = save.results[resultKey(t.id, save.difficulty)];
      const trial = mode === 'trial' ? save.trials[t.id] : undefined;
      const meta = locked
        ? `Top 3 on ${TRACKS[i - 1].name}`
        : mode === 'trial'
          ? trial !== undefined ? `Best ${formatTime(trial)}` : `Gold: ${formatTime((t.par ?? 120) * MEDAL_FACTORS[0])}`
        : res
          ? `Best: ${ordinal(res.bestPlace)} · ${formatTime(res.bestTime)}`
          : t.closed
            ? `${t.laps} laps · circuit`
            : 'Point-to-point descent';
      return `
        <button class="track-card ${i === this.selected ? 'selected' : ''} ${locked ? 'locked' : ''}" data-track="${i}" ${locked || (guest && i !== this.selected) ? 'disabled' : ''}>
          <canvas width="88" height="88"></canvas>
          <span class="track-text">
            <span class="track-level">${i + 1}${res && res.bestPlace <= 3 ? `<span class="medal m${res.bestPlace}">${ordinal(res.bestPlace)}</span>` : ''}</span>
            <span class="track-name">${t.name}</span>
            <span class="track-meta">${meta}</span>
          </span>
          ${locked ? '<span class="lock" aria-label="Locked"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4V7Z"/></svg></span>' : ''}
        </button>`;
    }).join('');

    const sel = TRACKS[this.selected];
    const sled = sledById(save.sled);
    const roomBox = room
      ? `
        <div class="room">
          <div class="room-head">
            <div><div class="room-label">Online room</div><div class="room-code">${room.code}</div></div>
            <div class="room-actions">
              <button class="btn small" data-act="copy">Copy invite link</button>
              <button class="btn small ghost" data-act="leave">Leave</button>
            </div>
          </div>
          <div class="room-players">${room.players
            .map(
              (p) =>
                `<span class="chip ${p.me ? 'me' : ''}">${escapeHtml(p.name)}${p.host ? '<small>host</small>' : ''}</span>`,
            )
            .join('')}</div>
          <div class="room-note">${
            room.racing
              ? 'A race is under way. You will join the next one.'
              : room.isHost
                ? 'Share the code or link. Empty seats are filled with AI riders.'
                : 'Waiting for the host to start the race.'
          }</div>
        </div>`
      : '';
    const cup = CUPS[save.cup] ?? CUPS[0];
    const startLabel = mode === 'trial' ? `Time trial: ${sel.name}` : mode === 'elimination' ? `Knockout: ${sel.name}` : mode === 'championship' ? `Start the ${cup.name}` : `Race ${sel.name}`;
    const modes: [GameMode, string][] = [['race', 'Race'], ['trial', 'Time trial'], ['elimination', 'Knockout'], ['championship', 'Cup']];
    const modeBar = room ? '' : `<div class="segmented four">${modes.map(([id, label]) => `<button class="seg ${id === mode ? 'active' : ''}" data-mode="${id}">${label}</button>`).join('')}</div>`;
    // A cup needs every one of its tracks unlocked.
    const cupCards = CUPS.map((c, i) => {
      const locked = Math.max(...c.tracks) >= save.unlocked;
      const best = save.cups[c.id];
      return `
        <button class="track-card cup ${i === save.cup ? 'selected' : ''} ${locked ? 'locked' : ''}" data-cup="${i}" ${locked ? 'disabled' : ''}>
          <span class="track-text">
            <span class="track-name">${c.name}${best ? `<span class="medal m${Math.min(best, 3)}">${ordinal(best)}</span>` : ''}</span>
            <span class="track-meta">${locked ? 'Unlock all four tracks first' : c.tracks.map((k) => TRACKS[k].name).join(' · ')}</span>
          </span>
        </button>`;
    }).join('');
    const startButton = !room
      ? `<button class="btn primary big" data-act="start">${startLabel}</button>
         <button class="btn wide" data-act="online">Play online with friends</button>`
      : room.isHost
        ? `<button class="btn primary big" data-act="start">Start online race</button>`
        : `<button class="btn primary big" disabled>Waiting for host…</button>`;
    this.menu.innerHTML = `
      <div class="menu-panel">
        <header class="brand">
          <div class="brand-mark">POWDER<span>RUSH</span></div>
          <div class="brand-sub">Snowmobile Racing</div>
        </header>
        ${roomBox}
        <div class="menu-actions">
          ${startButton}
        </div>
        <div class="section-label">Snowmobile</div>
        <button class="sled-row" data-act="sled">
          <img src="${this.cb.sledThumb(sled.id)}" alt="" />
          <span class="sled-text"><b>${sled.name}</b><small>${sled.blurb}</small></span>
          <span class="sled-change">Change</span>
        </button>
        <div class="section-label">${room ? 'AI difficulty' : 'Difficulty'}</div>
        <div class="segmented">${diffButtons}</div>
        <p class="diff-blurb">${DIFFICULTIES[difficulty].blurb}</p>
        ${modeBar ? `<div class="section-label">Mode</div>${modeBar}` : ''}
        <div class="section-label">${mode === 'championship' ? 'Cup' : 'Track'}</div>
        <div class="track-list ${mode === 'championship' ? 'cups' : ''}">${mode === 'championship' ? cupCards : cards}</div>
        <div class="menu-foot">
          <button class="btn ghost" data-act="help">How to play</button>
          <button class="btn ghost" data-act="settings">Settings</button>
        </div>
      </div>
      <div class="menu-blurb">
        <div class="blurb-title">${sel.name}</div>
        <div class="blurb-text">${sel.blurb}</div>
      </div>`;

    this.menu.querySelectorAll<HTMLCanvasElement>('.track-card canvas').forEach((c, i) => {
      drawOutline(c, TRACKS[i], !room && i >= save.unlocked ? '#5d7387' : '#e9f3fa', 4.5, 11);
    });
    this.menu.querySelector('[data-act="online"]')?.addEventListener('click', () => this.showOnline());
    this.menu.querySelector('[data-act="sled"]')?.addEventListener('click', () => this.showSleds());
    this.menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.save.mode = b.dataset.mode as GameMode;
        this.cb.onMode(this.save.mode);
        this.renderMenu();
      }),
    );
    this.menu.querySelectorAll<HTMLButtonElement>('[data-cup]').forEach((b) =>
      b.addEventListener('click', () => {
        this.save.cup = Number(b.dataset.cup);
        this.cb.onCup(this.save.cup);
        this.renderMenu();
      }),
    );
    this.menu.querySelector('[data-act="leave"]')?.addEventListener('click', () => this.cb.onLeaveRoom());
    const copy = this.menu.querySelector<HTMLButtonElement>('[data-act="copy"]');
    copy?.addEventListener('click', () => {
      const link = `${location.origin}${location.pathname}?room=${room!.code}`;
      navigator.clipboard?.writeText(link).then(
        () => (copy.textContent = 'Link copied'),
        () => (copy.textContent = link),
      );
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
    this.menu.querySelector('[data-act="start"]')?.addEventListener('click', () => this.cb.onStart());
    this.menu.querySelector('[data-act="help"]')!.addEventListener('click', () => this.showHelp());
    this.menu.querySelector('[data-act="settings"]')!.addEventListener('click', () => this.showSettings());
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
      <div class="mirror hidden" data-ref="mirror"></div>
      <div class="hud-tc" data-ref="tc"><div class="timer" data-ref="time">0:00.00</div></div>
      <div class="hud-tr"><canvas class="minimap" width="360" height="360"></canvas></div>
      <div class="hud-br">
        <div class="status" data-ref="status"></div>
        <div class="speed"><span data-ref="speed">0</span><small>km/h</small></div>
        <div class="boost"><div class="boost-label">BOOST</div><div class="boost-bar"><div class="boost-fill" data-ref="boost"></div></div></div>
      </div>
      <div class="hud-center"><div class="banner" data-ref="banner"></div></div>
      <div class="hud-hint" data-ref="hint"></div>`;
    this.hud.querySelectorAll<HTMLElement>('[data-ref]').forEach((n) => (this.refs[n.dataset.ref!] = n));
    this.mapCanvas = this.hud.querySelector('.minimap')!;
  }

  /** Sizes the mirror's frame to match the strip the renderer draws (HUD pixels), and tucks the timer under it. */
  placeMirror(width: number, height: number, top: number) {
    const m = this.refs.mirror;
    m.style.width = width + 'px';
    m.style.height = height + 'px';
    m.style.top = top + 'px';
    m.style.left = `calc(50% - ${width / 2}px)`;
    this.mirrorBottom = top + height + 6;
  }

  private mirrorBottom = 0;

  showMirror(show: boolean) {
    const m = this.refs.mirror;
    if (m.classList.contains('hidden') !== show) return;
    m.classList.toggle('hidden', !show);
    this.refs.tc.style.top = show ? this.mirrorBottom + 'px' : '';
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
    const status = s.status.join('|');
    if (r.status.dataset.v !== status) {
      r.status.dataset.v = status;
      r.status.innerHTML = s.status.map((t) => `<span>${t}</span>`).join('');
    }
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

  showPause(online = false) {
    // An online race can't be paused; the menu just overlays it.
    const m = this.openModal(`
      <h2>${online ? 'Race menu' : 'Paused'}</h2>
      ${online ? '<p class="modal-lead">The race keeps running for everyone.</p>' : ''}
      <div class="modal-actions column">
        <button class="btn primary" data-act="resume">${online ? 'Back to race' : 'Resume'}</button>
        ${online ? '' : '<button class="btn" data-act="restart">Restart race</button>'}
        <button class="btn" data-act="help">Controls</button>
        <button class="btn ghost" data-act="quit">${online ? 'Leave race' : 'Quit to menu'}</button>
      </div>`);
    this.bind(m, {
      resume: () => this.cb.onResume(),
      restart: () => this.cb.onRestart(),
      quit: () => this.cb.onQuit(),
      help: () => this.showHelp(() => this.showPause(online)),
    });
  }

  /** The snowmobile picker: one card per model, with its picture and how it drives. */
  showSleds() {
    // Bars run from half the standard figure (empty) to one and a half times it (full).
    const bar = (label: string, v: number) =>
      `<div class="stat"><span>${label}</span><div class="stat-bar"><div style="width:${Math.round(Math.max(0.06, Math.min(1, v - 0.5)) * 100)}%"></div></div></div>`;
    const cards = SLEDS.map(
      (s) => `
      <button class="sled-card ${s.id === this.save.sled ? 'selected' : ''}" data-sled="${s.id}">
        <img src="${this.cb.sledThumb(s.id)}" alt="" />
        <span class="sled-name">${s.name}</span>
        <span class="sled-blurb">${s.blurb}</span>
        ${bar('Top speed', s.speed)}${bar('Acceleration', s.accel)}${bar('Steering', s.turn)}${bar('Grip', s.grip)}
      </button>`,
    ).join('');
    const m = this.openModal(
      `
      <h2>Choose your snowmobile</h2>
      <p class="modal-lead">Each drives differently. Low grip means it slides; the Mammoth also shrugs off deep snow, rock and grass.</p>
      <div class="sled-grid">${cards}</div>
      <div class="modal-actions"><button class="btn ghost" data-act="close">Close</button></div>`,
      true,
    );
    m.querySelector('.modal')!.classList.add('xwide');
    m.querySelectorAll<HTMLButtonElement>('[data-sled]').forEach((b) =>
      b.addEventListener('click', () => {
        this.save.sled = b.dataset.sled!;
        this.cb.onSled(b.dataset.sled!);
        this.closeModal();
        this.renderMenu();
      }),
    );
    this.bind(m, { close: () => this.closeModal() });
  }

  showSettings() {
    const save = this.save;
    const rows: [SettingKey, string, string, boolean][] = [
      ['ice', 'Ice patches', 'Slippery sheets of ice on the road', save.surfaces.ice],
      ['stone', 'Rock and shale patches', 'Bare rock and gravel that slow the sled', save.surfaces.stone],
      ['grass', 'Grass patches', 'Grass showing through the snow', save.surfaces.grass],
      ['mirror', 'Rear-view mirror', 'Shown at the top of the screen while racing (V)', save.mirror],
      ['sound', 'Sound', 'Engine, wind and effects (M)', !save.muted],
    ];
    const m = this.openModal(
      `
      <h2>Settings</h2>
      <p class="modal-lead">Road surface changes apply from the next race. In an online room the host's road settings are used for everyone.</p>
      <div class="settings">
        ${rows
          .map(
            ([key, label, note, on]) => `
          <div class="setting">
            <div><div class="setting-name">${label}</div><div class="setting-note">${note}</div></div>
            <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" data-key="${key}"><span></span></button>
          </div>`,
          )
          .join('')}
      </div>
      <div class="modal-actions"><button class="btn primary" data-act="close">Done</button></div>`,
      true,
    );
    m.querySelectorAll<HTMLButtonElement>('.switch').forEach((b) =>
      b.addEventListener('click', () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        this.cb.onSetting(b.dataset.key as SettingKey, on);
      }),
    );
    this.bind(m, { close: () => this.closeModal() });
  }

  /** Create-or-join dialog for online play. */
  showOnline(prefillCode = '') {
    const m = this.openModal(
      `
      <h2>Play online</h2>
      <p class="modal-lead">Race friends on their own computers. One of you creates a room and shares its code.</p>
      <label class="field"><span>Your name</span>
        <input type="text" data-in="name" maxlength="14" autocomplete="off" value="${escapeHtml(this.save.playerName)}" placeholder="Rider" /></label>
      <button class="btn primary wide" data-act="host">Create a room</button>
      <div class="or"><span>or join one</span></div>
      <div class="join-row">
        <input type="text" data-in="code" maxlength="4" autocomplete="off" spellcheck="false" placeholder="CODE" value="${escapeHtml(prefillCode)}" />
        <button class="btn" data-act="join">Join room</button>
      </div>
      <div class="status" data-ref="status" role="status"></div>
      <div class="modal-actions"><button class="btn ghost" data-act="close">Cancel</button></div>`,
      true,
    );
    const name = m.querySelector<HTMLInputElement>('[data-in="name"]')!;
    const code = m.querySelector<HTMLInputElement>('[data-in="code"]')!;
    const status = m.querySelector<HTMLElement>('[data-ref="status"]')!;
    const buttons = m.querySelectorAll<HTMLButtonElement>('button');
    (prefillCode && name.value ? m.querySelector<HTMLButtonElement>('[data-act="join"]')! : name).focus();
    code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, '')));

    const go = async (action: 'host' | 'join') => {
      if (action === 'join' && code.value.length < 4) {
        status.textContent = 'Enter the 4-letter room code.';
        status.className = 'status error';
        return;
      }
      buttons.forEach((b) => (b.disabled = true));
      status.textContent = action === 'host' ? 'Creating room…' : 'Connecting…';
      status.className = 'status';
      try {
        await this.cb.onOnline(action, name.value, code.value);
        this.closeModal();
      } catch (err) {
        // The dialog may have been replaced while we were connecting.
        if (!status.isConnected) return;
        status.textContent = err instanceof Error ? err.message : 'Connection failed.';
        status.className = 'status error';
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    code.addEventListener('keydown', (e) => e.key === 'Enter' && void go('join'));
    this.bind(m, { host: () => void go('host'), join: () => void go('join'), close: () => this.closeModal() });
  }

  /** Replaces the classification in an open results dialog (online races update as riders finish). */
  refreshStandings(standings: Standing[]) {
    const table = this.modalLayer.querySelector('.standings');
    if (table) table.innerHTML = standingRows(standings);
  }

  showNotice(title: string, message: string) {
    const m = this.openModal(`
      <h2>${escapeHtml(title)}</h2>
      <p class="modal-lead">${escapeHtml(message)}</p>
      <div class="modal-actions"><button class="btn primary" data-act="close">OK</button></div>`);
    this.bind(m, { close: () => this.closeModal() });
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
        <tr><td><kbd>F</kbd></td><td>Flip while in the air — land it for boost, land mid-flip and you wipe out</td></tr>
        <tr><td><kbd>E</kbd> / <kbd>Ctrl</kbd></td><td>Throw a snowball, if you are carrying one</td></tr>
        <tr><td><kbd>C</kbd></td><td>Switch between chase camera and rider's view</td></tr>
        <tr><td><kbd>R</kbd></td><td>Reset onto the track</td></tr>
        <tr><td><kbd>Esc</kbd> / <kbd>P</kbd></td><td>Pause</td></tr>
        <tr><td><kbd>V</kbd></td><td>Rear-view mirror on / off</td></tr>
        <tr><td><kbd>M</kbd></td><td>Mute</td></tr>
      </table>
      <p class="modal-note">Stay between the blue (left) and red (right) lines — deep powder off the groomed track slows you down. Brake before tight corners. Ride through the floating pickups: amber canisters refill boost, blue crystals are a shield against one hit, white balls are snowballs to throw. Tuck in close behind another sled for a slipstream. A gamepad works too: stick to steer, triggers for throttle and brake, A to boost, X to flip, B to throw.</p>
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
    const diff = DIFFICULTIES[d.difficulty].label;
    const notes: string[] = [];
    let badge = ordinal(d.playerPlace);
    let tone = `p${Math.min(d.playerPlace, 4)}`;
    let headline = d.playerPlace === 1 ? 'Victory!' : d.playerPlace <= 3 ? 'Podium finish' : 'Race complete';
    let sub = `${d.track.name} · ${diff} · ${formatTime(d.playerTime)}`;
    let body = `<table class="standings">${standingRows(d.standings)}</table>`;
    let actions = `${d.hasNext ? '<button class="btn primary" data-act="next">Next track</button>' : ''}
        <button class="btn ${d.hasNext ? '' : 'primary'}" data-act="restart">Race again</button>
        <button class="btn ghost" data-act="quit">Menu</button>`;

    if (d.trial) {
      // Time trial: the medal is the result.
      const names = ['Gold', 'Silver', 'Bronze'];
      const m = d.trial.medal;
      badge = m >= 0 ? names[m] : '—';
      tone = m >= 0 ? `p${m + 1}` : 'p4';
      headline = m >= 0 ? `${names[m]} medal` : 'No medal this time';
      sub = `${d.track.name} · Time trial · ${formatTime(d.playerTime)}`;
      if (d.trial.improved) notes.push('<div class="note good">New best time. Your ghost has been updated.</div>');
      else notes.push(`<div class="note">Your best is ${formatTime(d.trial.best)}.</div>`);
      body = `<table class="standings">${d.trial.targets
        .map(
          (t, i) =>
            `<tr class="${i === m ? 'me' : ''}"><td class="pos"><span class="medal m${i + 1}">${names[i]}</span></td><td>${formatTime(t)} or better</td><td class="time">${d.playerTime <= t ? 'Achieved' : `${(d.playerTime - t).toFixed(2)}s off`}</td></tr>`,
        )
        .join('')}</table>`;
      actions = `<button class="btn primary" data-act="restart">Try again</button><button class="btn ghost" data-act="quit">Menu</button>`;
    } else if (d.champ) {
      const c = d.champ;
      sub = `${c.cup} · Race ${c.race} of ${c.races} · ${d.track.name}`;
      if (c.final) {
        badge = ordinal(c.final);
        tone = `p${Math.min(c.final, 4)}`;
        headline = c.final === 1 ? 'Champion!' : c.final <= 3 ? 'On the podium' : 'Cup complete';
      }
      body += `<div class="section-label">${c.final ? 'Final standings' : 'Championship standings'}</div>
        <table class="standings">${c.table
          .map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td class="pos">${i + 1}</td><td>${escapeHtml(r.name)}</td><td class="time">${r.points} pts</td></tr>`)
          .join('')}</table>`;
      actions = `${d.hasNext ? '<button class="btn primary" data-act="next">Next race</button>' : '<button class="btn primary" data-act="quit">Finish</button>'}
        ${d.hasNext ? '<button class="btn ghost" data-act="quit">Abandon cup</button>' : ''}`;
    } else if (d.online) {
      actions = '<button class="btn primary" data-act="quit">Back to room</button>';
    } else {
      if (d.eliminated) {
        headline = 'Knocked out';
        sub = `${d.track.name} · ${diff} · Knockout`;
      }
      if (d.newBest) notes.push(`<div class="note good">New personal best on ${diff}</div>`);
      if (d.unlockedName) notes.push(`<div class="note good">Level unlocked: ${d.unlockedName}</div>`);
      else if (d.playerPlace > 3) notes.push(`<div class="note">Finish in the top 3 to unlock the next level.</div>`);
    }

    const m = this.openModal(
      `
      <div class="result-head ${tone}">
        <div class="result-place">${badge}</div>
        <div>
          <h2>${headline}</h2>
          <div class="result-sub">${sub}</div>
        </div>
      </div>
      ${notes.join('')}
      ${body}
      <div class="modal-actions">${actions}</div>`,
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
      <p class="modal-lead">${escapeHtml(message)}</p>
      <div class="modal-actions"><button class="btn primary" data-act="close">Close</button></div>`);
    this.bind(m, { close: () => this.closeModal() });
  }
}

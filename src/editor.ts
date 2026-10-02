import { Track } from './track';
import { THEMES, ThemeName } from './tracks';
import { clamp } from './util';
import {
  CustomTrack,
  FeatureKind,
  FEATURES,
  EDITOR_REACH,
  HEIGHT_RANGE,
  blankTrack,
  checkTrack,
  toDef,
  toCode,
  fromCode,
  loadCustomTracks,
  saveCustomTracks,
} from './custom';

export interface EditorCallbacks {
  /** A track was saved (or saved over): put it in the game's list. */
  onSaved(track: CustomTrack): void;
  onDeleted(id: string): void;
  /** Race the track now. It has already been saved. */
  onTest(track: CustomTrack): void;
  onClose(): void;
  /** Ask a yes/no question in a dialog. */
  confirm(title: string, message: string, yes: string, onYes: () => void): void;
}

const THEME_LABELS: Record<ThemeName, string> = {
  day: 'Winter day',
  dusk: 'Dusk into night',
  glacier: 'Glacier',
  night: 'Night with aurora',
  blizzard: 'Blizzard',
  meadow: 'Spring meadow',
};

const MAP = 760;
const PROFILE_H = 96;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The track editor: a map to lay a course out on, a side panel for its
 * settings and features, and a running check that it can actually be raced.
 */
export class TrackEditor {
  readonly el: HTMLElement;
  private map: HTMLCanvasElement;
  private profile: HTMLCanvasElement;
  private side: HTMLElement;
  private tracks: CustomTrack[] = loadCustomTracks();
  private track: CustomTrack;
  /** The course as built from the current points, or null if they don't make one yet. */
  private built: Track | null = null;
  private selected = 0;
  /** The feature being placed with the next click on the course, if any. */
  private placing: FeatureKind | null = null;
  private dragging = false;
  private dirty = false;
  private status = '';

  constructor(private cb: EditorCallbacks) {
    this.track = this.tracks[0] ? structuredClone(this.tracks[0]) : blankTrack();
    this.el = document.createElement('div');
    this.el.className = 'editor hidden';
    this.el.innerHTML = `
      <div class="editor-main">
        <div class="editor-head">
          <div class="brand-mark small">TRACK<span>EDITOR</span></div>
          <div class="editor-tip" data-ref="tip"></div>
        </div>
        <canvas class="editor-map" width="${MAP}" height="${MAP}"></canvas>
        <canvas class="editor-profile" width="${MAP}" height="${PROFILE_H}"></canvas>
      </div>
      <div class="editor-side"></div>`;
    this.map = this.el.querySelector('.editor-map')!;
    this.profile = this.el.querySelector('.editor-profile')!;
    this.side = this.el.querySelector('.editor-side')!;
    this.bindMap();
    window.addEventListener('resize', () => this.open && this.layout());
    window.addEventListener('keydown', (e) => {
      if (this.el.classList.contains('hidden') || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') this.removePoint();
      else if (e.key === 'Escape' && this.placing) {
        this.placing = null;
        this.refresh();
      }
    });
    this.refresh();
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  show(show: boolean) {
    this.el.classList.toggle('hidden', !show);
    if (show) {
      this.layout();
      this.refresh();
    }
  }

  /** Makes the map as big a square as fits beside the panel. */
  private layout() {
    const size = Math.max(260, Math.min(this.el.clientHeight - 170, this.el.clientWidth - 450));
    this.map.style.width = this.map.style.height = size + 'px';
    this.profile.style.width = size + 'px';
  }

  // ---------- Map coordinates ----------

  private toPx = (v: number) => ((v + EDITOR_REACH) / (EDITOR_REACH * 2)) * MAP;
  private toWorld = (p: number) => (p / MAP) * EDITOR_REACH * 2 - EDITOR_REACH;

  private pointer(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.map.getBoundingClientRect();
    return [this.toWorld(((e.clientX - r.left) / r.width) * MAP), this.toWorld(((e.clientY - r.top) / r.height) * MAP)];
  }

  private bindMap() {
    const m = this.map;
    m.addEventListener('pointerdown', (e) => {
      const [x, z] = this.pointer(e);
      const pts = this.track.points;
      // Placing a feature: it goes at the nearest point of the course.
      if (this.placing) {
        const t = this.built;
        if (!t) return;
        const i = t.nearest(x, z);
        if (Math.hypot(t.px[i] - x, t.pz[i] - z) > 60) return;
        this.track.features.push({ kind: this.placing, at: clamp(Math.round((i / t.n) * 1000) / 1000, 0.03, 0.97) });
        this.placing = null;
        this.changed();
        return;
      }
      const grab = 14 * ((EDITOR_REACH * 2) / MAP);
      let hit = -1;
      pts.forEach((p, k) => {
        if (Math.hypot(p[0] - x, p[2] - z) < grab) hit = k;
      });
      if (hit >= 0) {
        this.selected = hit;
        this.dragging = true;
        m.setPointerCapture(e.pointerId);
        this.refresh();
        return;
      }
      if (pts.length >= 40) return;
      // A new point goes into whichever stretch it lengthens least.
      let at = pts.length;
      let least = Infinity;
      const last = this.track.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < last; k++) {
        const a = pts[k];
        const b = pts[(k + 1) % pts.length];
        const extra = Math.hypot(a[0] - x, a[2] - z) + Math.hypot(b[0] - x, b[2] - z) - Math.hypot(a[0] - b[0], a[2] - b[2]);
        if (extra < least) {
          least = extra;
          at = k + 1;
        }
      }
      // On an open run, a click beyond either end extends it.
      if (!this.track.closed && pts.length) {
        const toEnd = Math.hypot(pts[pts.length - 1][0] - x, pts[pts.length - 1][2] - z);
        const toStart = Math.hypot(pts[0][0] - x, pts[0][2] - z);
        if (toEnd < least) {
          least = toEnd;
          at = pts.length;
        }
        if (toStart < least) at = 0;
      }
      const before = pts[(at - 1 + pts.length) % pts.length] ?? [0, 0, 0];
      const after = pts[at % pts.length] ?? before;
      pts.splice(at, 0, [Math.round(x), Math.round((before[1] + after[1]) / 2), Math.round(z)]);
      this.selected = at;
      this.dragging = true;
      m.setPointerCapture(e.pointerId);
      this.changed();
    });
    m.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const [x, z] = this.pointer(e);
      const p = this.track.points[this.selected];
      if (!p) return;
      p[0] = Math.round(clamp(x, -EDITOR_REACH + 20, EDITOR_REACH - 20));
      p[2] = Math.round(clamp(z, -EDITOR_REACH + 20, EDITOR_REACH - 20));
      this.dirty = true;
      this.rebuild();
      this.draw();
    });
    const drop = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.refresh();
    };
    m.addEventListener('pointerup', drop);
    m.addEventListener('pointercancel', drop);
    // The wheel raises and lowers the selected point.
    m.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.track.points[this.selected];
        if (!p) return;
        p[1] = clamp(p[1] + (e.deltaY < 0 ? 2 : -2), HEIGHT_RANGE[0], HEIGHT_RANGE[1]);
        this.changed();
      },
      { passive: false },
    );
  }

  private removePoint() {
    const pts = this.track.points;
    if (pts.length <= (this.track.closed ? 4 : 3) || !pts[this.selected]) return;
    pts.splice(this.selected, 1);
    this.selected = Math.min(this.selected, pts.length - 1);
    this.changed();
  }

  private changed() {
    this.dirty = true;
    this.status = '';
    this.refresh();
  }

  // ---------- Drawing ----------

  private rebuild() {
    try {
      this.built = this.track.points.length >= (this.track.closed ? 4 : 3) ? new Track(toDef(this.track)) : null;
    } catch {
      this.built = null;
    }
  }

  private draw() {
    const g = this.map.getContext('2d')!;
    const px = this.toPx;
    g.fillStyle = '#0b1a29';
    g.fillRect(0, 0, MAP, MAP);
    // A line every 100 m.
    g.lineWidth = 1;
    for (let v = -EDITOR_REACH + 20; v <= EDITOR_REACH; v += 100) {
      g.strokeStyle = v === 0 ? 'rgba(160, 200, 230, 0.28)' : 'rgba(160, 200, 230, 0.09)';
      g.beginPath();
      g.moveTo(px(v), 0);
      g.lineTo(px(v), MAP);
      g.moveTo(0, px(v));
      g.lineTo(MAP, px(v));
      g.stroke();
    }
    g.fillStyle = 'rgba(155, 178, 198, 0.8)';
    g.font = '12px "Segoe UI", Arial, sans-serif';
    g.fillText('Grid: 100 m', 12, MAP - 12);

    const t = this.built;
    const scale = MAP / (EDITOR_REACH * 2);
    if (t) {
      const [lo, hi] = HEIGHT_RANGE;
      // The road, shaded by height: low is blue, high is amber.
      for (let i = 0; i < t.n - (t.closed ? 0 : 1); i++) {
        const j = t.wrap(i + 1);
        const k = clamp((t.py[i] - lo) / (hi - lo), 0, 1);
        g.strokeStyle = `rgb(${Math.round(60 + 186 * k)}, ${Math.round(170 - 2 * k)}, ${Math.round(235 - 200 * k)})`;
        g.lineWidth = Math.max(3, t.hw[i] * 2 * scale);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(px(t.px[i]), px(t.pz[i]));
        g.lineTo(px(t.px[j]), px(t.pz[j]));
        g.stroke();
      }
      // Start line and direction of travel.
      const s = t.startIdx;
      const sx = px(t.px[s]);
      const sz = px(t.pz[s]);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(sx - t.lx[s] * 14, sz - t.lz[s] * 14);
      g.lineTo(sx + t.lx[s] * 14, sz + t.lz[s] * 14);
      g.stroke();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(sx + t.tx[s] * 26, sz + t.tz[s] * 26);
      g.lineTo(sx + t.tx[s] * 12 + t.lx[s] * 7, sz + t.tz[s] * 12 + t.lz[s] * 7);
      g.lineTo(sx + t.tx[s] * 12 - t.lx[s] * 7, sz + t.tz[s] * 12 - t.lz[s] * 7);
      g.fill();
      g.font = '700 12px "Segoe UI", Arial, sans-serif';
      g.fillText('START', sx + 12, sz - 12);

      // Features.
      this.track.features.forEach((f) => {
        const i = t.wrap(Math.round(f.at * t.n));
        const fx = px(t.px[i]);
        const fz = px(t.pz[i]);
        g.fillStyle = '#12283d';
        g.strokeStyle = '#f6a821';
        g.lineWidth = 2;
        g.beginPath();
        g.rect(fx - 6, fz - 6, 12, 12);
        g.fill();
        g.stroke();
        g.fillStyle = '#f6a821';
        g.fillText(FEATURES.find((d) => d.kind === f.kind)!.label, fx + 10, fz + 4);
      });
    }

    // Control points, with their heights.
    this.track.points.forEach((p, k) => {
      const on = k === this.selected;
      g.beginPath();
      g.arc(px(p[0]), px(p[2]), on ? 9 : 6.5, 0, Math.PI * 2);
      g.fillStyle = on ? '#f6a821' : '#f3f8fc';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#041622';
      g.stroke();
      g.fillStyle = on ? '#f6a821' : 'rgba(243, 248, 252, 0.75)';
      g.font = `${on ? '700 ' : ''}12px "Segoe UI", Arial, sans-serif`;
      g.fillText(`${p[1]} m`, px(p[0]) + 12, px(p[2]) + 16);
    });

    // Height along the course.
    const c = this.profile.getContext('2d')!;
    c.fillStyle = '#0b1a29';
    c.fillRect(0, 0, MAP, PROFILE_H);
    c.fillStyle = 'rgba(155, 178, 198, 0.8)';
    c.font = '12px "Segoe UI", Arial, sans-serif';
    c.fillText('Height along the course', 12, 16);
    if (!t) return;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < t.n; i++) {
      min = Math.min(min, t.py[i]);
      max = Math.max(max, t.py[i]);
    }
    const range = Math.max(20, max - min);
    c.beginPath();
    for (let i = 0; i < t.n; i++) {
      const x = (i / (t.n - 1)) * MAP;
      const y = PROFILE_H - 10 - ((t.py[i] - min) / range) * (PROFILE_H - 34);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = '#6fcdf5';
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = 'rgba(155, 178, 198, 0.8)';
    c.textAlign = 'right';
    c.fillText(`${min.toFixed(0)} m to ${max.toFixed(0)} m`, MAP - 12, 16);
    c.textAlign = 'left';
  }

  // ---------- Side panel ----------

  private refresh() {
    this.rebuild();
    this.draw();
    const tr = this.track;
    const check = checkTrack(tr);
    const sel = tr.points[this.selected];
    const range = (key: string, label: string, min: number, max: number, step: number, value: number, unit: string) =>
      `<label class="ed-range"><span>${label}<b>${value}${unit}</b></span><input type="range" data-num="${key}" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
    (this.el.querySelector('[data-ref="tip"]') as HTMLElement).textContent = this.placing
      ? `Click on the course to place the ${FEATURES.find((f) => f.kind === this.placing)!.label.toLowerCase()}. Esc cancels.`
      : 'Click to add a point · drag to move it · scroll to raise or lower it · Delete removes it';
    this.side.innerHTML = `
      <label class="field"><span>Name</span><input type="text" data-in="name" maxlength="24" value="${esc(tr.name)}" /></label>
      <div class="segmented two">
        <button class="seg ${tr.closed ? 'active' : ''}" data-closed="1">Circuit</button>
        <button class="seg ${tr.closed ? '' : 'active'}" data-closed="0">Point to point</button>
      </div>
      ${tr.closed ? range('laps', 'Laps', 1, 5, 1, tr.laps, '') : ''}
      ${range('width', 'Road width', 16, 34, 1, tr.width, ' m')}
      <label class="field"><span>Setting</span><select data-in="theme">${(Object.keys(THEMES) as ThemeName[])
        .map((k) => `<option value="${k}" ${k === tr.theme ? 'selected' : ''}>${THEME_LABELS[k]}</option>`)
        .join('')}</select></label>
      ${range('mountain', 'Mountains', 20, 140, 5, tr.mountain, ' m')}
      ${range('trees', 'Trees', 200, 2200, 100, tr.trees, '')}
      ${range('obstacles', 'Rocks and logs on the road', 0, 10, 1, tr.obstacles, '')}
      <div class="setting compact"><div class="setting-name">Snowplough on the course</div><button class="switch ${tr.plough ? 'on' : ''}" role="switch" aria-checked="${tr.plough}" aria-label="Snowplough" data-plough><span></span></button></div>

      <div class="section-label">Selected point</div>
      ${sel ? `${range('height', 'Height', HEIGHT_RANGE[0], HEIGHT_RANGE[1], 1, sel[1], ' m')}<button class="btn small ghost" data-act="remove" ${tr.points.length <= (tr.closed ? 4 : 3) ? 'disabled' : ''}>Remove point</button>` : '<p class="ed-note">None.</p>'}

      <div class="section-label">Add a feature</div>
      <div class="ed-palette">${FEATURES.map((f) => `<button class="btn small ${this.placing === f.kind ? 'primary' : ''}" data-feature="${f.kind}" title="${f.note}">${f.label}</button>`).join('')}</div>
      ${tr.features.length ? `<div class="ed-features">${tr.features.map((f, k) => `<span class="chip">${FEATURES.find((d) => d.kind === f.kind)!.label} · ${Math.round(f.at * 100)}%<button data-unfeature="${k}" aria-label="Remove">×</button></span>`).join('')}</div>` : ''}

      <div class="section-label">Check</div>
      <div class="ed-stats">${check.length ? `${Math.round(check.length)} m${tr.closed ? ` × ${tr.laps}` : ''} · tightest corner ${Math.min(999, Math.round(check.radius))} m · steepest ${Math.round(check.grade * 100)}%` : ''}</div>
      ${check.problems.map((p) => `<div class="note bad">${p}</div>`).join('')}
      ${check.warnings.map((p) => `<div class="note">${p}</div>`).join('')}
      ${!check.problems.length && !check.warnings.length ? '<div class="note good">Ready to race.</div>' : ''}

      <div class="ed-actions">
        <button class="btn primary" data-act="test" ${check.problems.length ? 'disabled' : ''}>Save and race it</button>
        <button class="btn" data-act="save" ${check.problems.length ? 'disabled' : ''}>Save</button>
      </div>
      <div class="ed-status" role="status">${esc(this.status)}</div>

      <div class="section-label">Share</div>
      <div class="ed-actions"><button class="btn small" data-act="copy" ${check.problems.length ? 'disabled' : ''}>Copy this track's code</button></div>
      <div class="join-row"><input type="text" data-in="code" autocomplete="off" spellcheck="false" placeholder="Paste a friend's code" /><button class="btn small" data-act="load">Load</button></div>

      <div class="section-label">My tracks</div>
      <div class="ed-list">${this.tracks.map((t) => `<button class="chip ${t.id === tr.id ? 'me' : ''}" data-open="${t.id}">${esc(t.name)}</button>`).join('') || '<p class="ed-note">Nothing saved yet.</p>'}</div>
      <div class="ed-actions">
        <button class="btn small" data-act="new">New track</button>
        <button class="btn small ghost" data-act="delete" ${this.tracks.some((t) => t.id === tr.id) ? '' : 'disabled'}>Delete this track</button>
        <button class="btn small ghost" data-act="close">Back to menu</button>
      </div>`;
    this.bindSide();
  }

  private bindSide() {
    const s = this.side;
    const tr = this.track;
    const name = s.querySelector<HTMLInputElement>('[data-in="name"]')!;
    name.addEventListener('input', () => {
      tr.name = name.value;
      this.dirty = true;
    });
    s.querySelectorAll<HTMLButtonElement>('[data-closed]').forEach((b) =>
      b.addEventListener('click', () => {
        tr.closed = b.dataset.closed === '1';
        this.changed();
      }),
    );
    s.querySelectorAll<HTMLInputElement>('[data-num]').forEach((r) => {
      // Dragging updates the map; letting go redraws the panel with the new figure.
      const apply = () => {
        const v = Number(r.value);
        const key = r.dataset.num!;
        if (key === 'height') {
          const p = tr.points[this.selected];
          if (p) p[1] = v;
        } else (tr as unknown as Record<string, number>)[key] = v;
        this.dirty = true;
      };
      r.addEventListener('input', () => {
        apply();
        r.parentElement!.querySelector('b')!.textContent = r.value + (r.dataset.num === 'laps' || r.dataset.num === 'trees' || r.dataset.num === 'obstacles' ? '' : ' m');
        this.rebuild();
        this.draw();
      });
      r.addEventListener('change', () => {
        apply();
        this.changed();
      });
    });
    const theme = s.querySelector<HTMLSelectElement>('[data-in="theme"]')!;
    theme.addEventListener('change', () => {
      tr.theme = theme.value as ThemeName;
      this.changed();
    });
    s.querySelector('[data-plough]')!.addEventListener('click', () => {
      tr.plough = !tr.plough;
      this.changed();
    });
    s.querySelectorAll<HTMLButtonElement>('[data-feature]').forEach((b) =>
      b.addEventListener('click', () => {
        this.placing = this.placing === b.dataset.feature ? null : (b.dataset.feature as FeatureKind);
        this.refresh();
      }),
    );
    s.querySelectorAll<HTMLButtonElement>('[data-unfeature]').forEach((b) =>
      b.addEventListener('click', () => {
        tr.features.splice(Number(b.dataset.unfeature), 1);
        this.changed();
      }),
    );
    s.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) =>
      b.addEventListener('click', () => {
        const next = this.tracks.find((t) => t.id === b.dataset.open);
        if (!next || next.id === tr.id) return;
        this.leave(() => this.edit(structuredClone(next)));
      }),
    );
    const code = s.querySelector<HTMLInputElement>('[data-in="code"]')!;
    const acts: Record<string, () => void> = {
      remove: () => this.removePoint(),
      save: () => {
        this.save();
        this.refresh();
      },
      test: () => {
        this.save();
        this.cb.onTest(structuredClone(this.track));
      },
      copy: () => {
        const text = toCode(this.track);
        navigator.clipboard?.writeText(text).then(
          () => this.say('Code copied. Send it to a friend; they paste it here and press Load.'),
          () => {
            code.value = text;
            code.select();
            this.say('Copy the code from the box below.');
          },
        );
      },
      load: () => {
        const got = fromCode(code.value);
        if (!got) {
          this.say('That is not a track code.');
          return;
        }
        this.leave(() => {
          this.edit(got);
          this.dirty = true;
          this.say(`Loaded "${got.name}". Save it to keep it.`);
        });
      },
      new: () => this.leave(() => this.edit(blankTrack())),
      delete: () =>
        this.cb.confirm('Delete this track?', `"${tr.name}" will be removed from this computer. This can't be undone.`, 'Delete', () => {
          this.tracks = this.tracks.filter((t) => t.id !== tr.id);
          saveCustomTracks(this.tracks);
          this.cb.onDeleted(tr.id);
          this.edit(this.tracks[0] ? structuredClone(this.tracks[0]) : blankTrack());
        }),
      close: () => this.leave(() => this.cb.onClose()),
    };
    s.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]?.()));
  }

  private say(text: string) {
    this.status = text;
    const el = this.side.querySelector('.ed-status');
    if (el) el.textContent = text;
  }

  /** Runs `then` straight away, or after asking if there are changes that would be lost. */
  private leave(then: () => void) {
    if (!this.dirty) {
      then();
      return;
    }
    this.cb.confirm('Discard your changes?', `"${this.track.name}" has changes that haven't been saved.`, 'Discard', () => {
      this.dirty = false;
      then();
    });
  }

  private edit(track: CustomTrack) {
    this.track = track;
    this.selected = 0;
    this.placing = null;
    this.dirty = false;
    this.status = '';
    this.refresh();
  }

  private save() {
    const copy = structuredClone(this.track);
    copy.name = copy.name.trim() || 'My track';
    const at = this.tracks.findIndex((t) => t.id === copy.id);
    if (at >= 0) this.tracks[at] = copy;
    else this.tracks.push(copy);
    saveCustomTracks(this.tracks);
    this.dirty = false;
    this.status = 'Saved. It is in the track list on the menu.';
    this.cb.onSaved(copy);
  }
}

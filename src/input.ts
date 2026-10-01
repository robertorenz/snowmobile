import type { SledInput } from './sled';

const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/** Keyboard and gamepad, merged into one sled input. */
export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private steer = 0;
  private padPrev: boolean[] = [];
  enabled = true;

  constructor() {
    window.addEventListener('keydown', (e) => {
      // Typing a name or a chat message isn't driving.
      if (e.target instanceof HTMLInputElement) return;
      if (GAME_KEYS.has(e.code) && this.enabled) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('touchstart', () => this.buildTouch(), { once: true, passive: true });
  }

  private pad: HTMLElement | null = null;

  /**
   * On-screen buttons for phones and tablets. Built the first time the screen
   * is touched, so a desktop player never sees them. Each button behaves like
   * holding a key.
   */
  private buildTouch() {
    if (this.pad) return;
    const pad = (this.pad = document.createElement('div'));
    pad.className = 'touch hidden';
    pad.innerHTML = `
      <div class="touch-left">
        <button data-code="ArrowLeft" aria-label="Steer left">&#9664;</button>
        <button data-code="ArrowRight" aria-label="Steer right">&#9654;</button>
      </div>
      <div class="touch-right">
        <div class="touch-row">
          <button class="small" data-code="KeyF">FLIP</button>
          <button class="small" data-code="KeyE">THROW</button>
          <button class="small" data-code="Space">BOOST</button>
        </div>
        <div class="touch-row">
          <button data-code="ArrowDown">BRAKE</button>
          <button class="gas" data-code="ArrowUp">GAS</button>
        </div>
      </div>
      <button class="touch-pause" data-code="Escape" aria-label="Pause">II</button>`;
    document.body.appendChild(pad);
    pad.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const code = b.dataset.code!;
      const down = (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.keys.add(code);
        this.pressed.add(code);
        b.classList.add('held');
      };
      const up = () => {
        this.keys.delete(code);
        b.classList.remove('held');
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    });
    pad.classList.toggle('hidden', !this.touchWanted);
  }

  private touchWanted = false;

  /** Show the touch buttons (while racing) or hide them. */
  showTouch(show: boolean) {
    if (show === this.touchWanted) return;
    this.touchWanted = show;
    this.pad?.classList.toggle('hidden', !show);
  }

  /** True once per key press. */
  consume(...codes: string[]) {
    let hit = false;
    for (const c of codes) if (this.pressed.delete(c)) hit = true;
    return hit;
  }

  endFrame() {
    this.pressed.clear();
  }

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  read(dt: number): SledInput {
    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let boost = this.down('ShiftLeft', 'ShiftRight', 'Space');
    let target = (this.down('KeyA', 'ArrowLeft') ? 1 : 0) - (this.down('KeyD', 'ArrowRight') ? 1 : 0);
    let trick = this.down('KeyF');
    let item = this.down('KeyE', 'ControlLeft', 'ControlRight');
    let analog = false;

    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const x = pad.axes[0] ?? 0;
      if (Math.abs(x) > 0.12) {
        target = -x;
        analog = true;
      }
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      boost = boost || !!pad.buttons[0]?.pressed;
      trick = trick || !!pad.buttons[2]?.pressed;
      item = item || !!pad.buttons[1]?.pressed;
      // Map Start and Y onto the pause and reset keys.
      const map: [number, string][] = [
        [9, 'Escape'],
        [3, 'KeyR'],
      ];
      for (const [b, code] of map) {
        const now = !!pad.buttons[b]?.pressed;
        if (now && !this.padPrev[b]) this.pressed.add(code);
        this.padPrev[b] = now;
      }
    }

    // Keys are on/off, so ease the steering toward them; sticks pass straight through.
    if (analog) this.steer = target;
    else {
      const rate = target === 0 ? 7 : 4.5;
      const d = target - this.steer;
      this.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    }
    return { throttle, brake, steer: this.steer, boost, trick, item };
  }
}

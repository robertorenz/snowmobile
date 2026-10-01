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
      if (GAME_KEYS.has(e.code) && this.enabled) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
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
    return { throttle, brake, steer: this.steer, boost };
  }
}

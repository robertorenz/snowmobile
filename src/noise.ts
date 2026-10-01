import { mulberry32 } from './util';

/** Seeded 2D gradient noise. noise2 returns roughly [-1, 1]. */
export function makeNoise(seed: number) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];

  const gx = new Float32Array(256);
  const gy = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

  function noise2(x: number, y: number) {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const dx = x - xf;
    const dy = y - yf;
    const u = fade(dx);
    const v = fade(dy);
    const h00 = perm[perm[xi] + yi];
    const h10 = perm[perm[xi + 1] + yi];
    const h01 = perm[perm[xi] + yi + 1];
    const h11 = perm[perm[xi + 1] + yi + 1];
    const n00 = gx[h00] * dx + gy[h00] * dy;
    const n10 = gx[h10] * (dx - 1) + gy[h10] * dy;
    const n01 = gx[h01] * dx + gy[h01] * (dy - 1);
    const n11 = gx[h11] * (dx - 1) + gy[h11] * (dy - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.5;
  }

  function fbm(x: number, y: number, octaves = 4) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2(x * freq, y * freq) * amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum;
  }

  return { noise2, fbm };
}

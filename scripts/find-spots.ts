// Finds places on each track where a shortcut or a hazard would fit:
// - shortcuts: two points a long way apart along the road but close as the crow flies,
//   with clear ground between them;
// - straights: long, gently curving, gently sloping stretches away from every other feature.
import { TRACKS } from '../src/tracks';
import { Track } from '../src/track';

for (const def of TRACKS) {
  const t = new Track(def);
  const n = t.n;
  const len = t.length;
  // Samples that already have something going on.
  const busy = new Uint8Array(n);
  const mark = (fromS: number, toS: number) => {
    for (let i = Math.floor(fromS / t.ds); i <= Math.ceil(toS / t.ds); i++) if (t.closed || (i >= 0 && i < n)) busy[t.wrap(i)] = 1;
  };
  for (const c of t.crossings) mark(c.lipS - 120, c.s + c.half + 80);
  for (const j of t.ramps) mark(j.at * len - j.length - 10, j.at * len + 50);


  for (const [a, b] of [...t.bridgeSpans, ...t.tunnelSpans]) mark(a * t.ds - 40, b * t.ds + 40);

  mark(-40, 60);
  if (!t.closed) mark(len - 120, len);
  const lake = def.lake;
  const onLake = (x: number, z: number) => !!lake && Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz) < 1.15;

  console.log(`\n=== ${def.id} (${len.toFixed(0)} m, ${t.closed ? 'circuit' : 'open'}) ===`);

  // --- Shortcuts ---
  const found: { a: number; b: number; path: number; chord: number; dy: number; clear: number }[] = [];
  for (let a = 0; a < n; a += 4) {
    if (busy[a]) continue;
    for (let span = Math.round(170 / t.ds); span <= Math.round(520 / t.ds); span += 4) {
      const b = a + span;
      if (!t.closed && b >= n) break;
      const bi = t.wrap(b);
      if (busy[bi]) continue;
      const chord = Math.hypot(t.px[bi] - t.px[a], t.pz[bi] - t.pz[a]);
      const path = span * t.ds;
      if (chord > path * 0.66 || chord < 60 || chord > 260) continue;
      // The road should leave and rejoin heading roughly along the chord.
      const cx = (t.px[bi] - t.px[a]) / chord;
      const cz = (t.pz[bi] - t.pz[a]) / chord;
      if (t.tx[a] * cx + t.tz[a] * cz < -0.1 || t.tx[bi] * cx + t.tz[bi] * cz < -0.1) continue;
      const dy = t.py[bi] - t.py[a];
      if (Math.abs(dy) / chord > 0.3) continue;
      // Clear ground: the middle of the chord has to be well away from every part of the road.
      let clear = Infinity;
      let bad = false;
      for (let u = 0.2; u <= 0.8001; u += 0.1) {
        const x = t.px[a] + (t.px[bi] - t.px[a]) * u;
        const z = t.pz[a] + (t.pz[bi] - t.pz[a]) * u;
        if (onLake(x, z)) bad = true;
        for (let i = 0; i < n; i += 2) clear = Math.min(clear, Math.hypot(x - t.px[i], z - t.pz[i]) - t.hw[i]);
      }
      if (bad || clear < 13) continue;
      found.push({ a, b: bi, path, chord, dy, clear });
    }
  }
  found.sort((p, q) => q.path - q.chord - (p.path - p.chord));
  const shown: typeof found = [];
  for (const f of found) {
    if (shown.some((s) => Math.abs(s.a - f.a) * t.ds < 250)) continue;
    shown.push(f);
    if (shown.length >= 3) break;
  }
  for (const f of shown) {
    console.log(
      `  shortcut  from ${(f.a / n).toFixed(4)} to ${(f.b / n).toFixed(4)}  road ${f.path.toFixed(0)} m, straight ${f.chord.toFixed(0)} m (saves ${(f.path - f.chord).toFixed(0)} m), dy ${f.dy.toFixed(1)}, clear ${f.clear.toFixed(0)} m`,
    );
  }
  if (!shown.length) console.log('  shortcut  none');

  // --- Straights ---
  const need = Math.round(120 / t.ds);
  let run = 0;
  const straights: [number, number][] = [];
  for (let i = 0; i < (t.closed ? n + need : n); i++) {
    const k = t.wrap(i);
    const ok = !busy[k] && Math.abs(t.curv[k]) < 1 / 140 && Math.abs(t.slope[k]) < 0.12 && !onLake(t.px[k], t.pz[k]);
    if (ok) run++;
    else {
      if (run >= need) straights.push([i - run, i - 1]);
      run = 0;
    }
  }
  if (run >= need) straights.push([n - run, n - 1]);
  for (const [a, b] of straights.slice(0, 5)) {
    console.log(`  straight  ${(a / n).toFixed(3)}-${(b / n).toFixed(3)}  (${((b - a) * t.ds).toFixed(0)} m)  mid ${(((a + b) / 2) / n).toFixed(4)}  width ${(t.hw[t.wrap(Math.round((a + b) / 2))] * 2).toFixed(0)} m`);
  }
  if (!straights.length) console.log('  straight  none');
}

// Sanity-checks every track: length, tightest corner, steepest grade, and how
// close two different stretches of the course come to each other (the terrain
// blend needs them well apart).
import { TRACKS } from '../src/tracks';
import { Track } from '../src/track';

for (const def of TRACKS) {
  const t = new Track(def);
  let maxK = 0;
  let maxSlope = 0;
  for (let i = 0; i < t.n; i++) {
    maxK = Math.max(maxK, Math.abs(t.curv[i]));
    maxSlope = Math.max(maxSlope, Math.abs(t.slope[i]));
  }
  let minSep = Infinity;
  let sepAt = '';
  const skip = Math.round(260 / t.ds);
  for (let i = 0; i < t.n; i += 3) {
    for (let j = i + skip; j < t.n; j += 3) {
      if (t.closed && t.n - j + i < skip) continue;
      const d = Math.hypot(t.px[i] - t.px[j], t.pz[i] - t.pz[j]);
      if (d < minSep) {
        minSep = d;
        sepAt = `s=${Math.round(i * t.ds)} vs s=${Math.round(j * t.ds)} (dy=${(t.py[i] - t.py[j]).toFixed(1)})`;
      }
    }
  }
  console.log(
    `${def.name.padEnd(18)} length ${t.length.toFixed(0).padStart(5)} m | race ${t.raceLength.toFixed(0).padStart(5)} m | ` +
      `min radius ${(1 / maxK).toFixed(0).padStart(4)} m | max grade ${(maxSlope * 100).toFixed(0).padStart(3)}% | ` +
      `min separation ${minSep.toFixed(0)} m at ${sepAt} | width ${(Math.min(...t.hw) * 2).toFixed(0)}-${(Math.max(...t.hw) * 2).toFixed(0)} m | ${t.obstacles.length} obstacles`,
  );
  // Crossings want a straight run-up and landing: report the tightest radius within 110 m before and 70 m after.
  for (const c of t.crossings) {
    let k = 0;
    for (let i = Math.round((c.s - 110) / t.ds); i < (c.s + 70) / t.ds; i++) k = Math.max(k, Math.abs(t.curv[t.wrap(i)]));
    console.log(`    ${c.kind.padEnd(8)} at s=${c.s.toFixed(0).padStart(5)}  tightest radius nearby ${(1 / Math.max(k, 1e-5)).toFixed(0)} m  width ${(t.hw[c.idx] * 2).toFixed(0)} m`);
  }
  // Shortcuts: how much road they save, how steep they are, and how close their middle comes to the road.
  for (const sc of t.shortcuts) {
    let run = 0;
    let steep = 0;
    let clear = Infinity;
    for (let k = 1; k < sc.n; k++) {
      const d = Math.hypot(sc.x[k] - sc.x[k - 1], sc.z[k] - sc.z[k - 1]);
      run += d;
      steep = Math.max(steep, Math.abs(sc.y[k] - sc.y[k - 1]) / d);
      const u = k / (sc.n - 1);
      if (u < 0.2 || u > 0.8) continue;
      for (let i = 0; i < t.n; i += 2) {
        // The road it has just left and is about to join is meant to be close; anything else isn't.
        const into = t.closed ? (i - sc.from + t.n) % t.n : i - sc.from;
        if ((into > -50 && into < sc.span * 0.3) || (into > sc.span * 0.7 && into < sc.span + 50) || into > t.n - 50) continue;
        clear = Math.min(clear, Math.hypot(sc.x[k] - t.px[i], sc.z[k] - t.pz[i]) - t.hw[i] - sc.hw);
      }
    }
    console.log(`    shortcut ${(sc.from / t.n).toFixed(3)}-${(sc.to / t.n).toFixed(3)}  ${run.toFixed(0)} m against ${(sc.span * t.ds).toFixed(0)} m by road  steepest ${(steep * 100).toFixed(0)}%  ${sc.ice ? 'ice' : 'snow'} ${(sc.hw * 2).toFixed(0)} m wide  clear of the road by ${clear.toFixed(0)} m`);
  }
  // Bridges and tunnels: where they fall along the lap, and how much headroom the road underneath gets.
  for (const [a, b] of t.bridgeSpans) {
    const mid = (a + b) >> 1;
    let under = -1;
    let best = Infinity;
    for (let i = 0; i < t.n; i++) {
      if (t.bridge[i]) continue;
      const d = Math.hypot(t.px[i] - t.px[mid], t.pz[i] - t.pz[mid]);
      if (d < best) { best = d; under = i; }
    }
    console.log(`    bridge   ${(a / t.n).toFixed(3)}-${(b / t.n).toFixed(3)}  road below at ${(under / t.n).toFixed(3)}  headroom ${(t.py[mid] - t.py[under]).toFixed(1)} m`);
  }
  for (const [a, b] of t.tunnelSpans) console.log(`    tunnel   ${(a / t.n).toFixed(3)}-${(b / t.n).toFixed(3)}  (${((b - a) * t.ds).toFixed(0)} m)`);
}
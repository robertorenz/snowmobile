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
}
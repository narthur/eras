// The ground everything else stands on: how big the map is, what a cell holds,
// how to find a cell's neighbours, and the seeded noise every rule draws its
// chance from. Depends on nothing — every other module in the package depends
// on this one, which is what keeps the whole thing a DAG.
//
// Units, all integers so a tick is bit-for-bit reproducible:
//   elev  decimetres of bedrock relative to sea level (Int16, negative = sea floor)
//   soil  millimetres of loose material on top of bedrock
//   water millimetres of water in the cell. The first soil/8 of it is held in
//         the soil against gravity and never runs off; only what is above that
//         stands on the surface, flows downhill, drowns plants and cuts rivers
//   veg   0..VEG_MAX vegetation density. Grows toward what the cell's moisture
//         and soil can carry, and burns back to nothing when dry canopy lights
//   flow  the drainage above the cell: everything upstream of it, weighted by
//         each cell's rainfall. Redrawn when the land moves, not every day
//   rain  per-cell rainfall weight: what the wind drops here, given the shape
//         of the land. What actually falls is this scaled by the weather of
//         the day, which drifts by the decade
// Surface height in millimetres is elev * 100 + soil + water.

export const SIZE = 256;

export const CELLS = SIZE * SIZE;

export const VEG_MAX = 10000;

                  // 700mm a year, which is what a temperate pond loses
export const RULE_VERSION = 14;

export type World = {
  seed: number;
  tick: number;
  ruleVersion: number;
  elev: Int16Array;
  soil: Uint16Array;
  water: Uint16Array;
  veg: Uint16Array;
  flow: Uint16Array;
  rain: Uint8Array;
};

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A world is six typed arrays and three numbers, and copying the lot costs
 * 0.021ms against a 13.8ms tick — two parts in a thousand. That is the whole
 * reason `step` can be pure: nothing here is too big to copy, it only looked
 * that way.
 */
export const copy = (w: World): World => ({
  seed: w.seed,
  tick: w.tick,
  ruleVersion: w.ruleVersion,
  elev: w.elev.slice(),
  soil: w.soil.slice(),
  water: w.water.slice(),
  veg: w.veg.slice(),
  flow: w.flow.slice(),
  rain: w.rain.slice(),
});

// ponytail: floats here, but only + - * / which are exact per IEEE754, so this
// is reproducible across engines. No Math.sin/pow/random anywhere. The tick
// divides too, but truncates to an integer after every one, so it lands in the
// same place on every machine.

export const hash2 = (x: number, y: number, s: number) => {
  const a = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  const h = Math.imul(a ^ (a >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const vnoise = (x: number, y: number, s: number) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

export const fbm = (x: number, y: number, s: number, octaves: number) => {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, s + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
};

export function* neighbours(i: number) {
  const x = i % SIZE, y = (i / SIZE) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      yield ny * SIZE + nx;
    }
  }
}

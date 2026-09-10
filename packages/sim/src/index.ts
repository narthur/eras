// The world. Pure state machine: no I/O, no clock, no randomness beyond the seed.
//
// Units, all integers so a tick is bit-for-bit reproducible:
//   elev  decimetres of bedrock relative to sea level (Int16, negative = sea floor)
//   soil  millimetres of loose material on top of bedrock
//   water millimetres of water in the cell. The first soil/8 of it is held in
//         the soil against gravity and never runs off; only what is above that
//         stands on the surface, flows downhill, drowns plants and cuts rivers
//   veg   0..VEG_MAX vegetation density
//   flow  millimetres of water that left the cell during the last tick
//   rain  static per-cell rainfall weight from worldgen
// Surface height in millimetres is elev * 100 + soil + water.

export const SIZE = 256;
export const CELLS = SIZE * SIZE;
export const VEG_MAX = 10000;
export const RULE_VERSION = 1;

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

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ---- worldgen -------------------------------------------------------------
// ponytail: floats here, but only + - * / which are exact per IEEE754, so this
// is reproducible across engines. No Math.sin/pow/random anywhere. The tick
// divides too, but truncates to an integer after every one, so it lands in the
// same place on every machine.

const hash2 = (x: number, y: number, s: number) => {
  const a = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  const h = Math.imul(a ^ (a >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const vnoise = (x: number, y: number, s: number) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

const fbm = (x: number, y: number, s: number, octaves: number) => {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, s + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
};

/** Event zero: noise heightmap plus a one-shot weathering pass. */
export function generate(seed: number): World {
  const elev = new Int16Array(CELLS);
  const soil = new Uint16Array(CELLS);
  const water = new Uint16Array(CELLS);
  const veg = new Uint16Array(CELLS);
  const flow = new Uint16Array(CELLS);
  const rain = new Uint8Array(CELLS);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      // land mass, then ridgelines folded in only where there is already land
      const base = fbm(x / 60, y / 60, seed, 6) * 2.2 - 1.05;
      const r = 1 - Math.abs(fbm(x / 34, y / 34, seed + 1013, 4) * 2 - 1);
      const ridged = r * r * r * (base > 0 ? base : 0) * 1.15;
      // the sea has to close at the border, so the map is a world and not a crop
      const edge = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y) / 34;
      const fall = edge >= 1 ? 0 : (1 - edge) * (1 - edge) * 2.2;
      elev[i] = clamp(Math.round((base + ridged - fall) * 2400), -500, 3000);
      rain[i] = clamp(Math.round(fbm(x / 70, y / 70, seed + 4441, 3) * 200 + 40), 20, 255);
    }
  }
  // weathering: flat ground keeps soil, steep ground sheds it
  for (let i = 0; i < CELLS; i++) {
    let slope = 0;
    for (const j of neighbours(i)) slope = Math.max(slope, Math.abs(elev[i] - elev[j]));
    soil[i] = clamp(1400 - slope * 5, 0, 1400);
    if (elev[i] <= 0) water[i] = Math.max(0, -(elev[i] * 100 + soil[i]));
  }
  return { seed, tick: 0, ruleVersion: RULE_VERSION, elev, soil, water, veg, flow, rain };
}

// ---- tick -----------------------------------------------------------------

function* neighbours(i: number) {
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

const order = new Int32Array(CELLS);
const height = new Int32Array(CELLS);

/** One world-day. Rain, flow, erosion, deposition, growth. */
export function step(w: World): void {
  const { elev, soil, water, veg, flow, rain } = w;
  flow.fill(0);

  // rain, then evaporation. Vegetation holds moisture back.
  for (let i = 0; i < CELLS; i++) {
    if (elev[i] > 0) {
      water[i] = Math.min(65535, water[i] + (rain[i] >> 3));
      const loss = (water[i] * (120 - ((veg[i] * 60) / VEG_MAX | 0))) / 1000 | 0;
      water[i] = Math.max(0, water[i] - loss);
    }
    height[i] = elev[i] * 100 + soil[i] + water[i];
    order[i] = i;
  }

  // Flow downhill, highest surface first, so water crosses the map in one pass.
  // Ties break on index: the iteration order is part of the rules.
  const ord = order.sort((a, b) => height[b] - height[a] || a - b);

  for (let k = 0; k < CELLS; k++) {
    const i = ord[k];
    if (water[i] === 0) continue;
    let lowest = -1, lowestH = height[i];
    for (const j of neighbours(i)) {
      if (height[j] < lowestH) { lowestH = height[j]; lowest = j; }
    }
    if (lowest < 0) continue;
    // soil holds moisture back; only what it cannot hold runs off
    const spare = water[i] - (soil[i] >> 3);
    if (spare <= 0) continue;
    // move half the head difference, never more than there is spare water
    const t = Math.min(spare, (height[i] - lowestH) >> 1);
    if (t === 0) continue;
    water[i] -= t;
    water[lowest] = Math.min(65535, water[lowest] + t);
    flow[i] = Math.min(65535, flow[i] + t);

    // sediment: carried in proportion to flow, resisted by roots
    const carry = Math.min(soil[i], ((t >> 5) * VEG_MAX) / (VEG_MAX + veg[i] * 3) | 0);
    if (carry > 0) {
      soil[i] -= carry;
      soil[lowest] = Math.min(65535, soil[lowest] + carry);
    }
    height[i] = elev[i] * 100 + soil[i] + water[i];
    height[lowest] = elev[lowest] * 100 + soil[lowest] + water[lowest];
  }

  for (let i = 0; i < CELLS; i++) {
    // the sea is a sink: it refills to the datum and swallows whatever arrives
    if (elev[i] <= 0) {
      water[i] = Math.max(0, -(elev[i] * 100 + soil[i]));
      veg[i] = Math.max(0, veg[i] - 50);
      continue;
    }
    // bedrock weathers into new soil, or the island would scour itself bare
    if (soil[i] < 3000 && (w.tick & 15) === 0) soil[i]++;
    const s = soil[i], excess = water[i] - (s >> 3);
    let d: number;
    if (excess > 1200) d = -20;          // drowned
    else if (s < 80) d = -5;             // bare rock
    else if (water[i] * 16 < s) d = -3;  // parched: below half of what the soil can hold
    else d = 1;                          // decades to a mature forest
    veg[i] = clamp(veg[i] + d, 0, VEG_MAX);
  }
  w.tick++;
  w.ruleVersion = RULE_VERSION;   // stamp the rules that actually ran this tick
}

// ---- classification and wire format ---------------------------------------

export const Biome = { Ocean: 0, Lake: 1, River: 2, Rock: 3, Barren: 4, Grass: 5, Forest: 6, Peak: 7 } as const;

export function biome(w: World, i: number): number {
  if (w.elev[i] <= 0) return Biome.Ocean;
  if (w.water[i] - (w.soil[i] >> 3) > 1200) return Biome.Lake;
  if (w.flow[i] > 400) return Biome.River;
  if (w.elev[i] > 1800) return Biome.Peak;
  if (w.veg[i] > 6000) return Biome.Forest;
  if (w.veg[i] > 1500) return Biome.Grass;
  if (w.soil[i] < 80) return Biome.Rock;
  return Biome.Barren;
}

const HEADER = 16;
const BYTES = HEADER + CELLS * 11;

export function pack(w: World): ArrayBuffer {
  const buf = new ArrayBuffer(BYTES);
  const head = new DataView(buf);
  head.setUint32(0, 0x45524153);            // "ERAS"
  head.setUint32(4, w.ruleVersion);
  head.setUint32(8, w.seed);
  head.setUint32(12, w.tick);
  let o = HEADER;
  new Int16Array(buf, o, CELLS).set(w.elev); o += CELLS * 2;
  new Uint16Array(buf, o, CELLS).set(w.soil); o += CELLS * 2;
  new Uint16Array(buf, o, CELLS).set(w.water); o += CELLS * 2;
  new Uint16Array(buf, o, CELLS).set(w.veg); o += CELLS * 2;
  new Uint16Array(buf, o, CELLS).set(w.flow); o += CELLS * 2;
  new Uint8Array(buf, o, CELLS).set(w.rain);
  return buf;
}

export function unpack(buf: ArrayBuffer): World {
  const head = new DataView(buf);
  if (head.getUint32(0) !== 0x45524153) throw new Error("not a world");
  if (buf.byteLength !== BYTES) {
    throw new Error(`world is ${buf.byteLength} bytes, this build reads ${BYTES}`);
  }
  let o = HEADER;
  const take = <T>(C: new (b: ArrayBuffer, o: number, n: number) => T, size: number): T => {
    const a = new C(buf, o, CELLS); o += CELLS * size; return a;
  };
  return {
    ruleVersion: head.getUint32(4),
    seed: head.getUint32(8),
    tick: head.getUint32(12),
    elev: take(Int16Array, 2),
    soil: take(Uint16Array, 2),
    water: take(Uint16Array, 2),
    veg: take(Uint16Array, 2),
    flow: take(Uint16Array, 2),
    rain: take(Uint8Array, 1),
  };
}

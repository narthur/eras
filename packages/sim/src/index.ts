// The world. Pure state machine: no I/O, no clock, no randomness beyond the seed.
//
// Units, all integers so a tick is bit-for-bit reproducible:
//   elev  decimetres of bedrock relative to sea level (Int16, negative = sea floor)
//   soil  millimetres of loose material on top of bedrock
//   water millimetres of water in the cell. The first soil/8 of it is held in
//         the soil against gravity and never runs off; only what is above that
//         stands on the surface, flows downhill, drowns plants and cuts rivers
//   veg   0..VEG_MAX vegetation density. Grows toward what the cell's moisture
//         and soil can carry, and burns back to nothing when dry canopy lights
//   flow  millimetres of water that left the cell during the last tick
//   rain  static per-cell rainfall weight from worldgen
// Surface height in millimetres is elev * 100 + soil + water.

export const SIZE = 256;
export const CELLS = SIZE * SIZE;
export const VEG_MAX = 10000;
export const RULE_VERSION = 2;

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

// Fire is the only thing that happens to a world that has finished growing.
// Without it the map is done the day the last cell matures; with it the land
// keeps a patchwork of ages, because a burn grows back at its own cell's rate.
const FIRE_ODDS = 0.0000005;   // per dry canopy cell per day, a few fires a year
const BURN_CAP = 500;          // cells, so no one fire takes the continent
const stack = new Int32Array(BURN_CAP);
const fires: number[] = [];

// Burns outward from the strike through anything dry enough to carry it.
// Setting the cell to bare on the way in is what stops it burning twice.
function burn(w: World, at: number) {
  const { veg, water, soil } = w;
  let top = 0, burnt = 1;
  veg[at] = 0;
  stack[top++] = at;
  // Counted on the way in rather than on the way out: a cell popped off the
  // stack frees the slot for another, so bounding the stack depth bounds only
  // how wide the fire front is and lets the fire itself run to twice its cap.
  while (top > 0) {
    const i = stack[--top];
    for (const j of neighbours(i)) {
      if (burnt >= BURN_CAP || veg[j] < 2000) continue;
      if (water[j] - (soil[j] >> 3) > 0) continue;   // a river or a lake stops it
      veg[j] = 0;
      stack[top++] = j;
      burnt++;
    }
  }
}

/** One world-day. Rain, flow, erosion, deposition, growth, fire. */
export function step(w: World): void {
  const { elev, soil, water, veg, flow, rain } = w;
  flow.fill(0);
  fires.length = 0;

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
    // Bedrock weathers into new soil, or the island would scour itself bare.
    // It stops below what flat ground starts with, so it replaces what erosion
    // strips off the uplands rather than burying the whole world: soil holds
    // back the first soil/8 of the rain, so deepening it everywhere slowly
    // strangles the rivers — they fell by two thirds over forty years when
    // this ran to 3000mm.
    if (soil[i] < 1200 && (w.tick & 15) === 0) soil[i]++;
    const s = soil[i], held = s >> 3, excess = water[i] - held;
    // What this cell can carry. Rainfall is the permanent term: it varies two to
    // one across the continent and never moves, so it is what makes forest
    // country and grass country different places rather than different years.
    // Soil gates the young world, which has not yet enough of it to root a
    // forest. Drought bites only when the ground falls well below what it can
    // hold — moisture alone was no use as the main term, because saturated soil
    // reads 100% nearly everywhere for the first forty years and every cell
    // then looks identical, which is how the whole continent used to cross from
    // barren to grass to forest in one year each and never change again.
    const damp = held > 0 ? ((water[i] * 100) / held) | 0 : 0;
    const cap = Math.min(clamp((rain[i] - 85) * 110, 0, VEG_MAX), s * 6,
                         damp >= 60 ? VEG_MAX : damp * 160);
    let d: number;
    if (excess > 1200) d = -20;              // drowned
    else if (s < 80) d = -5;                 // bare rock
    else if (veg[i] > cap) d = -3;           // more canopy than the ground keeps
    else d = 1 + ((cap / 4000) | 0);         // good ground fills in faster
    veg[i] = clamp(veg[i] + d, 0, VEG_MAX);
    // Dry canopy, long odds, drawn from the cell and the day so the same world
    // burns in the same places. Collected rather than lit here: a fire that
    // spread while the growth loop was still running would reach cells that
    // had not grown yet today, and the rules would depend on the loop order.
    if (veg[i] > 5000 && rain[i] < 150 && hash2(i, w.tick, w.seed) < FIRE_ODDS) fires.push(i);
  }
  for (const i of fires) burn(w, i);
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

// ---- features ---------------------------------------------------------------
// The things in the world big enough to be worth a name. A feature is just a
// connected run of like cells; naming them is someone else's job.

export type FeatureKind = "island" | "lake" | "river" | "forest" | "range";
export type Feature = { kind: FeatureKind; size: number; x: number; y: number };

// Below these sizes a thing is scenery, not a place. Lakes are deliberately
// small: they fill and drain within a few years, and catching one before it
// goes is the point rather than a defect.
//
// ponytail: rivers come out as the strongest reaches of a watercourse rather
// than a whole drainage. Roughly 260 pits dot the continent, each ending a
// basin, so flow accumulation over the raw surface never gathers more than a
// few hundred cells. Fixing it properly means filling sinks first — a naive
// iterative fill raises a pit 1mm a round and never converges; it wants
// priority-flood. Worth doing when a river needs to be named end to end.
export const FEATURE_MIN: Record<FeatureKind, number> =
  { island: 8, lake: 4, river: 10, forest: 300, range: 16 };

const seen = new Int32Array(CELLS);
const queue = new Int32Array(CELLS);
const kindAt = new Uint8Array(CELLS);
let pass = 0;   // stamped into `seen`, so it never needs clearing

export function features(w: World, min = FEATURE_MIN): Feature[] {
  for (let i = 0; i < CELLS; i++) kindAt[i] = biome(w, i);
  // Connectivity follows whatever made the thing. Water runs to any of the
  // eight neighbours, so a river is a diagonal staircase and reads as a row of
  // unrelated puddles if you only look up, down and sideways. Land is joined
  // squarely: two shores touching at one corner are two islands.
  const kinds: [FeatureKind, (i: number) => boolean, boolean][] = [
    ["island", (i) => w.elev[i] > 0, false],
    ["lake", (i) => kindAt[i] === Biome.Lake, false],
    ["river", (i) => kindAt[i] === Biome.River, true],
    ["forest", (i) => kindAt[i] === Biome.Forest, false],
    ["range", (i) => kindAt[i] === Biome.Peak, false],
  ];

  const out: Feature[] = [];
  for (const [kind, belongs, diagonal] of kinds) {
    pass++;
    for (let start = 0; start < CELLS; start++) {
      if (seen[start] === pass || !belongs(start)) continue;
      seen[start] = pass;
      queue[0] = start;
      let head = 0, tail = 1, size = 0, sx = 0, sy = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % SIZE, y = (i / SIZE) | 0;
        size++; sx += x; sy += y;
        const left = x > 0, right = x < SIZE - 1, up = y > 0, down = y < SIZE - 1;
        if (left) tail = visit(i - 1, belongs, tail);
        if (right) tail = visit(i + 1, belongs, tail);
        if (up) tail = visit(i - SIZE, belongs, tail);
        if (down) tail = visit(i + SIZE, belongs, tail);
        if (diagonal) {
          if (left && up) tail = visit(i - SIZE - 1, belongs, tail);
          if (right && up) tail = visit(i - SIZE + 1, belongs, tail);
          if (left && down) tail = visit(i + SIZE - 1, belongs, tail);
          if (right && down) tail = visit(i + SIZE + 1, belongs, tail);
        }
      }
      if (size >= min[kind]) {
        out.push({ kind, size, x: Math.round(sx / size), y: Math.round(sy / size) });
      }
    }
  }
  return out.sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x);
}

function visit(i: number, belongs: (i: number) => boolean, tail: number): number {
  if (seen[i] === pass || !belongs(i)) return tail;
  seen[i] = pass;
  queue[tail] = i;
  return tail + 1;
}

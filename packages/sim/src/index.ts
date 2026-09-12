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
//   flow  the drainage above the cell: everything upstream of it, weighted by
//         each cell's rainfall. Redrawn when the land moves, not every day
//   rain  per-cell rainfall weight: what the wind drops here, given the shape
//         of the land. What actually falls is this scaled by the weather of
//         the day, which drifts by the decade
// Surface height in millimetres is elev * 100 + soil + water.

export const SIZE = 256;
export const CELLS = SIZE * SIZE;
export const VEG_MAX = 10000;
// Rain arrives as fronts: a field of wet and dry country that drifts east
// across the map, soaking a swathe of it for a few days at a time. Drawn on a
// coarse lattice once a tick and read off it smoothly, because a storm drawn
// per patch of ground owes nothing to the patch beside it and the country ends
// up tiled in hard eight-cell squares — which is exactly what it looked like.
const STORMS = 8;   // the long-run ratio of dry days to wet at a given place
const PATCH = 8;    // cells across a patch of weather
const DRIFT = 2;    // days for the front to move on by one patch
const WET = 645;    // above this the front is raining, in thousandths
const SPAN = SIZE / PATCH + 2;
const sky = new Int32Array(SPAN * SPAN);   // the front, on its coarse lattice

/** Draws today's weather front and returns how far it has drifted into it. */
function fronts(w: World): number {
  // Negative on purpose. A positive tick term reads the field at
  // x/PATCH + tick/DRIFT, which walks the pattern toward smaller x — west,
  // into the weather instead of along with it. The wind here comes from the
  // north-west, so the front has to cross eastward: PATCH/DRIFT cells a day.
  const off = -w.tick / DRIFT;
  const base = Math.floor(off);
  for (let ny = 0; ny < SPAN; ny++) {
    for (let nx = 0; nx < SPAN; nx++) {
      sky[ny * SPAN + nx] = (hash2(nx + base, ny, w.seed + 7717) * 1000) | 0;
    }
  }
  return off - base;
}

/** How hard it is raining at a cell, in thousandths of a storm. */
function falling(i: number, slide: number): number {
  const px = (i % SIZE) / PATCH + slide, ix = px | 0, fx = px - ix;
  const py = ((i / SIZE) | 0) / PATCH, iy = py | 0, fy = py - iy;
  const o = iy * SPAN + ix;
  const top = sky[o] + (sky[o + 1] - sky[o]) * fx;
  const low = sky[o + SPAN] + (sky[o + SPAN + 1] - sky[o + SPAN]) * fx;
  const here = (top + (low - top) * fy) | 0;
  // Soft at the edges, so the rain shades off across the country rather than
  // stopping at a line, and so a front brings a rising and falling of it.
  return here < WET ? 0 : Math.min(1000, (here - WET) * 5);
}
const OPEN = 2;   // millimetres a day off the surface of standing water, about
                  // 700mm a year, which is what a temperate pond loses
export const RULE_VERSION = 10;

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

/**
 * Where the sea stands, in millimetres against the datum worldgen was drawn to.
 * The one thing in this world that moves on the scale of an era: a few hundred
 * years from trough to peak, thirty metres either way at the extremes, which is
 * a sixth of the continent's area. At low water the islands join the mainland
 * and the rivers cut down to a lower outlet; at high water the deltas drown.
 *
 * Anchored so that it is exactly zero at tick zero for any seed, because a
 * world that has been running to one datum should not find the sea somewhere
 * else the moment these rules arrive. Memoised on the day, since every cell in
 * every pass asks for it.
 */
const TIDE = 25000;   // millimetres at the far end of the swing
const ERA = 40000;    // ticks of noise, so a swing is a century or three
let seaAt = -1, seaOf = 0, seaIs = 0;

export function sea(tick: number, seed: number): number {
  if (tick !== seaAt || seed !== seaOf) {
    seaAt = tick;
    seaOf = seed;
    // Stretched away from the middle, for the same reason the weather is: two
    // points of value noise sit near the middle most of the time, and a sea
    // that never leaves the middle is a sea that never goes anywhere.
    const swing = (t: number) => clamp((vnoise(t / ERA, 2.5, seed + 3571) - 0.5) * 1.9, -0.5, 0.5);
    seaIs = ((swing(tick) - swing(0)) * TIDE) | 0;
  }
  return seaIs;
}

/**
 * Whether the sea stands over a cell. Bedrock below the datum is not the same
 * question: a river that fills its own mouth with silt builds ground that the
 * sea no longer covers, which is what a delta is. Worldgen leaves ~185 such
 * cells around the shore to begin with, where the weathered soil already
 * stands above the water.
 */
export const submerged = (w: World, i: number) =>
  w.elev[i] * 100 + w.soil[i] <= sea(w.tick, w.seed);

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
    }
  }
  // weathering: flat ground keeps soil, steep ground sheds it
  for (let i = 0; i < CELLS; i++) {
    let slope = 0;
    for (const j of neighbours(i)) slope = Math.max(slope, Math.abs(elev[i] - elev[j]));
    soil[i] = clamp(1400 - slope * 5, 0, 1400);
    // the same question submerged() asks — and the sea is at the datum on the
    // first day by construction, so there is nothing to subtract for it here
    if (elev[i] <= 0) water[i] = Math.max(0, -(elev[i] * 100 + soil[i]));
  }
  const world = { seed, tick: 0, ruleVersion: RULE_VERSION, elev, soil, water, veg, flow, rain };
  // Rainfall is the wind's answer to the shape of the land, so it is asked here
  // too rather than left empty until the first tick. There used to be a noise
  // field in its place, which nothing has read since the wind arrived.
  winds(world);
  return world;
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
const front = new Int32Array(BURN_CAP * 8);   // the edge of the fire
const fires: number[] = [];

// Burns outward from the strike through anything dry enough to carry it. A
// cell goes bare when it catches rather than when it joins the queue, so the
// duplicate entries the front collects find no fuel left and quietly do
// nothing, which is what keeps a cell from burning twice.
function burn(w: World, at: number) {
  const { veg, water, soil } = w;
  let n = 0, burnt = 0;
  front[n++] = at;
  // The next cell to catch is any cell on the edge, not the oldest or the
  // newest. Taking the newest sends the fire down one diagonal and scars the
  // country with straight lines; taking the oldest advances every side at the
  // same rate and burns a rectangle. Taking one at random off the whole edge
  // grows the blunt, ragged, roughly round patch a fire actually leaves.
  while (n > 0 && burnt < BURN_CAP) {
    const r = (hash2(at, burnt, w.tick + w.seed) * n) | 0;
    const i = front[r];
    front[r] = front[--n];   // whoever was last takes the empty place
    if (veg[i] < 2000) continue;                   // burnt already, or no fuel
    if (water[i] - (soil[i] >> 3) > 0) continue;   // a river or a lake stops it
    veg[i] = 0;
    burnt++;
    for (const j of neighbours(i)) {
      if (veg[j] >= 2000 && n < front.length) front[n++] = j;
    }
  }
}

// ---- weather --------------------------------------------------------------
// Every day in this world was the same day. A fixed rain map makes forest
// country and grass country, which is geography; what it cannot make is
// history, because a world whose weather never changes reaches a state and
// then keeps it. The map is now multiplied by a number that drifts — one long
// swing over about forty years and a shorter one over about seven, so wet
// decades and dry ones arrive, and not on a schedule anyone could set a clock
// by. Noise over time rather than a wave, for the same reason the terrain is
// noise and not a grid.
const WET_LOW = 80, WET_HIGH = 145;    // percent of what the map says

/**
 * What a cell can carry: the smallest of the rain that falls on it, the soil
 * it has to root in, and how wet that soil is. Out here in the open rather
 * than inline in the tick, because it is the rule that makes forest country
 * and grass country and the only honest way to ask whether it still does is
 * to ask it, not to run a century of weather past it and read the tea leaves.
 */
export function carry(falls: number, soil: number, damp: number): number {
  // The drought term pivots where it does because that is where the land
  // actually sits: with the water balance corrected, soil moisture runs from a
  // quarter of capacity on the ridges to the brim in the valley floors, median
  // a little over 40%. Pivoting at 60%, as it did while every cell stood
  // saturated, would make drought the binding limit nearly everywhere and
  // there would be no forest outside a valley bottom.
  return Math.min(clamp((falls - 85) * 110, 0, VEG_MAX), soil * 6,
                  damp >= 45 ? VEG_MAX : damp * 222);
}

/** How fast a cell that can carry this much fills in, in a day. */
export const fills = (cap: number) => 1 + ((cap / 4000) | 0);

/** How wet this particular day is, as a percentage of the world's rainfall. */
export function weather(tick: number, seed: number): number {
  const slow = vnoise(tick / 4380, 0.5, seed + 8191);   // a dozen years
  const fast = vnoise(tick / 1095, 1.5, seed + 6733);   // about three
  // Stretched away from the middle and clipped at the ends. Two noise values
  // averaged sit near the middle almost always, which gave a century whose
  // wettest year and driest year were twenty percent apart — weather nobody
  // would notice. Clipping is not a defect either: it is what a drought is,
  // several years pinned at the bottom rather than passing through it.
  const t = clamp((slow * 0.75 + fast * 0.25 - 0.5) * 1.9 + 0.5, 0, 1);
  return (WET_LOW + (WET_HIGH - WET_LOW) * t) | 0;
}

// ---- drainage -------------------------------------------------------------
// A river is not the water that happened to move today. That dies in the first
// pit it meets, and there are ~260 pits on this continent — under 1% of the
// land, but enough to chop it into ~260 basins, so nothing ever gathered more
// than a few hundred cells and the longest reach was about thirty. A river is
// where the land says water goes.
//
// Priority-flood raises every pit to the level of its own outlet, which leaves
// a surface that drains to the sea from everywhere; the drainage above a cell
// is then one pass down that surface. Both are recomputed every RIVER_EVERY
// days rather than daily, because the network moves at the speed of erosion —
// and because the answer rides in the packed world between times, so a world
// that restarts mid-run redraws on the same day it would have anyway.

const RIVER_EVERY = 64;
const FAR = 0x7fffffff;
const fill = new Int32Array(CELLS);   // the surface once every pit is full
const to = new Int32Array(CELLS);     // the neighbour each cell drains into
const drop = new Int32Array(CELLS);   // cells in the order the flood reached them
const acc = new Int32Array(CELLS);    // rain gathered from everything upstream
const heap = new Int32Array(CELLS);
let heapN = 0;

// Ties break on index, so the flood is the same flood on every machine.
const above = (a: number, b: number) => (fill[a] !== fill[b] ? fill[a] > fill[b] : a > b);

function heapPush(i: number) {
  let c = heapN++;
  heap[c] = i;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (!above(heap[p], heap[c])) break;
    const t = heap[p]; heap[p] = heap[c]; heap[c] = t;
    c = p;
  }
}

function heapPop(): number {
  const top = heap[0];
  heap[0] = heap[--heapN];
  let p = 0;
  for (;;) {
    const l = p * 2 + 1, r = l + 1;
    let m = p;
    if (l < heapN && above(heap[m], heap[l])) m = l;
    if (r < heapN && above(heap[m], heap[r])) m = r;
    if (m === p) break;
    const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
    p = m;
  }
  return top;
}

// ---- weather in the map ---------------------------------------------------
// Where the rain falls, as against how much of it falls this decade. It used
// to be a noise field laid over the terrain with no reference to it, so the dry
// hearts of the continent were dry for no reason a reader could see. Now the
// land makes its own rainfall: air comes off the sea carrying water, gives some
// up wherever it is forced to climb, and arrives on the far side of a range
// with little left. The desert is downwind of the mountains, and when a range
// wears down over centuries the shadow behind it fades with it.
//
// Wind from the north-west, resolved into its two components: one sweep west to
// east, one north to south, averaged. A single direction leaves the map in
// stripes, since each line of cells would be independent of the ones beside it.
const SEA_GAIN = 30;    // water picked up crossing a cell of open sea
const LAND_GAIN = 10;    // and off the land itself, which is what keeps an
                        // interior from being a desert by distance alone
const HOLD = 1200;      // the most the air will carry
const FALL = 6;         // thousandths of the load that falls on level ground
const LIFT = 4;        // and per metre of climb
const SOAK = 40;       // the most one cell can wring out of the air
const LOOK = 6;        // cells of upwind ground the climb is measured over
const BASE = 60;        // rain that arrives on weather fronts, wherever you are
const CROWN = 25;       // tenths: the most one cell may take of the mean, clipped
const TARGET = 135;     // mean rainfall over land, to hold the world's tuning
const wet = new Int32Array(CELLS);
const blur = new Int32Array(CELLS);

function winds(w: World) {
  const { elev, soil, rain } = w;
  const surface = (i: number) => elev[i] * 100 + soil[i];
  wet.fill(0);
  // `step` is the stride into the wind: one cell along the row, then one row.
  for (const stride of [1, SIZE]) {
    for (let line = 0; line < SIZE; line++) {
      let held = 0;
      const first = stride === 1 ? line * SIZE : line;
      for (let k = 0; k < SIZE; k++) {
        const i = first + k * stride;
        if (submerged(w, i)) {
          held = Math.min(HOLD, held + SEA_GAIN);
          continue;
        }
        held = Math.min(HOLD, held + LAND_GAIN);
        // How steeply the ground has been rising for the last few cells, in
        // metres per cell. Measured against the cell immediately upwind it
        // answers for every bump in the noise, and the rain map comes out a
        // relief drawing — bright on each north-west face — rather than a
        // climate, which belongs to whole ranges and not to single cells.
        const back = k < LOOK ? k : LOOK;
        const up = back === 0 ? 0
          : Math.max(0, surface(i) - surface(i - back * stride)) / (1000 * back) | 0;
        let part = FALL + up * LIFT;
        if (part > SOAK) part = SOAK;
        const fell = ((held * part) / 1000) | 0;
        held -= fell;
        wet[i] += fell;
      }
    }
  }
  // Scaled so the land's mean rainfall stays where the growth rules were tuned
  // for it: the wind moves rain about, it does not make more of it. Twice,
  // because the first scale is computed before the floor and the ceiling have
  // had their say and they move the mean it was aiming for.
  // Rain drifts. Averaging each cell with its neighbours is the cheapest
  // honest way to say so, and it keeps the map from carrying the grain of the
  // terrain it came from.
  blur.set(wet);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      let sum = blur[i], n = 1;
      for (const j of neighbours(i)) { sum += blur[j]; n++; }
      wet[i] = (sum / n) | 0;
    }
  }
  let land = 0, raw = 0;
  for (let i = 0; i < CELLS; i++) if (!submerged(w, i)) { land++; raw += wet[i]; }
  if (land === 0) return;
  // The windward face of a coastal range takes an absurd share of the sweep —
  // the air arrives full and gives up a fifth of it in one cell — so the top is
  // clipped at two and a half times the mean. Rainfall saturates; a place can
  // only be so wet, and without this a tenth of the land pins at the ceiling
  // while a quarter of it sits on the floor.
  const roof = ((raw / land) * CROWN) / 10 | 0;
  for (let i = 0; i < CELLS; i++) if (wet[i] > roof) wet[i] = roof;
  // Then a base that owes nothing to the terrain, because rain also arrives on
  // fronts, and a scale on the rest so the land's mean stays where the growth
  // rules were tuned for it: the wind moves rain about, it does not make more
  // of it. Twice round, because the floor and the ceiling move the mean that
  // the first scale was aiming at.
  let scale = 1000;
  for (let pass = 0; pass < 2; pass++) {
    let sum = 0;
    for (let i = 0; i < CELLS; i++) {
      if (submerged(w, i)) continue;
      sum += clamp(BASE + (((wet[i] * scale) / 1000) | 0), 20, 255);
    }
    const want = (TARGET - BASE) * land;
    const got = Math.max(1, sum - BASE * land);
    // Bounded because it is a ratio of sums: on a map where almost nothing
    // falls — a single land cell, or land only in the row the sweep starts on —
    // `got` collapses to 1 and this climbs into the millions, and a large
    // enough product comes back through `| 0` as a negative number.
    scale = clamp(((scale * want) / got) | 0, 1, 1_000_000);
  }
  for (let i = 0; i < CELLS; i++) {
    rain[i] = clamp(BASE + (((wet[i] * scale) / 1000) | 0), 20, 255);
  }
}

// Soil moves downhill without waiting for rain. Frost lifts it, roots prise it,
// animals kick it, and gravity takes the rest: on any slope the loose material
// creeps, faster the steeper it is. This is the other half of a valley — the
// river cuts the line, creep grades the ground on either side of it and rounds
// off what the noise of worldgen left sharp. Run with the drainage rather than
// daily, at a pass's worth each time, because nothing here moves in a day.
const CREEP = 5;      // ten-thousandths of the fall between two cells, per pass
const CLIFF = 6000;   // millimetres of fall past which creep no longer quickens

// A slope fails into the river that undercut it, and dams it.
//
// This is the one rule in the world that can make a closed basin. Everything
// else grades the land down — sediment fills pits, creep rounds them off, and
// tectonics is excluded from the tick by design. Before this rule the 246
// depressions worldgen leaves were a gift the world spent: 170 left by year
// ten, 25 by year two hundred, and a single cell of standing water. With it the
// count climbs instead — 366 by year twenty and 433 by year one hundred, with
// 296 cells under standing water against the 53 the same world had without.
//
// Written from the channel rather than from the hillside, which is the whole
// of what makes it work. Asked the obvious way round — take the steepest
// faces on the continent and let them fail downhill — it dams nothing,
// because steepness and drainage are anti-correlated here: of the 547 faces
// with a thirty-metre drop, exactly one had a stream at the foot of it, and
// the trunk valleys that carry the water are broad and gentle. Sending the
// debris down the gully to look for water was no better; the walk stalls on
// the first flat, and the median face cannot reach a channel carrying more
// than one cell's worth of rain. Undercutting is the real mechanism anyway: a
// river cuts the toe out of the slope above it, saturated ground on that
// slope lets go, and the channel is buried — which is why landslide dams sit
// on rivers rather than wherever the ground happens to be steepest.
//
// The debris arrives as bedrock, not soil, and that also decides whether the
// rule works. Delivered as soil a dam is a sponge and a snack: field capacity
// is soil/8, so six metres of debris holds 750mm of water against the sky and
// no pond forms, and `carve` takes loose material first, so the stream cuts
// it within a pass. Measured that way it raised the depression count to 225
// at year thirty against the baseline's 119 and still left the standing water
// *lower* — more basins, drier world. So rock moves as rock and soil as soil,
// each conserved in its own unit, and nothing converts.
const DAMS = 500;         // drainage past which a channel is worth damming. Set
                          // at the trunk rivers instead, the dams were cut as
                          // fast as they were built: the bigger the stream, the
                          // more cutting power stands against what blocks it
const SCARP = 6000;       // millimetres a face must stand above the channel
const SHED = 1;           // the face fails to the level of the channel below it,
                          // so the channel rises by the whole height it stood
                          // under. Anything less is cut straight back out: BITE
                          // lets a river take four metres of bedrock in one
                          // pass, and a third of the face height came to 3.6-5.6m,
                          // so every dam of that size went in the pass that
                          // built it and the basin count moved by three in
                          // thirty years
const SLIDE_ODDS = 0.100; // per undercut channel per pass of 64 days. A slope
                          // that stayed wet would go inside two years, but the
                          // wet precondition is intermittent and the eligible
                          // faces are few: the continent buries about twenty
                          // channels a year at this figure
const slides: number[] = [];   // face, channel and rock, decided before any of it moves

export function slump(w: World) {
  const { elev, soil, water, veg, flow } = w;
  const level = sea(w.tick, w.seed);
  slides.length = 0;
  for (let i = 0; i < CELLS; i++) {
    if (flow[i] <= DAMS) continue;
    const here = elev[i] * 100 + soil[i];
    if (here <= level) continue;
    // The highest slope standing over this reach, and it has to be wet. Ground
    // holding all it can is ground with no friction left, which is why real
    // slopes fail in the wet and not in the drought — and it ties the one rule
    // that builds relief to the weather.
    let face = -1, top = here + SCARP;
    for (const j of neighbours(i)) {
      if (water[j] < soil[j] >> 3) continue;
      const there = elev[j] * 100 + soil[j];
      if (there > top) { top = there; face = j; }
    }
    if (face < 0) continue;
    // Roots hold the face together, as they hold the riverbed and the hillside.
    const odds = (SLIDE_ODDS * VEG_MAX) / (VEG_MAX + veg[face] * 3);
    if (hash2(i, w.tick, w.seed + 2311) >= odds) continue;
    // Decided against the ground as it stood and applied afterwards, for the
    // same reason fires are collected rather than lit where they start: a
    // slide that ran as it was found would bury a channel that a later cell
    // was still measuring itself against, so what failed would depend on
    // which way the scan happened to be going.
    // Measured on the rock, not on the surface. The loose soil goes as well as
    // the rock, so taking the whole surface difference in bedrock and then
    // sending the soil after it cuts the face past the channel by exactly its
    // own soil depth — it fails *to* the level below it, not through it.
    const rock = ((elev[face] - elev[i]) / SHED) | 0;
    slides.push(face, i, rock > 0 ? rock : 0);
  }
  for (let k = 0; k < slides.length; k += 3) {
    const face = slides[k], dam = slides[k + 1];
    let rock = slides[k + 2];
    // A ridge cell can stand over two channels and be picked by both, and the
    // second of those was measured against ground that has already gone. Never
    // stand the ground on its head: a face no longer above its channel has
    // nothing left to give it.
    if (elev[face] * 100 + soil[face] <= elev[dam] * 100 + soil[dam]) continue;
    // Only what fits. What will not fit stays on the face rather than being
    // quietly destroyed — the ground has to balance. Soil needs the guard;
    // rock does not, and a clamp on it would be dead code dressed as caution:
    // the amount is elev[face] - elev[dam], so the channel lands exactly where
    // the face was and the face exactly where the channel was, both of which
    // were representable a moment ago. Neither end can leave Int16.
    const loose = Math.min(soil[face], 65535 - soil[dam]);
    if (rock <= 0 && loose <= 0) continue;
    elev[face] -= rock;
    elev[dam] += rock;
    soil[face] -= loose;
    soil[dam] += loose;
    veg[face] = 0;                               // a fresh scar is bare rock
    veg[dam] = 0;                                // and the channel is buried
  }
}

const was = new Uint16Array(CELLS);   // the soil as it stood when the pass began
const side = new Int32Array(8);       // where this cell is shedding to
const share = new Int32Array(8);      // and how much it would send each way

function crawl(w: World) {
  const { elev, soil, veg } = w;
  const level = sea(w.tick, w.seed);
  // Read from a copy, write to the live ground. Read and write the same array
  // and a cell can pass on soil that only arrived this pass, which it can only
  // do from the side the scan came from — creep would run faster downhill to
  // the south-east than to the north-west, for no reason but the loop order.
  was.set(soil);
  for (let i = 0; i < CELLS; i++) {
    const have = was[i];
    const here = elev[i] * 100 + have;
    if (have === 0 || here <= level) continue;
    let n = 0, demand = 0;
    for (const j of neighbours(i)) {
      // A neighbour under the sea is the shoreline, not its own bed: soil that
      // creeps to the water's edge is gone, and how deep the water is beyond
      // has nothing to do with how fast the hillside above it moves. Measured
      // the other way, the drop into deep water sets the rate all round the
      // coast and the continent wears a ring of bare rock.
      const there = elev[j] * 100 + was[j];
      let fall = here - (there > level ? there : level);
      if (fall <= 0) continue;
      // And past sixty metres in one cell it is a face rather than a hillside.
      // Left proportional, the steepest ground sheds soil faster than bedrock
      // can weather into it and all of it goes to bare rock.
      if (fall > CLIFF) fall = CLIFF;
      // Roots hold the ground here as they hold it in the riverbed.
      let move = (((fall * CREEP) / 10000) * VEG_MAX) / (VEG_MAX + veg[i] * 3) | 0;
      if (move > fall >> 3) move = fall >> 3;   // never stand the ground on its head
      if (move <= 0) continue;
      side[n] = j;
      share[n] = move;
      n++;
      demand += move;
    }
    for (let k = 0; k < n; k++) {
      // A cell with less soil than it would shed loses the same fraction on
      // every side, rather than filling the first sides the loop happens to
      // reach and leaving the rest of the hill standing.
      let move = demand > have ? ((share[k] * have) / demand) | 0 : share[k];
      const j = side[k];
      if (move > 65535 - soil[j]) move = 65535 - soil[j];
      if (move <= 0) continue;
      soil[i] -= move;
      soil[j] += move;
    }
  }
}

/** Redraws the drainage network into `flow`, in rain per cell per day. */
function drain(w: World) {
  const { elev, soil, rain, flow } = w;
  const wet = weather(w.tick, w.seed);
  winds(w);        // where the rain falls, given the shape of the land today
  crawl(w);        // before the flood, so it fills the surface creep just made
  slump(w);        // and before it too, so a new dam ponds on the pass it forms
  flow.fill(0);
  load.fill(0);   // nothing is in transit between passes, so a restart is clean
  heapN = 0;
  // The sea is the outlet and the only thing already at its final height.
  for (let i = 0; i < CELLS; i++) {
    if (!submerged(w, i)) { fill[i] = FAR; continue; }
    fill[i] = elev[i] * 100 + soil[i];
    heapPush(i);
  }
  // The flood needs somewhere to drain to. There is always sea on this map —
  // the tide reaches half the depth worldgen clamps the floor at, and the
  // border is forced to that floor — but a world with none would leave every
  // cell unvisited and every receiver pointing at nothing, so in that case the
  // lowest cell stands in as the outlet.
  if (heapN === 0) {
    let low = 0;
    for (let i = 1; i < CELLS; i++) {
      if (elev[i] * 100 + soil[i] < elev[low] * 100 + soil[low]) low = i;
    }
    fill[low] = elev[low] * 100 + soil[low];
    heapPush(low);
  }
  let n = 0;
  while (heapN > 0) {
    const i = heapPop();
    drop[n++] = i;
    for (const j of neighbours(i)) {
      if (fill[j] !== FAR) continue;   // already spoken for: this is the mark
      const base = elev[j] * 100 + soil[j];
      // A millimetre above whatever let the water out, so that a filled pit is
      // a slope rather than a plateau and the water on it knows which way to go
      fill[j] = base > fill[i] ? base : fill[i] + 1;
      heapPush(j);
    }
  }
  // Downhill on the filled surface. The cell that let this one out is always
  // strictly below it, so there is always somewhere to go and it reaches the sea.
  for (let i = 0; i < CELLS; i++) {
    let best = -1, low = fill[i];
    for (const j of neighbours(i)) if (fill[j] < low) { low = fill[j]; best = j; }
    to[i] = best;
    // What is falling now, not what the map says: a river is thinner in a dry
    // decade. The pattern is the land's and does not move; only the size does.
    acc[i] = submerged(w, i) ? 0 : ((rain[i] * wet) / 100) | 0;
  }
  // Highest first, so everything upstream of a cell has already reported in —
  // its drainage, and the sediment it is carrying.
  for (let k = n - 1; k >= 0; k--) {
    const i = drop[k];
    if (to[i] >= 0) acc[to[i]] += acc[i];
    flow[i] = Math.min(65535, acc[i] >> 6);
    carve(w, i);
  }
}

// What a river can carry past a cell: its discharge times the steepness of the
// ground under it. Carrying less than that, it takes the difference out of the
// bed; carrying more, it drops the difference. That one rule is the whole
// shape of a river valley — a gorge where the water is fast, a floodplain
// where it slows, and a fan of everything it was carrying where it meets the
// sea, because the sea has no slope and so no capacity at all.
const CARRY = 260;      // the divisor that sets how fast the land wears down
const BITE = 40;        // decimetres of bedrock one pass may cut, so no cliff
const load = new Int32Array(CELLS);   // sediment in transit, millimetres

function carve(w: World, i: number) {
  const { elev, soil, veg } = w;
  const j = to[i];
  // The sea is where everything lands: no slope, no capacity, and the river
  // has arrived. Whatever it was still carrying builds up at the mouth.
  if (j < 0 || submerged(w, i)) {
    // A cell still under the sea holds at most fifty metres of water above it,
    // so there is always room in the soil for what one pass can bring; the
    // clamp is a floor under an arithmetic accident, not a real case.
    soil[i] = Math.min(65535, soil[i] + load[i]);
    load[i] = 0;
    return;
  }
  // The fall the water feels, which is the fall on the surface it is following.
  // Shifted apart before multiplying: discharge and fall together overrun a
  // 32-bit integer on the steep half of a big river.
  const fall = fill[i] - fill[j];
  const room = fall > 0 ? (((w.flow[i] >> 3) * (fall >> 3)) / CARRY) | 0 : 0;
  // Where the flood had to raise the surface — a lake, or a flat it had to
  // tilt by a millimetre a cell to get the water off — the water stands above
  // the ground rather than on it, so it cuts nothing and drops what it has.
  // It is also where the course is least trustworthy: across a filled flat the
  // routing runs dead straight to the outlet, and erosion let loose on that
  // carves a diagonal scar across the country that no river would.
  const bed = fill[i] === elev[i] * 100 + soil[i];
  if (load[i] > room || !bed) {
    // Only what the ground can take. A basin floor that has filled to the top
    // of what a cell can hold does not make the rest of the load disappear —
    // it carries on downstream, the way it would over a bar it has built.
    const settle = bed ? load[i] - room : load[i];   // slack water puts it down
    const held = Math.min(settle, 65535 - soil[i]);
    soil[i] += held;
    load[i] -= held;
  } else {
    // Roots hold the ground the same way they hold the moisture.
    let want = ((room - load[i]) * VEG_MAX) / (VEG_MAX + veg[i] * 3) | 0;
    const off = Math.min(want, soil[i]);   // loose material goes first
    soil[i] -= off;
    load[i] += off;
    want -= off;
    // and only a river that has run out of soil to take cuts into the rock
    if (want >= 100 && elev[i] > 0) {
      const cut = Math.min((want / 100) | 0, BITE, elev[i]);
      elev[i] -= cut;
      load[i] += cut * 100;
    }
  }
  load[j] += load[i];
  load[i] = 0;
}

/** One world-day. Rain, flow, erosion, deposition, growth, fire. */
export function step(w: World): void {
  const { elev, soil, water, veg, rain } = w;
  fires.length = 0;
  // Where the water goes, as against where today's water is. Rare, and pinned
  // to the day rather than to how long this copy of the world has been awake.
  // Also on the first tick under new rules, since a world that arrives carrying
  // some older idea of what `flow` meant should not draw rivers from it.
  if (w.tick % RIVER_EVERY === 0 || w.ruleVersion !== RULE_VERSION) drain(w);

  // rain, then evaporation. Vegetation holds moisture back.
  const wet = weather(w.tick, w.seed);
  const level = sea(w.tick, w.seed);
  const slide = fronts(w);
  for (let i = 0; i < CELLS; i++) {
    if (elev[i] * 100 + soil[i] > level) {
      // A sixteenth of the day's rainfall weight reaches the ground as water,
      // about 3 metres a year on the median cell, where an eighth was seven
      // metres — wetter than any rainforest — and
      // — the part that showed — evaporation takes 12% of the store a day, so
      // the store settled at eight times the daily input, above what the soil
      // can hold. Every cell that was not desert therefore stood brim full with
      // the surplus running off, and the damp reading was 100% over seven
      // eighths of the land. Now the store settles below the brim and follows
      // the rain and the ground it sits on: ridges and rain shadows dry, valley
      // floors wet because what falls upslope arrives in them.
      //
      // And it arrives in storms rather than as a daily drizzle. That is not
      // decoration: soil below field capacity soaks up an average day entirely,
      // so a world watered evenly never spills, and a world that never spills
      // has no runoff, no standing water and no lakes in it, however much rain
      // falls. A storm lands eight days' worth at once, the soil takes what it
      // can hold and the rest runs off — which is how a landscape can be half
      // dry and still have rivers in it. Drawn for a patch of country rather
      // than a cell, because weather arrives as fronts.
      const day = (((rain[i] * wet) / 100) | 0) >> 4;
      const pour = falling(i, slide);
      if (pour > 0) {
        water[i] = Math.min(65535, water[i] + ((day * STORMS * pour) / 1000 | 0));
      }
      // Two different things dry out at two different rates. Water held in the
      // soil goes as a share of what is there, faster where there is no canopy
      // over it. Water standing on the surface goes as a depth, a few
      // millimetres a day off the top, the way a pond does — taken as a share
      // of the whole store instead, a lake a metre deep lost 160mm a day,
      // fifty-eight metres a year, and no pit on the continent could hold
      // water long enough to become one.
      const cap = soil[i] >> 3;
      const stored = water[i] < cap ? water[i] : cap;
      const standing = water[i] - stored;
      const dries = (stored * (160 - ((veg[i] * 80) / VEG_MAX | 0))) / 1000 | 0;
      water[i] = Math.max(0, water[i] - dries - (standing < OPEN ? standing : OPEN));
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

    height[i] = elev[i] * 100 + soil[i] + water[i];
    height[lowest] = elev[lowest] * 100 + soil[lowest] + water[lowest];
  }

  for (let i = 0; i < CELLS; i++) {
    // the sea is a sink: it refills to its own level and swallows what arrives
    if (elev[i] * 100 + soil[i] <= level) {
      water[i] = Math.max(0, level - (elev[i] * 100 + soil[i]));
      veg[i] = Math.max(0, veg[i] - 50);
      continue;
    }
    // Bedrock weathers into soil: the same stuff in another state, so the
    // ground does not rise — it only becomes something that can be carried.
    // Taking the rock rather than conjuring the soil is what lets a slope
    // retreat: creep strips the loose material off it, the bare rock beneath
    // weathers in turn, and the hillside works its way back. It stops once
    // there is soil enough to bury the rock, which is also what keeps flat
    // country from deepening for ever and strangling the rivers — they fell
    // by two thirds over forty years when soil ran away to 3000mm. Staggered
    // by cell, so the continent does not weather all on the same morning.
    if (soil[i] < 1200 && elev[i] > 0 && (w.tick + i) % 1600 === 0) {
      soil[i] += 100;
      elev[i] -= 1;
    }
    const s = soil[i], held = s >> 3, excess = water[i] - held;
    // Roots reach the top of the profile, not the bottom of it. Water held
    // below them is still held — it is why the runoff calculation uses the
    // whole depth — but it is not water the plant can drink, and counting it
    // would make the deepest ground the driest: a delta with twenty-five
    // metres of silt on it would read as a desert and stay bare forever.
    const root = (s < 1200 ? s : 1200) >> 3;
    // What this cell can carry. Rainfall is the permanent term: it varies two to
    // one across the continent and never moves, so it is what makes forest
    // country and grass country different places rather than different years.
    // Soil gates the young world, which has not yet enough of it to root a
    // forest. Drought bites only when the ground falls well below what it can
    // hold — moisture alone was no use as the main term, because saturated soil
    // reads 100% nearly everywhere for the first forty years and every cell
    // then looks identical, which is how the whole continent used to cross from
    // barren to grass to forest in one year each and never change again.
    const damp = root > 0 ? ((water[i] * 100) / root) | 0 : 0;
    // Against the rain of the day rather than the map, so that what the land
    // can carry rises and falls with the decades and the margins move.
    const falls = ((rain[i] * wet) / 100) | 0;
    const cap = carry(falls, s, damp);
    let d: number;
    if (excess > 1200) d = -20;              // drowned
    else if (s < 80) d = -5;                 // bare rock
    else if (veg[i] > cap) d = -3;           // more canopy than the ground keeps
    else d = fills(cap);                     // good ground fills in faster
    veg[i] = clamp(veg[i] + d, 0, VEG_MAX);
    // Dry canopy, long odds, drawn from the cell and the day so the same world
    // burns in the same places. Collected rather than lit here: a fire that
    // spread while the growth loop was still running would reach cells that
    // had not grown yet today, and the rules would depend on the loop order.
    if (veg[i] > 5000 && falls < 150 && hash2(i, w.tick, w.seed) < FIRE_ODDS) fires.push(i);
  }
  for (const i of fires) burn(w, i);
  w.tick++;
  w.ruleVersion = RULE_VERSION;   // stamp the rules that actually ran this tick
}

// ---- classification and wire format ---------------------------------------

export const Biome = { Ocean: 0, Lake: 1, River: 2, Rock: 3, Barren: 4, Grass: 5, Forest: 6, Peak: 7 } as const;

export function biome(w: World, i: number): number {
  if (submerged(w, i)) return Biome.Ocean;
  // 600mm standing over the soil rather than 1200: the old figure was set
  // when the median cell took seven metres of rain a year and a pit could
  // hold a metre and a half of water against the sky.
  if (w.water[i] - (w.soil[i] >> 3) > 600) return Biome.Lake;
  if (w.flow[i] > 200) return Biome.River;
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
    ["island", (i) => !submerged(w, i), false],
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

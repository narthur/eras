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
// across the map, soaking a swathe of it for a few days at a time, on a track
// that wanders north and south as it goes. Drawn on a coarse lattice once a
// tick and read off it smoothly, because a storm drawn per patch of ground owes
// nothing to the patch beside it and the country ends up tiled in hard
// eight-cell squares — which is exactly what it looked like. The wander is not
// decoration either: a front that only ever moved along x froze the long-run
// rainfall into latitude bands, and the forests grew in rows. See `fronts`.
const STORMS = 8;   // the long-run ratio of dry days to wet at a given place
const PATCH = 8;    // cells across a patch of weather
const DRIFT = 2;    // days for the front to move on by one patch
const WET = 645;    // above this the front is raining, in thousandths
export const VEER = 400;   // days for the storm track to swing north and back again
const SWAY = 3;     // patches it wanders either side of its mean latitude
const SPAN = SIZE / PATCH + 2;

/**
 * Today's weather front: the coarse lattice it is drawn on, and how far into it
 * the country sits, east and north.
 */
export type Sky = { lattice: Int32Array; slideX: number; slideY: number };

/**
 * Where the storm track sits today, north or south of its mean, in patches.
 * A triangle: down to -SWAY, up to SWAY at the turn, back again by VEER. A
 * triangle rather than a sine because the sim must land on the same bit in
 * every engine it runs in, and Math.sin is implementation-defined where these
 * four operations are exact.
 */
export function wave(tick: number): number {
  const lap = tick % VEER;
  const climb = lap < VEER / 2 ? lap : VEER - lap;
  return (climb * 4 * SWAY) / VEER - SWAY;
}

/**
 * Draws today's weather front and returns how far into it the country sits,
 * east and north. Handed back rather than left in module state: `falling` is
 * useless without it, and a reader that has to be told the order to call two
 * functions in is one refactor away from getting it wrong.
 */
function fronts(tick: number, seed: number): Sky {
  // Negative on purpose. A positive tick term reads the field at
  // x/PATCH + tick/DRIFT, which walks the pattern toward smaller x — west,
  // into the weather instead of along with it. The wind here comes from the
  // north-west, so the front has to cross eastward: PATCH/DRIFT cells a day.
  const offX = -tick / DRIFT;
  // The track wanders. Without this the weather only ever moves along x, so a
  // cell and its neighbour due east take the same path through the field a few
  // days apart: over years they collect the same rain, and the country dries
  // and greens in latitude bands a patch tall. Any drift that is the same
  // everywhere freezes whatever lies along it — the cure is not a different
  // heading but a heading that changes, so each cell traces a ribbon through
  // the weather instead of a line.
  const offY = wave(tick);
  const baseX = Math.floor(offX), baseY = Math.floor(offY);
  const lattice = new Int32Array(SPAN * SPAN);
  for (let ny = 0; ny < SPAN; ny++) {
    for (let nx = 0; nx < SPAN; nx++) {
      lattice[ny * SPAN + nx] =
        (hash2(nx + baseX, ny + baseY, seed + 7717) * 1000) | 0;
    }
  }
  return { lattice, slideX: offX - baseX, slideY: offY - baseY };
}

/** How hard it is raining at a cell, in thousandths of a storm. */
function falling(sky: Sky, i: number): number {
  const { lattice, slideX, slideY } = sky;
  const px = (i % SIZE) / PATCH + slideX, ix = px | 0, fx = px - ix;
  const py = ((i / SIZE) | 0) / PATCH + slideY, iy = py | 0, fy = py - iy;
  const o = iy * SPAN + ix;
  const top = lattice[o] + (lattice[o + 1] - lattice[o]) * fx;
  const low = lattice[o + SPAN] + (lattice[o + SPAN + 1] - lattice[o + SPAN]) * fx;
  const here = (top + (low - top) * fy) | 0;
  // Soft at the edges, so the rain shades off across the country rather than
  // stopping at a line, and so a front brings a rising and falling of it.
  return here < WET ? 0 : Math.min(1000, (here - WET) * 5);
}

/**
 * Today's rain over the whole map, in thousandths of a storm. Exported so the
 * weather can be asked whether it has a preferred direction without simulating
 * a world to look at the trees, which is where the last such fault was found
 * and much too late.
 */
export function rainfall(tick: number, seed: number, out: Int32Array): void {
  const sky = fronts(tick, seed);
  for (let i = 0; i < CELLS; i++) out[i] = falling(sky, i);
}

const OPEN = 2;   // millimetres a day off the surface of standing water, about
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

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A world and everything else the day produced. `step` hands this back rather
 * than leaving the events and the water accounts in module variables for a
 * caller to come and collect: a global that has to be drained in the right
 * order is a race waiting for a second caller, and this world has already lost
 * a day's events to exactly that.
 */
export type Day = { world: World; events: Event[]; budget: Budget };

/**
 * A world is six typed arrays and three numbers, and copying the lot costs
 * 0.021ms against a 13.8ms tick — two parts in a thousand. That is the whole
 * reason `step` can be pure: nothing here is too big to copy, it only looked
 * that way.
 */
const copy = (w: World): World => ({
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

// ---- the chronicle --------------------------------------------------------
// What happened, as against what is. The world state is a photograph: it holds
// the dammed valley but not the day the slope came down, and a world that is
// only ever a photograph has no history in it to read. So the tick writes down
// the few things it does that are discrete enough to have a date.
//
// Only rare things. Erosion and growth happen everywhere every day and belong
// to the picture, not to the record; a chronicle that logged them would be a
// second copy of the world with none of its clarity. Features are left out for
// a different reason: they are derived and unnamed, so the same river arriving
// and departing as it flickers across a threshold would bury everything real.

export type EventKind = "fire" | "slide" | "sea";
export type Event =
  { tick: number; rules: number; kind: EventKind; x: number; y: number; size: number };

// The canonical list, exported so nothing downstream keeps its own copy of it.
// A reader that filters by kind and a writer that adds one have to be able to
// disagree loudly rather than quietly.
export const EVENT_KINDS = ["fire", "slide", "sea"] as const satisfies readonly EventKind[];

/**
 * One thing that happened, ready to be handed up. `at` is a cell, or -1 for the
 * things that happen to the whole world.
 *
 * A constructor and not a sink. This used to push onto a module-level array
 * that the caller drained, which meant the log had to be capped in case nobody
 * ever did, and meant a second caller draining between two ticks silently took
 * the first one's history. Neither problem exists once the day hands back what
 * it did: there is nothing to accumulate and nothing to race for.
 */
function happening(w: World, kind: EventKind, at: number, size: number): Event {
  const x = at < 0 ? -1 : at % SIZE, y = at < 0 ? -1 : (at / SIZE) | 0;
  // The rules that are running, not `w.ruleVersion`, which is stamped at the end
  // of the tick and so still says yesterday's on the first day under new ones.
  // Old rows stay labelled with the rules of their era, which is the only way a
  // log that outlives its own thresholds stays self-describing.
  return { tick: w.tick, rules: RULE_VERSION, kind, x, y, size };
}

// The sea moves by the century, so it has no day of its own to be recorded on.
// Noted when it crosses a five-metre mark instead, which is the coarsest thing
// the world does and the only one that dates an era rather than an afternoon.
//
// Yesterday is asked for rather than remembered. `sea` is a pure function of
// the day and the seed, so there is nothing here to keep between ticks and
// nothing a restart can lose: a world resumed from storage works out the mark
// it was standing on the same way a world that never stopped does.
const MARK = 5000;   // millimetres between one notch and the next
const notchOf = (level: number) => Math.trunc(level / MARK);   // symmetric about zero

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

// Where the sea has got to: under its level, and joined to the edge of the map
// by water all the way. Being low is not enough and never was — a hollow walled
// off by higher ground is a hollow, not an arm of the sea, however deep it
// lies. Measured on the live world: at an ordinary tide this is four cells in
// thirty-five thousand and reads as a rounding error, but the sea swings thirty
// metres and when it falls the sill at a bay's mouth comes up dry. At year 155
// of seed 20260910 that cut a bay of five hundred and thirty-three cells off
// from the ocean in a single step, which the height test went on calling ocean:
// a Caspian, labelled and filled as though it were still open water.
//
// Eight-connected, because water runs to any of the eight neighbours — the same
// reason a river is traced that way. Drawn at most twice in a day and cached in
// between, so nothing in a tick depends on how far through the tick it is
// asked: once for the rain, which reads the land as it stood at dawn, and again
// after creep and slope failure have moved it, because those are the only rules
// that move ground and the flood surface is taken after them too.
//
// ponytail: a fill over every cell, every day, for 8.6% of the tick. The
// coastline is a slow fact like `flow` is, so this could ride the drain pass
// every 64 days instead and cost a sixty-fourth of that — at the price of a
// mask up to 64 days stale, and of a second rule about when it is valid. Worth
// it when the tick rate or the burst size makes 8.6% hurt, and not before.
/** Which cells the open sea reaches. One per cell, 1 for sea. */
export type Coast = Uint8Array;

/**
 * Draws the coastline on the ground as it stands. A value, handed to whoever
 * asked: every rule in the tick is given the mask it should be reading rather
 * than fetching it from a cache that may or may not still describe the ground
 * under it. That cache is how a bay dammed in the morning got seeded into the
 * afternoon's flood as open sea — the mask said water, the heights said dam,
 * and the two came from different halves of the same day.
 *
 * ponytail: a fill over every cell, and it runs twice a day. The coastline is
 * a slow fact like `flow` is, so it could ride the drain pass every 64 days
 * instead — at the price of a mask up to 64 days stale, and of a second rule
 * about when it is valid. Worth it when the tick rate or the burst size makes
 * it hurt, and not before.
 */
export function coastline(w: World): Coast {
  const level = sea(w.tick, w.seed);
  const under = (i: number) => w.elev[i] * 100 + w.soil[i] <= level;
  // Mutable inside, and only inside: a flood fill is a queue and a visited set
  // by its nature, and there is no way to express one as a fold over 65,536
  // cells that does not rebuild both on every pop. Neither array outlives this
  // call, and the mask is the only thing that leaves it.
  const reached: Coast = new Uint8Array(CELLS);
  const shore = new Int32Array(CELLS);
  let head = 0, tail = 0;
  // The rim of the map is open sea wherever it is under the water. Worldgen
  // forces the border to the floor, so in practice the whole rim qualifies.
  for (let x = 0; x < SIZE; x++) {
    for (const i of [x, x + (SIZE - 1) * SIZE, x * SIZE, x * SIZE + SIZE - 1]) {
      if (!reached[i] && under(i)) { reached[i] = 1; shore[tail++] = i; }
    }
  }
  // Neighbours inlined rather than walked with the generator. This runs over
  // every cell of every day, and the generator alone cost a third of the tick.
  while (head < tail) {
    const i = shore[head++];
    const x = i % SIZE, y = (i / SIZE) | 0;
    const x0 = x > 0 ? -1 : 0, x1 = x < SIZE - 1 ? 1 : 0;
    const y0 = y > 0 ? -SIZE : 0, y1 = y < SIZE - 1 ? SIZE : 0;
    for (let dy = y0; dy <= y1; dy += SIZE) {
      for (let dx = x0; dx <= x1; dx++) {
        const j = i + dy + dx;
        if (j === i || reached[j]) continue;
        if (w.elev[j] * 100 + w.soil[j] <= level) { reached[j] = 1; shore[tail++] = j; }
      }
    }
  }
  return reached;
}

/**
 * Whether the sea stands over a cell. Bedrock below the datum is not the same
 * question: a river that fills its own mouth with silt builds ground that the
 * sea no longer covers, which is what a delta is. Worldgen leaves ~185 such
 * cells around the shore to begin with, where the weathered soil already
 * stands above the water.
 */
let chartOf: World | undefined;   // by identity: two worlds can share a tick
let chartAt = -1;                 // and a seed and not share a coastline
let charted: Coast = new Uint8Array(0);

/**
 * For readers outside the tick — `biome`, `features`, the tests, anything
 * looking at a world that is sitting still. Memoised on the world and the day,
 * because a caller classifying all 65,536 cells should pay for one fill.
 *
 * Nothing inside `step` uses this, and that is the point. The rules are handed
 * a `Coast` instead, so the cache can never be read beside ground that has
 * moved since it was drawn: within a day the ground moves twice, and this key
 * cannot see either. Outside a day it is not moving at all, which is exactly
 * when memoising on it is safe.
 */
export function submerged(w: World, i: number): boolean {
  if (chartOf !== w || chartAt !== w.tick) {
    charted = coastline(w);
    chartOf = w;
    chartAt = w.tick;
  }
  return charted[i] === 1;
}

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
  winds(world, coastline(world));
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


// Fire is the only thing that happens to a world that has finished growing.
// Without it the map is done the day the last cell matures; with it the land
// keeps a patchwork of ages, because a burn grows back at its own cell's rate.
// Measured on seed 20260910 over sixty years, once the chronicle could be read:
// thirteen fires, the first in year fifteen — about one every five years. And
// twelve of the thirteen burnt exactly BURN_CAP cells, because spread was
// deterministic and the connected fuel region was ninety per cent of the
// continent. That is what `catches` below was written to fix.
// Five times what it was, because most strikes now come to nothing. The old
// figure was set when spread was certain and every strike became a fire of
// exactly the cap; with the odds of catching what they are, about a third of
// strikes take hold at all and the world was down to three fires a century on
// one seed, which is a world that has stopped happening.
const FIRE_ODDS = 0.0000025;   // per dry canopy cell per day
const FUEL = 2000;             // canopy below this will not carry a fire at all
const DRY = 40;                // percent of root-zone moisture below which
                               // nothing is holding the fire back but the fuel
const BURN_CAP = 6000;         // cells: a backstop, not the rule. See `catches`

/**
 * Whether a cell takes fire when the flames reach it. This is the whole of what
 * decides how big a fire is, and it used to be decided by nothing: every
 * neighbour with fuel caught, so a fire ate its entire connected fuel region
 * and the only thing that ever stopped one was the cap. Measured at year 30,
 * that region was 17,872 cells — ninety per cent of everything burnable on the
 * continent, and thirty-six times the cap. So every fire was exactly the cap.
 *
 * Now a cell catches or it does not, on its own fuel and its own dryness, once
 * per day: a spread that is a coin flip per cell is site percolation, and
 * percolation has a threshold. Below it a fire dies where it started; above it
 * it runs to the edge of the dry ground; near it the size varies over orders of
 * magnitude, which is both what real fires do and the only way this world gets
 * a fire worth writing down. Dry decades put the continent above the threshold
 * and wet ones below, so fire is tied to the weather exactly as slope failure
 * is, and for the same reason.
 */
function catches(w: World, i: number): number {
  const root = Math.min(w.soil[i], 1200) >> 3;
  const damp = root > 0 ? Math.min(100, ((w.water[i] * 100) / root) | 0) : 0;
  // The drought term pivots, as the growth rule's does. Ground at half of what
  // it can hold is not wet — forests burn in that — and taken proportionally it
  // halved the odds everywhere and put the whole continent under the threshold,
  // where the biggest fire in four hundred strikes was thirty-six cells. It
  // bites from DRY upward instead, and only ground near saturation puts a fire
  // out on its own.
  const dry = damp >= 100 ? 0 : damp <= DRY ? 1 : (100 - damp) / (100 - DRY);
  // Thin grass at a fifth of full canopy catches at a fifth the rate, so the
  // open ground between two woods is a barrier without being declared one.
  // No coefficient in front of it: bone-dry closed canopy takes fire every
  // time, which is the honest ceiling and leaves nothing here to tune. The
  // odds simply are how much there is to burn, times how dry it is.
  return (w.veg[i] * dry) / VEG_MAX;
}

// Burns outward from the strike through anything dry enough to carry it.
//
// Nothing joins the edge twice — `queued` sees to that — so the fuel check at
// the top of the loop is not there to weed out duplicates any more, as it was
// before. What it still catches is the strike itself, which goes on the edge
// unconditionally: `burn` is exported, and a caller may strike bare ground.
//
// Both arrays are made per fire and thrown away with it. They used to be module
// -level and shared, which meant `queued` could not simply hold a flag — it
// held a stamp from a counter that rose with every fire ever lit, because
// clearing 65,536 cells per strike was the thing being avoided. That counter
// wrapped after two thousand million fires, which was five thousand million
// centuries away and still a thing that had to be written down and reasoned
// about. A fresh array is already zero, so the flag is just a flag.
export function burn(w: World, at: number): number {
  const { veg, water, soil } = w;
  const front = new Int32Array(CELLS);
  const queued = new Uint8Array(CELLS);
  let n = 0, burnt = 0;
  queued[at] = 1;
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
    if (veg[i] < FUEL) continue;                   // burnt already, or no fuel
    if (water[i] - (soil[i] >> 3) > 0) continue;   // a river or a lake stops it
    // Keyed on the cell and the day, so a cell that would not catch does not
    // get a second answer when the flames arrive from another side. That is
    // what makes this percolation rather than a slow way of burning everything.
    if (hash2(i, w.tick, w.seed + 6151) >= catches(w, i)) continue;
    veg[i] = 0;
    burnt++;
    for (const j of neighbours(i)) {
      // Once each. The edge used to hold a cell once per side it was reachable
      // from, which gave the well-connected middle of a fire several times the
      // chance of being drawn next and pulled the shape inward.
      if (veg[j] >= FUEL && queued[j] === 0) { queued[j] = 1; front[n++] = j; }
    }
  }
  return burnt;
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
/**
 * The flood's working surface, made fresh for each pass and thrown away after:
 * what each cell fills to, the neighbour it drains into, and what the river
 * going past it is carrying. These three are read together by everything the
 * pass does, so they travel together rather than as three module arrays that
 * happen to be indexed alike.
 */
type Flood = { fill: Int32Array; to: Int32Array; load: Int32Array };

const flooding = (): Flood => ({
  fill: new Int32Array(CELLS),
  to: new Int32Array(CELLS),
  load: new Int32Array(CELLS),   // nothing is in transit between passes
});

/**
 * A binary heap of cells, lowest surface first, for the priority flood.
 *
 * Mutable inside, deliberately, and this is the clearest case of it in the
 * file: a heap is an array sifted in place, it is pushed and popped 65,536
 * times a pass, and a persistent one would allocate a fresh spine on every one
 * of those. The array is made here and closed over, so there is exactly one
 * heap per flood and no way to hold a stale one — which is what the module
 * -level `heap` and `heapN` offered, reset by hand at the top of `drain`.
 *
 * `fill` is read live on purpose: the flood raises it as it goes, and the
 * ordering has to see that.
 */
const rising = (fill: Int32Array) => {
  const heap = new Int32Array(CELLS);
  let n = 0;
  // Ties break on index, so the flood is the same flood on every machine.
  const above = (a: number, b: number) => (fill[a] !== fill[b] ? fill[a] > fill[b] : a > b);
  return {
    get size() { return n; },
    push(i: number) {
      let c = n++;
      heap[c] = i;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (!above(heap[p], heap[c])) break;
        const t = heap[p]; heap[p] = heap[c]; heap[c] = t;
        c = p;
      }
    },
    pop(): number {
      const top = heap[0];
      heap[0] = heap[--n];
      let p = 0;
      for (;;) {
        const l = p * 2 + 1, r = l + 1;
        let m = p;
        if (l < n && above(heap[m], heap[l])) m = l;
        if (r < n && above(heap[m], heap[r])) m = r;
        if (m === p) break;
        const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
        p = m;
      }
      return top;
    },
  };
};

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
function winds(w: World, coast: Coast) {
  const { elev, soil, rain } = w;
  const surface = (i: number) => elev[i] * 100 + soil[i];
  // Both local to the sweep. `wet` is carried across the passes below — a
  // sweep upwind, a blur, a ceiling and two scalings, each reading what the
  // last one wrote — so it is one array written five times rather than five
  // arrays, and neither of them leaves this function.
  const wet = new Int32Array(CELLS);
  // `step` is the stride into the wind: one cell along the row, then one row.
  for (const stride of [1, SIZE]) {
    for (let line = 0; line < SIZE; line++) {
      let held = 0;
      const first = stride === 1 ? line * SIZE : line;
      for (let k = 0; k < SIZE; k++) {
        const i = first + k * stride;
        if (coast[i] === 1) {
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
  const blur = Int32Array.from(wet);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      let sum = blur[i], n = 1;
      for (const j of neighbours(i)) { sum += blur[j]; n++; }
      wet[i] = (sum / n) | 0;
    }
  }
  let land = 0, raw = 0;
  for (let i = 0; i < CELLS; i++) if (coast[i] === 0) { land++; raw += wet[i]; }
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
      if (coast[i] === 1) continue;
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
// count climbs instead — 380 by year twenty and 446 by year one hundred, with
// 296 cells under standing water at year fifty against the 53 the same world
// had without. The year matters and is easy to leave off: the lakes are not
// monotonic, and the same run reads 584 cells at year twenty and 130 at year
// two hundred.
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
                          // faces are few: the continent buries about forty
                          // channels a year at this figure
// Metres of rock below which a slide is not news. Measured over forty years:
// the continent sheds about fifty a year, median fifteen metres, and a record
// that took all of them would be a list of one kind of thing with a fire lost
// somewhere in it. Four a year clear this bar, which is a pace that takes
// months of watching to fill a panel rather than an afternoon. The ground still
// moves either way — this decides what is written down, not what happens.
//
// Forty years and not three, which is what this said before and is long enough
// to mislead: the young world's slides are smaller and rarer, so three years
// gives a median of ten metres and barely one a year over the bar. The rivers
// have to cut before there is much for them to undercut.
const LOUD = 40;

export function slump(w: World, coast: Coast = coastline(w)): Event[] {
  const { elev, soil, water, veg, flow } = w;
  const told: Event[] = [];
  // Face, channel and rock, decided before any of it moves, three numbers to a
  // slide. Collected first and applied after, so a slide that ran as it was
  // found could not bury a channel a later cell was still measuring itself
  // against — the reason this is two loops and not one.
  const slides: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (flow[i] <= DAMS) continue;
    const here = elev[i] * 100 + soil[i];
    if (coast[i] === 1) continue;
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
    // Filed against the channel rather than the face: what makes this worth
    // recording is the river that stopped, not the hillside that is now short.
    // In metres of rock, which is what elev counts in tens of.
    const fell = (rock / 10) | 0;
    if (fell >= LOUD) told.push(happening(w, "slide", dam, fell));
  }
  return told;
}


function crawl(w: World, coast: Coast) {
  const { elev, soil, veg } = w;
  const level = sea(w.tick, w.seed);
  // Read from a copy, write to the live ground. Read and write the same array
  // and a cell can pass on soil that only arrived this pass, which it can only
  // do from the side the scan came from — creep would run faster downhill to
  // the south-east than to the north-west, for no reason but the loop order.
  // The soil as it stood when the pass began. Creep has to read one surface and
  // write another, or a cell is fed by a neighbour that already crept this
  // morning and the hillside walks in whichever direction the loop runs.
  const was = Uint16Array.from(soil);
  const side = new Int32Array(8);    // where this cell is shedding to
  const share = new Int32Array(8);   // and how much it would send each way
  for (let i = 0; i < CELLS; i++) {
    const have = was[i];
    const here = elev[i] * 100 + have;
    if (have === 0 || coast[i] === 1) continue;
    let n = 0, demand = 0;
    for (const j of neighbours(i)) {
      // A neighbour under the sea is the shoreline, not its own bed: soil that
      // creeps to the water's edge is gone, and how deep the water is beyond
      // has nothing to do with how fast the hillside above it moves. Measured
      // the other way, the drop into deep water sets the rate all round the
      // coast and the continent wears a ring of bare rock.
      const there = elev[j] * 100 + was[j];
      // Soil that creeps to the water's edge is gone, and the sea's surface is
      // the floor under that — but only where the sea is. Into a dry hollow the
      // hillside sheds onto the hollow's own floor, however far below the
      // datum that floor happens to lie.
      const floor = coast[j] === 1 ? level : there;
      let fall = here - (floor > there ? floor : there);
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
/**
 * Hands back what the slides buried and the coastline as it stands after them,
 * because the caller needs both and the day is not over.
 */
function drain(w: World): { events: Event[]; coast: Coast } {
  const { elev, soil, rain, flow } = w;
  const wet = weather(w.tick, w.seed);
  const dawn = coastline(w);   // the land as it stood before anything moved it
  winds(w, dawn);              // where the rain falls, given the shape of it
  crawl(w, dawn);              // before the flood, so it fills the creep just made
  const told = slump(w, dawn); // and before that, so a new dam ponds on its own pass
  // Those two are the only things in a day that move the ground, and slump is
  // the one rule that can seal a channel. So the coastline is redrawn here, on
  // the ground as it now stands: the loop below takes each cell's height live
  // and its sea-or-not from the mask, and reading one from after the slide and
  // the other from before it is how a bay that was dammed this morning gets
  // seeded into the flood as open sea at the height of its own new dam.
  //
  // Two masks, both named, both passed. It used to be one cache invalidated by
  // hand between the two halves, and forgetting that line was a real bug.
  const coast = coastline(w);
  flow.fill(0);
  const flood = flooding();
  const { fill, to, load } = flood;
  const queue = rising(fill);
  // The sea is the outlet and the only thing already at its final height.
  for (let i = 0; i < CELLS; i++) {
    if (coast[i] === 0) { fill[i] = FAR; continue; }
    fill[i] = elev[i] * 100 + soil[i];
    queue.push(i);
  }
  // The flood needs somewhere to drain to. There is always sea on this map —
  // the tide reaches half the depth worldgen clamps the floor at, and the
  // border is forced to that floor — but a world with none would leave every
  // cell unvisited and every receiver pointing at nothing, so in that case the
  // lowest cell stands in as the outlet.
  if (queue.size === 0) {
    let low = 0;
    for (let i = 1; i < CELLS; i++) {
      if (elev[i] * 100 + soil[i] < elev[low] * 100 + soil[low]) low = i;
    }
    fill[low] = elev[low] * 100 + soil[low];
    queue.push(low);
  }
  const drop = new Int32Array(CELLS);   // cells in the order the flood reached them
  let n = 0;
  while (queue.size > 0) {
    const i = queue.pop();
    drop[n++] = i;
    for (const j of neighbours(i)) {
      if (fill[j] !== FAR) continue;   // already spoken for: this is the mark
      const base = elev[j] * 100 + soil[j];
      // A millimetre above whatever let the water out, so that a filled pit is
      // a slope rather than a plateau and the water on it knows which way to go
      fill[j] = base > fill[i] ? base : fill[i] + 1;
      queue.push(j);
    }
  }
  // Downhill on the filled surface. The cell that let this one out is always
  // strictly below it, so there is always somewhere to go and it reaches the sea.
  const acc = new Int32Array(CELLS);   // rain gathered from everything upstream
  for (let i = 0; i < CELLS; i++) {
    let best = -1, low = fill[i];
    for (const j of neighbours(i)) if (fill[j] < low) { low = fill[j]; best = j; }
    to[i] = best;
    // What is falling now, not what the map says: a river is thinner in a dry
    // decade. The pattern is the land's and does not move; only the size does.
    acc[i] = coast[i] === 1 ? 0 : ((rain[i] * wet) / 100) | 0;
  }
  // Highest first, so everything upstream of a cell has already reported in —
  // its drainage, and the sediment it is carrying.
  for (let k = n - 1; k >= 0; k--) {
    const i = drop[k];
    if (to[i] >= 0) acc[to[i]] += acc[i];
    flow[i] = Math.min(65535, acc[i] >> 6);
    carve(w, i, coast, flood);
  }
  return { events: told, coast };
}

// What a river can carry past a cell: its discharge times the steepness of the
// ground under it. Carrying less than that, it takes the difference out of the
// bed; carrying more, it drops the difference. That one rule is the whole
// shape of a river valley — a gorge where the water is fast, a floodplain
// where it slows, and a fan of everything it was carrying where it meets the
// sea, because the sea has no slope and so no capacity at all.
const CARRY = 260;      // the divisor that sets how fast the land wears down
const BITE = 40;        // decimetres of bedrock one pass may cut, so no cliff
function carve(w: World, i: number, coast: Coast, flood: Flood) {
  const { elev, soil, veg } = w;
  const { fill, to, load } = flood;
  const j = to[i];
  // The sea is where everything lands: no slope, no capacity, and the river
  // has arrived. Whatever it was still carrying builds up at the mouth.
  if (j < 0 || coast[i] === 1) {
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

// Where the day's water came from and went. Every line in the tick that changes
// `water` by anything other than moving it from one cell to another adds itself
// up here, so the total on the map can be reconciled against them exactly. It
// exists because the sea used to conjure water into any low hollow and nothing
// noticed for days: `ground is conserved` follows rock and soil, and no check
// followed water at all. It also catches the quieter thing — the ceilings at
// 65535 silently destroying what will not fit.
export type Budget = {
  rained: number;    // fell out of the sky
  dried: number;     // went back into it
  tide: number;      // the sea set it, being a sink and a source both
  spilled: number;   // lost at the Uint16 ceiling, which should be nothing
};
/**
 * Four running totals over a 65,536-cell pass. Kept as one mutable object made
 * fresh each day and handed back at the end of it: a reduce that returned a new
 * object per cell would allocate a quarter of a million of them a tick to
 * express four additions. This is the performance exception, and it is the
 * whole of it — the object never leaves the `step` that made it.
 */
const ledger = (): Budget => ({ rained: 0, dried: 0, tide: 0, spilled: 0 });

/** The water standing on the whole map, in millimetres. */
export function puddle(w: World): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) n += w.water[i];
  return n;
}

/**
 * One world-day: rain, flow, erosion, deposition, growth, fire. Takes the world
 * as it stands and hands back the next one, what happened in it, and where the
 * day's water came from and went. The world passed in is not touched.
 */
export function step(prev: World): Day {
  const w = copy(prev);
  const { elev, soil, water, veg, rain } = w;
  const events: Event[] = [];
  const day = ledger();
  // Where lightning struck, collected as the growth loop runs and lit after it.
  // Lighting them where they are found would let a fire spread into cells that
  // had not grown yet today, and the rules would depend on the loop order.
  const fires: number[] = [];
  // Where the water goes, as against where today's water is. Rare, and pinned
  // to the day rather than to how long this copy of the world has been awake.
  // Also on the first tick under new rules, since a world that arrives carrying
  // some older idea of what `flow` meant should not draw rivers from it.
  const dug = (w.tick % RIVER_EVERY === 0 || w.ruleVersion !== RULE_VERSION) ? drain(w) : undefined;
  if (dug) events.push(...dug.events);
  // The mask the rest of the day reads. On a drain day it is the one drawn
  // after the ground moved, which is what the old cache would have held; on
  // every other day nothing has moved the ground since yesterday, so a fresh
  // one is the same answer. Carried to the end of the tick deliberately: the
  // weathering below adds soil, and taking the coastline again after it would
  // be a different rule than the one this world has always run.
  const coast = dug ? dug.coast : coastline(w);

  // rain, then evaporation. Vegetation holds moisture back.
  const wet = weather(w.tick, w.seed);
  const level = sea(w.tick, w.seed);
  // Day one has no yesterday to have crossed anything from.
  if (w.tick > 0 && notchOf(level) !== notchOf(sea(w.tick - 1, w.seed))) {
    events.push(happening(w, "sea", -1, (level / 1000) | 0));
  }
  const sky = fronts(w.tick, w.seed);
  // The surface the runoff reads, and the order it reads it in. Both fill as
  // the rain loop below runs and are used by the pass after it, so they are
  // made here rather than inside either.
  const height = new Int32Array(CELLS);
  const order = new Int32Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    if (coast[i] === 0) {
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
      const fell = (((rain[i] * wet) / 100) | 0) >> 4;
      const pour = falling(sky, i);
      if (pour > 0) {
        const drop = (fell * STORMS * pour) / 1000 | 0;
        const was = water[i];
        water[i] = Math.min(65535, was + drop);
        day.rained += water[i] - was;
        day.spilled += drop - (water[i] - was);
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
      const before = water[i];
      water[i] = Math.max(0, before - dries - (standing < OPEN ? standing : OPEN));
      day.dried += before - water[i];
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
    const had = water[lowest];
    water[lowest] = Math.min(65535, had + t);
    day.spilled += t - (water[lowest] - had);

    height[i] = elev[i] * 100 + soil[i] + water[i];
    height[lowest] = elev[lowest] * 100 + soil[lowest] + water[lowest];
  }

  const dawn = Uint16Array.from(veg);   // the canopy every cell is seeded from, before any of it grows
  for (let i = 0; i < CELLS; i++) {
    // The sea is a sink: it refills to its own level and swallows what arrives.
    // Only where it has actually reached, though — filling every low cell put
    // water into hollows nothing could have carried it to, and conjured it
    // besides, since this is an assignment and not a transfer. A basin walled
    // off below sea level now takes rain like any other basin and ponds by the
    // same rules, which is what a Caspian is.
    if (coast[i] === 1) {
      const stood = water[i];
      water[i] = Math.max(0, level - (elev[i] * 100 + soil[i]));
      day.tide += water[i] - stood;
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
    // What the cell can hold, and then what its neighbours let it hold. A wood
    // makes its own weather — shade, humus, shelter from the wind — so ground
    // inside one carries canopy that the same ground in the open would not.
    // This is the term that can join two woods into one: the rate bonus alone
    // only got a cell to its own ceiling faster, and a ceiling set by rainfall
    // is why six hundred separate woods never became six.
    const cap = carry(falls, s, damp) + SHELTER * near(dawn, i);
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
  for (const i of fires) {
    const burnt = burn(w, i);
    // A strike that finds nothing to take is not an event; it is weather.
    if (burnt > 0) events.push(happening(w, "fire", i, burnt));
  }
  w.tick++;
  w.ruleVersion = RULE_VERSION;   // stamp the rules that actually ran this tick
  return { world: w, events, budget: day };
}

// A wood is a thing that spreads, and until now nothing in this world spread.
// Growth read the cell's own rain, its own soil and its own moisture and nothing
// else, so trees did not arrive from anywhere — they appeared wherever the
// ground would have them. The forest still came out clumped, because rainfall
// and soil are clumped, but it came out as six hundred separate woods with the
// largest holding a twentieth of the whole, and no rule existed that could ever
// have made one wood out of two.
//
// So a cell fills faster for every neighbour already carrying canopy. Read from
// a copy taken at dawn, for the same reason creep is: reading the live array
// lets a cell be seeded by a neighbour that only grew this morning, which it can
// only do from the side the scan came from, and the woods would then spread
// faster to the south-east than to the north-west for no reason but the loop.
const SEED_BAR = 4000;   // canopy a neighbour needs before it is seeding anything
const SHELTER = 450;     // canopy a seeding neighbour adds to what the ground
                         // can hold, so a wood closed on all sides lifts its
                         // ceiling by about a third of the maximum and no more.
                         //
                         // Added and not multiplied, which was the first attempt
                         // and the wrong shape. A ceiling of `carry() * 3` swamps
                         // rainfall, and rainfall is the whole term that makes
                         // forest country and grass country different places
                         // rather than different years. The continent went from
                         // a tenth forest to a third, reached a tenth before
                         // world-year eight where it used to take sixteen, burnt
                         // five times as often on the extra canopy, and — because
                         // roots hold the riverbed as they hold the hillside —
                         // cut its longest river in half. Added, it can only
                         // carry ground that was already close: a cell the rain
                         // would leave just short of forest becomes forest inside
                         // a wood, and a desert cell stays desert whatever stands
                         // around it.
function near(dawn: Uint16Array, i: number): number {
  const x = i % SIZE, y = (i / SIZE) | 0;
  const x0 = x > 0 ? -1 : 0, x1 = x < SIZE - 1 ? 1 : 0;
  const y0 = y > 0 ? -SIZE : 0, y1 = y < SIZE - 1 ? SIZE : 0;
  let n = 0;
  for (let dy = y0; dy <= y1; dy += SIZE) {
    for (let dx = x0; dx <= x1; dx++) {
      if (dy === 0 && dx === 0) continue;
      if (dawn[i + dy + dx] >= SEED_BAR) n++;
    }
  }
  return n;
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

export function features(w: World, min = FEATURE_MIN): Feature[] {
  // All three are made here and die here. `seen` is stamped rather than cleared
  // between the five kinds — one array, five passes — which is worth a counter
  // when the alternative is clearing 65,536 cells five times. It starts at zero
  // because it is new, so the stamp cannot be mistaken for a previous call's.
  const seen = new Int32Array(CELLS);
  const queue = new Int32Array(CELLS);
  const kindAt = new Uint8Array(CELLS);
  let pass = 0;
  const visit = (i: number, belongs: (i: number) => boolean, tail: number): number => {
    if (seen[i] === pass || !belongs(i)) return tail;
    seen[i] = pass;
    queue[tail] = i;
    return tail + 1;
  };

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

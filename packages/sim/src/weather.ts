import { CELLS, SIZE, type World, clamp, hash2, neighbours, vnoise } from "./grid.ts";
import { type Coast } from "./sea.ts";

// Rain arrives as fronts: a field of wet and dry country that drifts east
// across the map, soaking a swathe of it for a few days at a time, on a track
// that wanders north and south as it goes. Drawn on a coarse lattice once a
// tick and read off it smoothly, because a storm drawn per patch of ground owes
// nothing to the patch beside it and the country ends up tiled in hard
// eight-cell squares — which is exactly what it looked like. The wander is not
// decoration either: a front that only ever moved along x froze the long-run
// rainfall into latitude bands, and the forests grew in rows. See `fronts`.
export const STORMS = 8;   // the long-run ratio of dry days to wet at a given place

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
export function fronts(tick: number, seed: number): Sky {
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
export function falling(sky: Sky, i: number): number {
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

export const OPEN = 2;   // millimetres a day off the surface of standing water, about

// Every day in this world was the same day. A fixed rain map makes forest
// country and grass country, which is geography; what it cannot make is
// history, because a world whose weather never changes reaches a state and
// then keeps it. The map is now multiplied by a number that drifts — one long
// swing over about forty years and a shorter one over about seven, so wet
// decades and dry ones arrive, and not on a schedule anyone could set a clock
// by. Noise over time rather than a wave, for the same reason the terrain is
// noise and not a grid.
const WET_LOW = 80, WET_HIGH = 145;    // percent of what the map says

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

export function winds(w: World, coast: Coast) {
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

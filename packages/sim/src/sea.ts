import { CELLS, SIZE, type World, clamp, vnoise } from "./grid.ts";

// The sea moves by the century, so it has no day of its own to be recorded on.
// Noted when it crosses a five-metre mark instead, which is the coarsest thing
// the world does and the only one that dates an era rather than an afternoon.
//
// Yesterday is asked for rather than remembered. `sea` is a pure function of
// the day and the seed, so there is nothing here to keep between ticks and
// nothing a restart can lose: a world resumed from storage works out the mark
// it was standing on the same way a world that never stopped does.
const MARK = 5000;   // millimetres between one notch and the next

export const notchOf = (level: number) => Math.trunc(level / MARK);   // symmetric about zero

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
// reason a river is traced that way. Drawn at most twice in a day, and drawn
// afresh each time rather than cached: once for the rain, which reads the land
// as it stood at dawn, and again after creep and slope failure have moved it,
// because those are the only rules that move ground and the flood surface is
// taken after them too. Which of the two a rule gets is in its arguments.
//
// ponytail: a fill over every cell, 0.70ms against an ordinary tick — about a
// twentieth of it, and twice that on the day the drainage redraws. The
// coastline is a slow fact like `flow` is, so this could ride the drain pass
// every 64 days instead and cost a sixty-fourth as much — at the price of a
// mask up to 64 days stale, and of a second rule about when it is valid. Worth
// it when the tick rate or the burst size makes it hurt, and not before.
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
 * Runs once on most days and twice on the one day in 64 the drainage redraws,
 * which is the only day anything moves the ground. Cost and the case for
 * cutting it are with `RIVER_EVERY`, where the rest of that decision lives.
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

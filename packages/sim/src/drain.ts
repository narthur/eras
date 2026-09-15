import { type Event } from "./chronicle.ts";
import { crawl, slump } from "./erosion.ts";
import { CELLS, VEG_MAX, type World, neighbours } from "./grid.ts";
import { type Coast, coastline } from "./sea.ts";
import { weather, winds } from "./weather.ts";

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

export const RIVER_EVERY = 64;

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

/** Redraws the drainage network into `flow`, in rain per cell per day. */
/**
 * Hands back what the slides buried and the coastline as it stands after them,
 * because the caller needs both and the day is not over.
 */
export function drain(w: World): { events: Event[]; coast: Coast } {
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
  const { fill, to } = flood;   // `load` is carve's alone; it travels in `flood`
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

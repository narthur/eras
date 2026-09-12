// What the world is doing, as a dozen numbers. One measurement, read by two
// callers: `bench` prints it so two runs can be put side by side, `character`
// asserts ranges on it so a run can say for itself whether the world still has
// the shape it is supposed to have.
//
// It lives out here because it was written three times before this — once in a
// scratch file for each rule that needed judging, and thrown away each time.
//
// Nothing here is part of the simulation. It reads a world and never writes one.

import {
  generate, biome, Biome, features, submerged, FEATURE_MIN,
  CELLS, SIZE, VEG_MAX, type World,
} from "./index.ts";

export type Vitals = {
  year: number;
  land: number;
  basins: number;      // closed depressions: cells with no lower neighbour
  lakes: number;       // cells reading as standing water
  ponded: number;      // total standing water, in millimetres
  damp: number;        // median root-zone moisture, percent of what it can hold
  saturated: number;   // share of land holding all it can, 0..1
  fall: number;        // median drop to the lowest neighbour, in millimetres
  soil: number;        // mean loose material over land, in millimetres
  rock: number;        // share of land bare enough to read as rock, 0..1
  veg: number;         // mean canopy over land, 0..1
  grass: number;
  forest: number;
  edge: number;        // forest cells' non-forest neighbours, per forest cell,
                       // 0..4. The clump measure: a few big blobs sit near 0.5,
                       // the same area as salt-and-pepper noise approaches 4
  patches: number;     // how many separate woods there are
  biggest: number;     // share of all forest sitting in the largest one, 0..1
  river: number;       // the longest reach
  island: number;      // the largest island, in cells
  span: number;        // and roughly how far across it is, for a reach to be
                       // measured against something other than a magic number
  slides: number;      // channels buried since the last reading
  ground: number;      // total rock and soil. Must not move
};

const neighbours4 = (i: number): number[] => {
  const x = i % SIZE, y = (i / SIZE) | 0;
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < SIZE - 1) out.push(i + 1);
  if (y > 0) out.push(i - SIZE);
  if (y < SIZE - 1) out.push(i + SIZE);
  return out;
};

/**
 * Reads the world. `was` is the bedrock as it stood at the previous reading,
 * which is the only way to count slides: every other rule in the tick lowers
 * bedrock, so a cell whose rock rose was buried by one and nothing else.
 */
export function vitals(w: World, year: number, was: Int16Array): Vitals {
  let basins = 0, lakes = 0, ponded = 0, ground = 0, soil = 0, veg = 0;
  let grass = 0, forest = 0, land = 0, slides = 0, saturated = 0, rock = 0;
  const falls: number[] = [], damps: number[] = [];
  const isForest = new Uint8Array(CELLS);

  for (let i = 0; i < CELLS; i++) {
    ground += w.elev[i] * 100 + w.soil[i];
    if (w.elev[i] > was[i]) slides++;
    if (submerged(w, i)) continue;
    land++;
    soil += w.soil[i];
    veg += w.veg[i];
    const b = biome(w, i);
    if (b === Biome.Lake) lakes++;
    if (b === Biome.Grass) grass++;
    if (b === Biome.Rock) rock++;
    if (b === Biome.Forest) { forest++; isForest[i] = 1; }
    const over = w.water[i] - (w.soil[i] >> 3);
    if (over > 0) ponded += over;
    // Moisture as the plants feel it: the root zone, not the whole profile.
    const root = Math.min(w.soil[i], 1200) >> 3;
    if (root > 0) {
      const damp = ((w.water[i] * 100) / root) | 0;
      damps.push(damp);
      if (damp >= 100) saturated++;
    }
    // The drop to the lowest neighbour. No neighbour lower is a closed basin.
    const here = w.elev[i] * 100 + w.soil[i];
    const x = i % SIZE, y = (i / SIZE) | 0;
    let low = here;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const t = w.elev[ny * SIZE + nx] * 100 + w.soil[ny * SIZE + nx];
        if (t < low) low = t;
      }
    }
    if (here === low) basins++; else falls.push(here - low);
  }

  // How ragged the woods are. Counted on the four square neighbours rather than
  // the eight, because a diagonal touch is not a shared edge and counting it
  // would make a perfect blob look fringed. A cell at the map's rim has fewer
  // neighbours to be unlike, which flatters the edges of the world slightly and
  // is not worth a special case at this size.
  let boundary = 0;
  for (let i = 0; i < CELLS; i++) {
    if (!isForest[i]) continue;
    for (const j of neighbours4(i)) if (!isForest[j]) boundary++;
  }

  // Every wood, not only the ones big enough to be worth a name.
  const woods = features(w, { ...FEATURE_MIN, forest: 1 })
    .filter((f) => f.kind === "forest");
  const largest = woods.reduce((n, f) => (f.size > n ? f.size : n), 0);

  falls.sort((a, b) => a - b);
  damps.sort((a, b) => a - b);
  const found = features(w);
  const river = found.find((f) => f.kind === "river");
  const island = found.filter((f) => f.kind === "island")
    .reduce((n, f) => (f.size > n ? f.size : n), 0);

  return {
    year,
    land,
    basins,
    lakes,
    ponded,
    damp: damps.length > 0 ? damps[damps.length >> 1] : 0,
    saturated: land > 0 ? saturated / land : 0,
    fall: falls.length > 0 ? falls[falls.length >> 1] : 0,
    soil: land > 0 ? soil / land : 0,
    rock: land > 0 ? rock / land : 0,
    veg: land > 0 ? veg / land / VEG_MAX : 0,
    grass,
    forest,
    edge: forest > 0 ? boundary / forest : 0,
    patches: woods.length,
    biggest: forest > 0 ? largest / forest : 0,
    river: river?.size ?? 0,
    island,
    span: Math.round(Math.sqrt(island)),
    slides,
    ground,
  };
}

/** A world at its beginning, and the bedrock to measure the first slide against. */
export const opening = (seed: number): [World, Int16Array] => {
  const w = generate(seed);
  return [w, Int16Array.from(w.elev)];
};

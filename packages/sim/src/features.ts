import { Biome, biome } from "./biome.ts";
import { CELLS, SIZE, type World } from "./grid.ts";
import { submerged } from "./sea.ts";

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

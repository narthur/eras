import { SIZE, VEG_MAX, clamp } from "./grid.ts";

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

export const SHELTER = 450;     // canopy a seeding neighbour adds to what the ground

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
export function near(dawn: Uint16Array, i: number): number {
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

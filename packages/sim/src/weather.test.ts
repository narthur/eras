// The weather, and the growth rule it feeds. Nothing here simulates a world:
// `wave`, `rainfall` and `carry` are all pure functions of their arguments, so
// this file is the fast one and runs in milliseconds.

import { describe, expect, it } from "vitest";
import { rainfall, wave, VEER, carry, fills, CELLS, SIZE } from "./index.ts";

describe("the storm track", () => {
  // The banding check below is an aggregate and a loose one: it catches the
  // wander going missing altogether and almost nothing else. Measured — a
  // sawtooth of the same amplitude that snaps back instead of folding, and a
  // VEER ten times too long, both sail through it. So the shape gets asked
  // about directly. Stated against itself rather than against SWAY, so the
  // constants stay free to move.
  const turn = wave(VEER / 2);

  it("stands north of its mean at the turn", () => {
    expect(turn, `the track should be north of its mean at the turn, ${turn}`).toBeGreaterThan(0);
    expect(wave(0), "and as far south at the start as north at the turn").toBe(-turn);
  });

  it("comes back to where it began", () => {
    expect(wave(VEER), "a lap should come back to where it began").toBe(wave(0));
  });

  it("folds at the turn rather than snapping back", () => {
    // A triangle folds; a sawtooth jumps. One period of steps, and the longest
    // must be no longer than the first — which is what the fold buys and what
    // snapping back at the wrap would break.
    const step1 = Math.abs(wave(1) - wave(0));
    let widest = 0;
    for (let t = 0; t < VEER * 2; t++) {
      widest = Math.max(widest, Math.abs(wave(t + 1) - wave(t)));
      expect(wave(t) >= wave(0) && wave(t) <= turn,
        `the track wandered off its range at ${t}: ${wave(t)}`).toBe(true);
    }
    expect(widest,
      `the track should fold at the turn, not snap: widest step ${widest} against ${step1}`).toBeLessThanOrEqual(step1 * 1.0000001);
  });
});

describe("the weather has no latitude", () => {
  // This is the one fault in the sim so far that no number caught and a person
  // did, by looking at the map and saying the forests were growing in rows.
  // They were: the front drifted along x and along nothing else, so every cell
  // in a row traced the same straight line through the weather field a few days
  // apart and collected the same rain over the years. Long-run rainfall became
  // a function of y alone, in bands a patch tall, frozen for the life of the
  // world, and neighbour-seeded growth printed them.
  //
  // Measured here and not on the trees on purpose. Forest run lengths were
  // tried first and are nearly blind to it — one seed in three separated, and
  // one separated the wrong way — because by the time rain has passed through
  // soil, a growth threshold and fire it is a shadow of the fault rather than
  // the fault. Asked of the rain directly, with no world to simulate, banded
  // reads about 20 and whole reads about 1, and the run takes a moment.
  const DAYS = 2000;

  it("covers several turns of the track", () => {
    // The one thing the wave checks above cannot see. Stated against itself, a
    // triangle stays a valid triangle whatever its period, so a VEER ten times
    // too long reads as correct there — and quietly leaves this window sampling
    // a quarter of one turn, where the ratio has not begun to settle and the
    // bar below stops meaning anything. Tie them together instead: whoever
    // moves VEER has to come back here and re-measure.
    expect(DAYS,
      `the banding window must cover several turns of the track: ${DAYS} days against a ${VEER}-day turn`).toBeGreaterThanOrEqual(VEER * 5);
  });

  it("does not band by latitude", () => {
    // Row spread against column spread, both relative to the mean so the units
    // cancel. Two thousand days and not one thousand: the wander takes VEER
    // days to come back round, so a window of two and a half turns has not
    // finished averaging and the ratio still swings with the seed. Ten seeds
    // run 0.64 to 1.84 at a thousand days and 0.39 to 1.07 at two thousand,
    // settling downward as the sway smooths along y. Which ten seeds matters at
    // the wide end — a different ten put the four-thousand-day ceiling half
    // again as high — so read these as the shape of the thing and not as
    // constants. The bar is only there to catch a return to banding, which is a
    // twentyfold departure and not a subtle one.
    const acc = new Float64Array(CELLS), today = new Int32Array(CELLS);
    for (let t = 0; t < DAYS; t++) {
      rainfall(t, 1234, today);
      for (let i = 0; i < CELLS; i++) acc[i] += today[i];
    }
    // acc is laid out y * SIZE + x, so spread(SIZE, 1) sums across x for each y
    // — one mean per row — and spread(1, SIZE) one mean per column. Getting the
    // two the wrong way round would swap the names and still print plausible
    // numbers.
    const spread = (outer: number, inner: number) => {
      let mu = 0, out = 0;
      const means: number[] = [];
      for (let x = 0; x < SIZE; x++) {
        let sum = 0;
        for (let y = 0; y < SIZE; y++) sum += acc[x * outer + y * inner];
        means.push(sum / SIZE);
        mu += sum / SIZE / SIZE;
      }
      for (const m of means) out += (m - mu) ** 2 / SIZE / (mu * mu);
      return out;
    };
    const [rows, cols] = [spread(SIZE, 1), spread(1, SIZE)];
    expect(rows,
      `rain must not band by latitude: row spread ${(rows * 1e4).toFixed(1)} against column ${(cols * 1e4).toFixed(1)}`).toBeLessThan(cols * 3);
  });
});

describe("what the ground can carry", () => {
  // The growth rule has to make places, not days: before it took account of the
  // cell, every adequate cell grew at the same rate to the same ceiling and the
  // whole continent crossed from barren to grass to forest in a single year.
  // Asked directly, because through a run it cannot be asked honestly: the
  // weather scales the whole map together, and in a wet decade the poorer
  // country catches up on purpose, so whether a given seed shows a gap over a
  // given year depends on the year rather than on the rule.
  const ROOTED = 1200, WET_SOIL = 100;   // deep enough soil, wet enough to drink

  it("separates forest country from grass country by rain", () => {
    expect(carry(150, ROOTED, WET_SOIL),
      "rain has to be what separates forest country from grass country").toBeGreaterThan(carry(110, ROOTED, WET_SOIL));
    expect(fills(carry(150, ROOTED, WET_SOIL)),
      "and it has to show in how fast the ground fills, not only in the ceiling").toBeGreaterThan(fills(carry(100, ROOTED, WET_SOIL)));
  });

  it("holds thin and dry ground back", () => {
    expect(carry(150, 200, WET_SOIL),
      "thin soil holds a place back whatever the sky is doing").toBeLessThan(carry(150, ROOTED, WET_SOIL));
    expect(carry(150, ROOTED, 30),
      "and drought bites ground that cannot hold what falls on it").toBeLessThan(carry(150, ROOTED, WET_SOIL));
    expect(carry(80, ROOTED, WET_SOIL), "nothing grows where nothing falls").toBe(0);
  });
});

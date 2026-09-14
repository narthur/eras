// The sea, and where the day's water came from and went.

import { describe, expect, it } from "vitest";
import { generate, step, sea, puddle, type World } from "./index.ts";
import { run } from "./fixtures.ts";

describe("the sea crossing a mark", () => {
  // It moves by the century, so a run that waited for one would cost minutes;
  // but `sea()` is pure in the tick and the seed, so the day it happens can be
  // found by arithmetic and the world set down on the eve of it.
  const MARK = 5000;   // must match the sim's own, or this test asks about nothing
  const notchOf = (t: number, seed: number) => Math.trunc(sea(t, seed) / MARK);
  let crossing = -1;
  for (let t = 1; t < 365 * 400 && crossing < 0; t++) {
    if (notchOf(t, 1234) !== notchOf(t - 1, 1234)) crossing = t;
  }

  it("happens at all within four centuries", () => {
    expect(crossing, "four centuries of this seed should move the sea five metres").toBeGreaterThan(0);
  });

  it("is written down once, dated, and pointing nowhere", () => {
    // Two days: the first is the eve, and it is what a world resumed from
    // storage has never had — a yesterday. The second is the day the sea
    // changes mark.
    const tide = generate(1234);
    tide.tick = crossing - 1;
    const turned = run(tide, 2)[1].filter((e) => e.kind === "sea");
    expect(turned.length, `one crossing at tick ${crossing}, got ${turned.length}`).toBe(1);
    expect(turned[0].tick, "dated the day it crossed").toBe(crossing);
    expect(turned[0].x, "the sea happens everywhere, so it points nowhere").toBe(-1);
    expect(turned[0].y, "and its y says so too").toBe(-1);
    expect(turned[0].size, "in metres against the datum").toBe((sea(crossing, 1234) / 1000) | 0);
  });

  it("is caught by a world only just picked up off the disk", () => {
    // This is the whole point of asking `sea` for yesterday instead of
    // remembering it: a restart used to cost the first crossing after it,
    // silently.
    const tide = generate(1234);
    tide.tick = crossing - 1;
    const turned = run(tide, 2)[1].filter((e) => e.kind === "sea");
    const resumed = generate(1234);
    resumed.tick = crossing;
    expect(run(resumed, 1)[1].filter((e) => e.kind === "sea"),
      "a world resumed on the day must report the crossing the same as one that ran into it").toEqual(turned);
  });

  it("says nothing on an ordinary day", () => {
    // Two steps, so the second of them is a day with a known yesterday rather
    // than one that only primes.
    const tide = generate(1234);
    tide.tick = crossing + 5;
    expect(run(tide, 2)[1].filter((e) => e.kind === "sea"),
      "a day that crosses no mark is not an event").toEqual([]);
  });
});

it("accounts for every millimetre of water", () => {
  // `ground is conserved` follows rock and soil, and nothing followed water
  // until the sea was caught conjuring it into hollows it could not reach. The
  // tick may only rain it, dry it, move it downhill, or hand it to the sea;
  // anything else is water from nowhere, and this is the line that says so.
  // Exact, every day, not a range.
  let acct: World = generate(4242);
  for (let t = 0; t < 200; t++) {
    const before = puddle(acct);
    const today = step(acct);
    acct = today.world;
    const b = today.budget;
    const after = puddle(acct);
    // Spilled is in the identity and not left out of it, so this line stays
    // true whatever the ceilings do. Leaving it out made the sum right only
    // because the next line says nothing spills, which is two claims wearing
    // one check.
    expect(after - before,
      `day ${t}: the map holds ${after - before}mm more, the accounts say ${b.rained - b.dried + b.tide - b.spilled}mm`)
      .toBe(b.rained - b.dried + b.tide - b.spilled);
    // The ceilings are a floor under an arithmetic accident, not a working
    // part. A world that hits them is destroying water and calling it drainage.
    expect(b.spilled, `day ${t}: ${b.spilled}mm went over the 65535 ceiling`).toBe(0);
  }
});

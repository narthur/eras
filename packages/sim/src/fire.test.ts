// Fire, on a world already grown over: rare enough that an ordinary run sees
// none, so this one starts mature. Deterministic, so it either burns for this
// seed or it never will.

import { beforeAll, describe, expect, it } from "vitest";
import { pack, submerged, burn, RULE_VERSION, CELLS, SIZE, type World, type Event } from "./index.ts";
import { mature, same } from "./fixtures.ts";

let f: World, hist: Event[], lit: Event[], burnt: number, dryLand: number;

beforeAll(() => {
  [f, hist] = mature();
  // Fires only: a made-mature world still has rivers cutting slopes out from
  // under each other, so slides turn up here too.
  lit = hist.filter((e) => e.kind === "fire");
  burnt = [...f.veg].filter((v, i) => !submerged(f, i) && v < 500).length;
  dryLand = 0;
  for (let i = 0; i < CELLS; i++) if (!submerged(f, i)) dryLand++;
});

describe("a mature dry world", () => {
  it("burns somewhere in a year", () => {
    expect(burnt, "a mature dry world should burn somewhere in a year").toBeGreaterThan(0);
  });

  it("is not cleared by a year of fire", () => {
    // A fifth, where this used to say a twentieth. The old figure was the cap's
    // shadow: every fire burnt exactly BURN_CAP, so a year's total was a
    // multiple of it and the bound could be tight. Fire is percolation now and
    // this fixture is the most flammable world there is — every cell closed dry
    // canopy — so a year of it taking a sixth of the continent is the rule
    // working, not running away. What must still hold is that a year of fire
    // cannot clear the place.
    expect(burnt, `fire must not take the continent, burnt ${burnt}`).toBeLessThan(CELLS / 5);
  });
});

describe("the record agrees with the ground", () => {
  it("says so when a world burned", () => {
    expect(lit.length, "a world that burned should say so").toBeGreaterThan(0);
  });

  it("reports at least what is still bare", () => {
    // Not equality: the ground grows back. A cell burned in the spring is over
    // the 500 this counts by the end of the year, so what is still visibly bare
    // is a floor under what was reported, never a match for it.
    const took = lit.reduce((n, e) => n + e.size, 0);
    expect(took, `the fires reported ${took} cells and ${burnt} are still bare`).toBeGreaterThanOrEqual(burnt);
  });

  it("does not burn the average cell twice a year", () => {
    // Against the land and not a fraction of it, because this is a flux and not
    // a stock: a cell can burn in the spring, grow back, and burn again by
    // autumn, so the year's total is not bounded by the size of the map at all.
    // What it must not exceed is the land itself — a world where the average
    // cell burns more than once a year is not a world with fires in it, it is a
    // world on fire.
    const took = lit.reduce((n, e) => n + e.size, 0);
    expect(took, `the average cell must not burn twice a year: ${took} over ${dryLand}`).toBeLessThan(dryLand);
  });

  it("files every fire where the ground actually burned", () => {
    for (const e of lit) {
      expect(e.size, "a strike that took nothing is weather, not an event").toBeGreaterThan(0);
      expect(e.rules, "stamped with the rules that ran it").toBe(RULE_VERSION);
      expect(e.x >= 0 && e.x < SIZE && e.y >= 0 && e.y < SIZE,
        `fire at ${e.x},${e.y} is off the map`).toBe(true);
      expect(f.veg[e.y * SIZE + e.x], "and it is filed where the ground actually burned").toBeLessThan(2000);
    }
  });
});

it("burns the same way twice", () => {
  // This is the only world here that catches fire, so the determinism check has
  // to be made again on it, or the one rule in the tick that draws on chance
  // goes unwatched. Swapping the seeded hash for Math.random fails this line.
  const [encore, hist2] = mature();
  same(pack(encore), pack(f), "a world that burns must burn the same way twice");
  expect(hist2.filter((e) => e.kind === "fire"),
    "and it must be written down the same way twice").toEqual(lit);
});

it("gives fires that differ in size", () => {
  // The regression the whole rule was rewritten for, asked by striking the same
  // world in different places. Spread used to be deterministic — every
  // neighbour with fuel caught — so a fire ate its entire connected fuel
  // region, and that region was ninety per cent of the continent: every fire
  // came out at exactly BURN_CAP and the cap was the rule rather than the
  // backstop. If that ever comes back these sizes all match again.
  //
  // Not asked of the year's own fires above, because this fixture is every cell
  // closed dry canopy and so far above the percolation threshold that it yields
  // one fire and that fire is capped. Which is right for such a world, and no
  // use for showing that size varies. `f` is free to be burnt now: the checks
  // that needed it pristine have all been made.
  const spots: number[] = [];
  for (let i = 0; i < CELLS && spots.length < 8; i += 977) if (f.veg[i] > 5000) spots.push(i);
  expect(spots.length, "a mature world should offer somewhere to strike").toBeGreaterThan(1);
  const canopy = Uint16Array.from(f.veg);
  const sizes = spots.map((i, k) => { f.veg.set(canopy); f.tick = 90000 + k * 13; return burn(f, i); });
  f.veg.set(canopy);
  expect(new Set(sizes).size, `fires have to differ in size, got ${sizes}`).toBeGreaterThan(1);
  expect(sizes.some((n) => n > 0), `and some of them have to take hold, got ${sizes}`).toBe(true);
});

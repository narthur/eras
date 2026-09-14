// A world run for a year, and everything that can be asked of it. The expensive
// file: it builds seed 1234 twice, once to read and once to prove the first one
// was not an accident.

import { beforeAll, describe, expect, it } from "vitest";
import {
  generate, pack, unpack, Biome, features, submerged,
  CELLS, SIZE, type World,
} from "./index.ts";
import { run, count, same, TICKS } from "./fixtures.ts";

let a: World, after: number[];

beforeAll(() => {
  // Timed and printed, because this is the one place a year of the world runs
  // on every test. Read it as a smoke signal and not as a measurement: six
  // files run in parallel workers and all of them want the same cores, so this
  // reads around 23ms a tick where a quiet machine gives 14. `pnpm bench` is
  // the one to trust for a figure; this one is for noticing an order of
  // magnitude.
  const t0 = Date.now();
  a = run(generate(1234), TICKS)[0];
  const ms = Date.now() - t0;
  after = count(a);
  console.log(`${TICKS} ticks in ${ms}ms (${(ms / TICKS).toFixed(1)}ms/tick)`);
});

describe("worldgen", () => {
  it("leaves a sea and some land", () => {
    const raw = count(generate(1234));
    expect(raw[Biome.Ocean] > CELLS * 0.1, "worldgen should leave a sea").toBe(true);
    expect(raw[Biome.Ocean] < CELLS * 0.9, "worldgen should leave land").toBe(true);
  });
});

describe("determinism and the wire format", () => {
  it("gives the same world for the same seed", () => {
    const b = run(generate(1234), TICKS)[0];
    same(pack(a), pack(b), "same seed must give the same world");
  });

  it("survives the round trip", () => {
    const c = unpack(pack(a));
    same(pack(c), pack(a), "every field must survive the round trip");
    expect(c.tick, "and the tick with it").toBe(a.tick);
    expect(c.seed, "and the seed").toBe(a.seed);
  });

  it("refuses a short buffer", () => {
    expect(() => unpack(pack(a).slice(0, 64)), "a short buffer must say so").toThrowError(/bytes/);
  });
});

describe("a year of it", () => {
  it("takes hold without scouring itself bare", () => {
    const mean = (w: World) => w.veg.reduce((s, v) => s + v, 0) / CELLS;
    expect(mean(a), `plants should be taking hold, mean veg ${mean(a)}`).toBeGreaterThan(100);
    expect(after[Biome.River] + after[Biome.Lake],
      "water should have collected somewhere").toBeGreaterThan(20);
    expect(a.soil.reduce((s, v) => s + v, 0) > 0.9 * generate(1234).soil.reduce((s, v) => s + v, 0),
      "the island must not scour itself bare").toBe(true);
    for (let i = 0; i < CELLS; i++) {
      if (a.water[i] >= 65535) expect.fail("water must not saturate");
    }
  });

  it("leaves the land uneven", () => {
    // The growth rule as it actually came out: the tick has to be using it, and
    // no two cells of a living world should hold exactly the same amount.
    const grown = new Set<number>();
    for (let i = 0; i < CELLS; i++) if (!submerged(a, i) && a.veg[i] > 0) grown.add(a.veg[i]);
    expect(grown.size, `a year should leave the land uneven, ${grown.size} levels`).toBeGreaterThan(8);
  });
});

describe("soil moisture is a reading, not a constant", () => {
  // It stood at 100% over seven eighths of the land once, because the daily
  // rain settled the store above what the soil could hold, so every cell that
  // was not desert stood brim full. Two halves to that: the day's rain is
  // smaller now, and it arrives in storms — a store below capacity soaks up an
  // average day whole and never spills, which is why a world watered evenly has
  // no runoff in it at all.
  let damp: number[], standing = 0, pools = 0;

  beforeAll(() => {
    damp = [];
    for (let i = 0; i < CELLS; i++) {
      if (submerged(a, i)) continue;
      const root = Math.min(a.soil[i], 1200) >> 3;
      if (root > 0) damp.push((a.water[i] * 100) / root | 0);
      const over = a.water[i] - (a.soil[i] >> 3);
      if (over > 0) standing++;
      if (over > 600) pools++;
    }
    damp.sort((p, q) => p - q);
  });

  it("is not brim full over the median cell", () => {
    const median = damp[damp.length >> 1];
    const soaked = damp.filter((v) => v >= 100).length / damp.length;
    expect(median, `the median cell should not be brim full: ${median}%`).toBeLessThan(85);
    expect(soaked, `too much of the land is saturated: ${(soaked * 100).toFixed(0)}%`).toBeLessThan(0.4);
  });

  it("runs off and collects", () => {
    // Rain that arrives all at once has to run off, or there is nothing
    // standing anywhere and the world has no lakes.
    expect(standing, `rain should run off somewhere, ${standing} cells hold any`).toBeGreaterThan(100);
    expect(pools, `and collect into lakes, ${pools} cells deep enough`).toBeGreaterThan(20);
  });
});

describe("rain comes off the shape of the land", () => {
  // Not out of a noise field: air that has been climbing for the last few cells
  // gives up more of what it carries, and the ground beyond the ridge gets what
  // is left. Measured against the six cells upwind of each one, windward
  // country should be wetter than lee country by a clear margin; a rain map
  // that owed nothing to the terrain would read 1.
  it("is drier in the lee of a range", () => {
    const height = (i: number) => a.elev[i] * 100 + a.soil[i];
    let wetSum = 0, wetN = 0, leeSum = 0, leeN = 0;
    for (let i = 0; i < CELLS; i++) {
      if (submerged(a, i)) continue;
      if (i % SIZE < 6 || submerged(a, i - 6)) continue;
      const climb = height(i) - height(i - 6);
      if (climb > 2000) { wetSum += a.rain[i]; wetN++; }
      else if (climb < -2000) { leeSum += a.rain[i]; leeN++; }
    }
    const [windward, lee] = [wetSum / wetN, leeSum / leeN];
    expect(windward > lee * 1.25,
      `the lee of a range should be drier: ${windward.toFixed(0)} against ${lee.toFixed(0)}`).toBe(true);
  });

  it("keeps the land's mean where the growth rules were tuned for it", () => {
    // The wind only moves the rain about, however the terrain moves underneath.
    let rainSum = 0, landN = 0;
    for (let i = 0; i < CELLS; i++) {
      if (submerged(a, i)) continue;
      rainSum += a.rain[i];
      landN++;
    }
    const meanRain = rainSum / landN;
    expect(meanRain > 125 && meanRain < 145, `mean rainfall drifted to ${meanRain.toFixed(0)}`).toBe(true);
  });
});

describe("the ground moves", () => {
  it("buries a channel somewhere in a year", () => {
    // Not by the size of a drop — `carve` cuts up to BITE, four metres of
    // bedrock, in a single pass, so river incision clears any threshold a
    // landslide would and the assertion passed with the rule switched off
    // entirely. What no other rule can do is put rock back: worldgen aside,
    // every rule in the tick only ever lowers bedrock, and slump alone raises
    // it. A cell standing on more rock than it was made with was buried.
    const genesis = generate(1234);
    let buried = 0;
    for (let i = 0; i < CELLS; i++) if (a.elev[i] > genesis.elev[i]) buried++;
    expect(buried, "a year should bury a channel somewhere").toBeGreaterThan(0);
  });
});

describe("rivers have to be whole", () => {
  // Accumulating the water that actually moved on the day gave fragments of
  // about thirty cells, because every pit ended a basin; the filled surface
  // should carry one course from the interior to the coast.
  it("runs a long course", () => {
    const river = features(a).filter((f) => f.kind === "river");
    expect(river[0].size, `a river should run, longest ${river[0]?.size}`).toBeGreaterThan(100);
  });

  it("ends at the sea", () => {
    // Whatever carries the most drainage is a mouth.
    let mouth = 0;
    for (let i = 0; i < CELLS; i++) if (!submerged(a, i) && a.flow[i] > a.flow[mouth]) mouth = i;
    const mx = mouth % SIZE, my = (mouth / SIZE) | 0;
    let coastal = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = mx + dx, ny = my + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        if (submerged(a, ny * SIZE + nx)) coastal = true;
      }
    }
    expect(coastal, `the greatest drainage should end at the sea, ends at ${mx},${my}`).toBe(true);
  });
});

describe("the things worth naming", () => {
  it("finds land, biggest first, all on the map", () => {
    const found = features(a);
    const islands = found.filter((f) => f.kind === "island");
    expect(islands.length, "the world should have land worth naming").toBeGreaterThan(0);
    expect(islands[0].size, "the continent should dwarf everything else").toBeGreaterThan(CELLS / 8);
    expect(found.every((f) => f.x >= 0 && f.x < SIZE && f.y >= 0 && f.y < SIZE),
      "every marker lands on the map").toBe(true);
    expect(found, "biggest first, so the panel reads by significance")
      .toEqual([...found].sort((p, q) => q.size - p.size || p.y - q.y || p.x - q.x));
  });

  it("partitions the land between islands", () => {
    // Every land cell belongs to exactly one, so their sizes must add up to the
    // land that is left once the small ones are dropped.
    const islands = features(a).filter((f) => f.kind === "island");
    let land = 0;
    for (let i = 0; i < CELLS; i++) if (!submerged(a, i)) land++;
    const named = islands.reduce((n, f) => n + f.size, 0);
    expect(named, "an island cannot hold more cells than there is land").toBeLessThanOrEqual(land);
    expect(named > land * 0.9, `most land should sit in a nameable island, got ${named}/${land}`).toBe(true);
  });
});

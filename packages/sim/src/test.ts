import assert from "node:assert";
import { generate, step, pack, unpack, biome, Biome, features, submerged, carry, fills, CELLS, SIZE } from "./index.ts";

const count = (w: ReturnType<typeof generate>) => {
  const t = Array.from({ length: 8 }, () => 0);
  for (let i = 0; i < CELLS; i++) t[biome(w, i)]++;
  return t;
};

const a = generate(1234);
assert.ok(count(a)[Biome.Ocean] > CELLS * 0.1, "worldgen should leave a sea");
assert.ok(count(a)[Biome.Ocean] < CELLS * 0.9, "worldgen should leave land");

const t0 = Date.now();
const TICKS = 400;
for (let i = 0; i < TICKS; i++) step(a);
const ms = Date.now() - t0;

// Byte by byte, by hand. A failed deepStrictEqual on two worlds renders a diff
// of all 720KB of them, which takes ninety seconds and seven gigabytes to say
// what one offset says at once — found by breaking this on purpose.
const same = (x: ArrayBuffer, y: ArrayBuffer, what: string) => {
  const p = new Uint8Array(x), q = new Uint8Array(y);
  assert.strictEqual(p.length, q.length, `${what}: ${p.length} bytes against ${q.length}`);
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== q[i]) assert.fail(`${what}: byte ${i} is ${p[i]}, was ${q[i]}`);
  }
};

const b = generate(1234);
for (let i = 0; i < TICKS; i++) step(b);
same(pack(a), pack(b), "same seed must give the same world");

const c = unpack(pack(a));
same(pack(c), pack(a), "every field must survive the round trip");
assert.strictEqual(c.tick, a.tick, "and the tick with it");
assert.strictEqual(c.seed, a.seed, "and the seed");
assert.throws(() => unpack(pack(a).slice(0, 64)), /bytes/, "a short buffer must say so");

const after = count(a);
const mean = (w: ReturnType<typeof generate>) => w.veg.reduce((s, v) => s + v, 0) / CELLS;
assert.ok(mean(a) > 100, `plants should be taking hold, mean veg ${mean(a)}`);
assert.ok(after[Biome.River] + after[Biome.Lake] > 20, "water should have collected somewhere");
assert.ok(a.soil.reduce((s, v) => s + v, 0) > 0.9 * generate(1234).soil.reduce((s, v) => s + v, 0), "the island must not scour itself bare");
for (let i = 0; i < CELLS; i++) assert.ok(a.water[i] < 65535, "water must not saturate");

// The growth rule has to make places, not days: before it took account of the
// cell, every adequate cell grew at the same rate to the same ceiling and the
// whole continent crossed from barren to grass to forest in a single year.
// Asked directly, because through a run it cannot be asked honestly: the
// weather scales the whole map together, and in a wet decade the poorer country
// catches up on purpose, so whether a given seed shows a gap over a given year
// depends on the year rather than on the rule.
const ROOTED = 1200, WET_SOIL = 100;    // deep enough soil, wet enough to drink
assert.ok(carry(150, ROOTED, WET_SOIL) > carry(110, ROOTED, WET_SOIL),
  "rain has to be what separates forest country from grass country");
assert.ok(fills(carry(150, ROOTED, WET_SOIL)) > fills(carry(100, ROOTED, WET_SOIL)),
  "and it has to show in how fast the ground fills, not only in the ceiling");
assert.ok(carry(150, 200, WET_SOIL) < carry(150, ROOTED, WET_SOIL),
  "thin soil holds a place back whatever the sky is doing");
assert.ok(carry(150, ROOTED, 30) < carry(150, ROOTED, WET_SOIL),
  "and drought bites ground that cannot hold what falls on it");
assert.strictEqual(carry(80, ROOTED, WET_SOIL), 0, "nothing grows where nothing falls");

// Then the same thing as it actually came out: the tick has to be using that
// rule, and no two cells of a living world should hold exactly the same amount.
const grown = new Set<number>();
for (let i = 0; i < CELLS; i++) if (!submerged(a, i) && a.veg[i] > 0) grown.add(a.veg[i]);
assert.ok(grown.size > 8, `a year should leave the land uneven, ${grown.size} levels`);

// Soil moisture has to be a reading and not a constant. It stood at 100% over
// seven eighths of the land once, because the daily rain settled the store
// above what the soil could hold, so every cell that was not desert stood brim
// full. Two halves to that: the day's rain is smaller now, and it arrives in
// storms — a store below capacity soaks up an average day whole and never
// spills, which is why a world watered evenly has no runoff in it at all.
const damp: number[] = [];
let standing = 0, pools = 0;
for (let i = 0; i < CELLS; i++) {
  if (submerged(a, i)) continue;
  const root = Math.min(a.soil[i], 1200) >> 3;
  if (root > 0) damp.push((a.water[i] * 100) / root | 0);
  const over = a.water[i] - (a.soil[i] >> 3);
  if (over > 0) standing++;
  if (over > 600) pools++;
}
damp.sort((p, q) => p - q);
const soaked = damp.filter((v) => v >= 100).length / damp.length;
assert.ok(damp[damp.length >> 1] < 85, `the median cell should not be brim full: ${damp[damp.length >> 1]}%`);
assert.ok(soaked < 0.4, `too much of the land is saturated: ${(soaked * 100).toFixed(0)}%`);
// and the other half of it: rain that arrives all at once has to run off, or
// there is nothing standing anywhere and the world has no lakes
assert.ok(standing > 100, `rain should run off somewhere, ${standing} cells hold any`);
assert.ok(pools > 20, `and collect into lakes, ${pools} cells deep enough`);

// Rain comes off the shape of the land, not out of a noise field: air that has
// been climbing for the last few cells gives up more of what it carries, and
// the ground beyond the ridge gets what is left. Measured against the six
// cells upwind of each one, windward country should be wetter than lee country
// by a clear margin; a rain map that owed nothing to the terrain would read 1.
const height = (i: number) => a.elev[i] * 100 + a.soil[i];
let wetSum = 0, wetN = 0, leeSum = 0, leeN = 0, rainSum = 0, landN = 0;
for (let i = 0; i < CELLS; i++) {
  if (submerged(a, i)) continue;
  rainSum += a.rain[i];
  landN++;
  if (i % SIZE < 6 || submerged(a, i - 6)) continue;
  const climb = height(i) - height(i - 6);
  if (climb > 2000) { wetSum += a.rain[i]; wetN++; }
  else if (climb < -2000) { leeSum += a.rain[i]; leeN++; }
}
const [windward, lee] = [wetSum / wetN, leeSum / leeN];
assert.ok(windward > lee * 1.25,
  `the lee of a range should be drier: ${windward.toFixed(0)} against ${lee.toFixed(0)}`);
// and the wind only moves the rain about — the land's mean has to stay where
// the growth rules were tuned for it, however the terrain moves underneath
const meanRain = rainSum / landN;
assert.ok(meanRain > 125 && meanRain < 145, `mean rainfall drifted to ${meanRain.toFixed(0)}`);

// Fire, on a world already grown over: rare enough that the ordinary run above
// sees none, so this one starts mature. Deterministic, so it either burns for
// this seed or it never will.
const mature = () => {
  const m = generate(1234);
  m.veg.fill(9500);
  for (let i = 0; i < TICKS; i++) step(m);
  return m;
};
const f = mature();
const burnt = [...f.veg].filter((v, i) => !submerged(f, i) && v < 500).length;
assert.ok(burnt > 0, "a mature dry world should burn somewhere in a year");
assert.ok(burnt < CELLS / 20, `fire must not take the continent, burnt ${burnt}`);
// This is the only world here that catches fire, so the determinism check has
// to be made again on it, or the one rule in the tick that draws on chance
// goes unwatched. Swapping the seeded hash for Math.random fails this line.
same(pack(mature()), pack(f), "a world that burns must burn the same way twice");

// Rivers have to be whole. Accumulating the water that actually moved on the
// day gave fragments of about thirty cells, because every pit ended a basin;
// the filled surface should carry one course from the interior to the coast.
const river = features(a).filter((f) => f.kind === "river");
assert.ok(river[0].size > 100, `a river should run, longest ${river[0]?.size}`);
// and it should get to the sea: whatever carries the most drainage is a mouth
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
assert.ok(coastal, `the greatest drainage should end at the sea, ends at ${mx},${my}`);

const found = features(a);
const islands = found.filter((f) => f.kind === "island");
assert.ok(islands.length > 0, "the world should have land worth naming");
assert.ok(islands[0].size > CELLS / 8, "the continent should dwarf everything else");
assert.ok(found.every((f) => f.x >= 0 && f.x < SIZE && f.y >= 0 && f.y < SIZE),
  "every marker lands on the map");
assert.deepStrictEqual(found, [...found].sort((p, q) => q.size - p.size || p.y - q.y || p.x - q.x),
  "biggest first, so the panel reads by significance");
// islands partition the land: every land cell belongs to exactly one, so their
// sizes must add up to the land that is left once the small ones are dropped
let land = 0;
for (let i = 0; i < CELLS; i++) if (!submerged(a, i)) land++;
const named = islands.reduce((n, f) => n + f.size, 0);
assert.ok(named <= land, "an island cannot hold more cells than there is land");
assert.ok(named > land * 0.9, `most land should sit in a nameable island, got ${named}/${land}`);

console.log(`${TICKS} ticks in ${ms}ms (${(ms / TICKS).toFixed(1)}ms/tick)`);
console.log(found.slice(0, 6).map((f) => `${f.kind}:${f.size}@${f.x},${f.y}`).join(" "));
console.log(Object.entries(Biome).map(([k, v]) => `${k}=${after[v]}`).join(" "));

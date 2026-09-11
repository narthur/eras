import assert from "node:assert";
import { generate, step, pack, unpack, biome, Biome, features, submerged, CELLS, SIZE } from "./index.ts";

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

const b = generate(1234);
for (let i = 0; i < TICKS; i++) step(b);
assert.deepStrictEqual(new Uint8Array(pack(a)), new Uint8Array(pack(b)), "same seed must give the same world");

const c = unpack(pack(a));
assert.deepStrictEqual(c, a, "every field must survive the round trip");
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
// Measured against rainfall specifically, because terrain alone — bare rock,
// drought, drowning — already spread the old flat rule enough to pass a plain
// spread check, which made the check worthless as a guard against its return.
const rains = [...a.rain].filter((_, i) => a.elev[i] > 0).sort((p, q) => p - q);
const dry = rains[(rains.length / 4) | 0], wet = rains[((rains.length * 3) / 4) | 0];
const meanVeg = (pick: (r: number) => boolean) => {
  let sum = 0, n = 0;
  for (let i = 0; i < CELLS; i++) if (a.elev[i] > 0 && pick(a.rain[i])) { sum += a.veg[i]; n++; }
  return sum / n;
};
const [wetVeg, dryVeg] = [meanVeg((r) => r >= wet), meanVeg((r) => r <= dry)];
assert.ok(wetVeg > dryVeg * 2,
  `wet country should outgrow dry country: ${wetVeg.toFixed(0)} vs ${dryVeg.toFixed(0)}`);
// And the rate itself has to vary, which the flat rule cannot fake: growing a
// point a day for TICKS days cannot leave anything above TICKS.
const tallest = [...a.veg].filter((_, i) => a.elev[i] > 0).reduce((m, v) => (v > m ? v : m), 0);
assert.ok(tallest > TICKS, `good ground should grow faster than a point a day, tallest ${tallest}`);

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
const burnt = [...f.veg].filter((v, i) => f.elev[i] > 0 && v < 500).length;
assert.ok(burnt > 0, "a mature dry world should burn somewhere in a year");
assert.ok(burnt < CELLS / 20, `fire must not take the continent, burnt ${burnt}`);
// The world above is the only one here that catches fire — the ordinary run
// never grows enough to light — so the determinism check has to be made again
// on this one, or the one rule in the tick that draws on chance goes unwatched.
assert.deepStrictEqual(new Uint8Array(pack(mature())), new Uint8Array(pack(f)),
  "a world that burns must burn the same way twice");

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

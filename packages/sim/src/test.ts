import assert from "node:assert";
import { generate, step, pack, unpack, biome, Biome, features, CELLS, SIZE } from "./index.ts";

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
const land = a.elev.reduce((n, e) => n + (e > 0 ? 1 : 0), 0);
const named = islands.reduce((n, f) => n + f.size, 0);
assert.ok(named <= land, "an island cannot hold more cells than there is land");
assert.ok(named > land * 0.9, `most land should sit in a nameable island, got ${named}/${land}`);

console.log(`${TICKS} ticks in ${ms}ms (${(ms / TICKS).toFixed(1)}ms/tick)`);
console.log(found.slice(0, 6).map((f) => `${f.kind}:${f.size}@${f.x},${f.y}`).join(" "));
console.log(Object.entries(Biome).map(([k, v]) => `${k}=${after[v]}`).join(" "));

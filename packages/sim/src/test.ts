import assert from "node:assert";
import { generate, step, pack, unpack, biome, Biome, features, submerged, carry, fills, slump, burn, rainfall, wave, VEER, puddle, sea, RULE_VERSION, CELLS, SIZE, VEG_MAX, type World, type Event } from "./index.ts";

/**
 * Run a world on, and hand back both it and what happened while it did. The
 * sim reports a day's events with the day, so a test that wants a run's
 * history gathers it here rather than draining a module-level log — which is
 * why most of the `chronicle()` calls this file used to need, purely to stop
 * one block's events arriving in the middle of another's, are gone.
 */
const run = (w: World, days: number): [World, Event[]] => {
  const told: Event[] = [];
  for (let i = 0; i < days; i++) {
    const day = step(w);
    w = day.world;
    told.push(...day.events);
  }
  return [w, told];
};

const count = (w: ReturnType<typeof generate>) => {
  const t = Array.from({ length: 8 }, () => 0);
  for (let i = 0; i < CELLS; i++) t[biome(w, i)]++;
  return t;
};

let a = generate(1234);
assert.ok(count(a)[Biome.Ocean] > CELLS * 0.1, "worldgen should leave a sea");
assert.ok(count(a)[Biome.Ocean] < CELLS * 0.9, "worldgen should leave land");

const t0 = Date.now();
const TICKS = 400;
a = run(a, TICKS)[0];
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

const b = run(generate(1234), TICKS)[0];
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

// The wander itself, before asking what it does to the rain. The banding check
// below is an aggregate and a loose one: it catches the wander going missing
// altogether and almost nothing else. Measured — a sawtooth of the same
// amplitude that snaps back instead of folding, and a VEER ten times too long,
// both sail through it. So the shape gets asked about directly. Stated against
// itself rather than against SWAY, so the constants stay free to move.
{
  const turn = wave(VEER / 2);
  assert.ok(turn > 0, `the track should be north of its mean at the turn, ${turn}`);
  assert.strictEqual(wave(0), -turn, "and as far south at the start as north at the turn");
  assert.strictEqual(wave(VEER), wave(0), "a lap should come back to where it began");
  // A triangle folds; a sawtooth jumps. One period of steps, and the longest
  // must be no longer than the first — which is what the fold buys and what
  // snapping back at the wrap would break.
  const step1 = Math.abs(wave(1) - wave(0));
  let widest = 0;
  for (let t = 0; t < VEER * 2; t++) {
    widest = Math.max(widest, Math.abs(wave(t + 1) - wave(t)));
    assert.ok(wave(t) >= wave(0) && wave(t) <= turn, `the track wandered off its range at ${t}: ${wave(t)}`);
  }
  assert.ok(widest <= step1 * 1.0000001,
    `the track should fold at the turn, not snap: widest step ${widest} against ${step1}`);
}

// The weather must not have a latitude. This is the one fault in the sim so far
// that no number caught and a person did, by looking at the map and saying the
// forests were growing in rows. They were: the front drifted along x and along
// nothing else, so every cell in a row traced the same straight line through
// the weather field a few days apart and collected the same rain over the
// years. Long-run rainfall became a function of y alone, in bands a patch tall,
// frozen for the life of the world, and neighbour-seeded growth printed them.
//
// Measured here and not on the trees on purpose. Forest run lengths were tried
// first and are nearly blind to it — one seed in three separated, and one
// separated the wrong way — because by the time rain has passed through soil,
// a growth threshold and fire it is a shadow of the fault rather than the
// fault. Asked of the rain directly, with no world to simulate, banded reads
// about 20 and whole reads about 1, and the run takes a moment.
//
// Row spread against column spread, both relative to the mean so the units
// cancel. Two thousand days and not one thousand: the wander takes VEER days to
// come back round, so a window of two and a half turns has not finished
// averaging and the ratio still swings with the seed. Ten seeds run 0.64 to
// 1.84 at a thousand days and 0.39 to 1.07 at two thousand, settling downward
// as the sway smooths along y. Which ten seeds matters at the wide end — a
// different ten put the four-thousand-day ceiling half again as high — so read
// these as the shape of the thing and not as constants. Five turns is enough to
// leave the bar real headroom without making the test slow. The bar is only
// there to catch a return to banding, which is a twentyfold departure and not a
// subtle one.
{
  const DAYS = 2000;
  // The one thing the wave checks above cannot see. Stated against itself, a
  // triangle stays a valid triangle whatever its period, so a VEER ten times
  // too long reads as correct there — and quietly leaves this window sampling a
  // quarter of one turn, where the ratio has not begun to settle and the bar
  // below stops meaning anything. Tie them together instead: whoever moves VEER
  // has to come back here and re-measure.
  assert.ok(DAYS >= VEER * 5,
    `the banding window must cover several turns of the track: ${DAYS} days against a ${VEER}-day turn`);
  const acc = new Float64Array(CELLS), today = new Int32Array(CELLS);
  for (let t = 0; t < DAYS; t++) {
    rainfall(t, 1234, today);
    for (let i = 0; i < CELLS; i++) acc[i] += today[i];
  }
  // acc is laid out y * SIZE + x, so spread(SIZE, 1) sums across x for each y —
  // one mean per row — and spread(1, SIZE) one mean per column. Getting the two
  // the wrong way round would swap the names and still print plausible numbers.
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
  assert.ok(rows < cols * 3,
    `rain must not band by latitude: row spread ${(rows * 1e4).toFixed(1)} against column ${(cols * 1e4).toFixed(1)}`);
}

// Fire, on a world already grown over: rare enough that the ordinary run above
// sees none, so this one starts mature. Deterministic, so it either burns for
// this seed or it never will.
const mature = (): [World, Event[]] => {
  const m = generate(1234);
  m.veg.fill(9500);
  return run(m, TICKS);
};
const [f, hist] = mature();
// Fires only: a made-mature world still has rivers cutting slopes out from
// under each other, so slides turn up here too.
const lit = hist.filter((e) => e.kind === "fire");
const burnt = [...f.veg].filter((v, i) => !submerged(f, i) && v < 500).length;
assert.ok(burnt > 0, "a mature dry world should burn somewhere in a year");
// A fifth, where this used to say a twentieth. The old figure was the cap's
// shadow: every fire burnt exactly BURN_CAP, so a year's total was a multiple
// of it and the bound could be tight. Fire is percolation now and this fixture
// is the most flammable world there is — every cell closed dry canopy — so a
// year of it taking a sixth of the continent is the rule working, not running
// away. What must still hold is that a year of fire cannot clear the place.
assert.ok(burnt < CELLS / 5, `fire must not take the continent, burnt ${burnt}`);

// And the record has to agree with the ground. This is the only world in the
// suite that catches fire, so it is the only place the fire half of the
// chronicle can be asked anything at all.
assert.ok(lit.length > 0, "a world that burned should say so");
// Not equality: the ground grows back. A cell burned in the spring is over the
// 500 this counts by the end of the year, so what is still visibly bare is a
// floor under what was reported, never a match for it.
const took = lit.reduce((n, e) => n + e.size, 0);
assert.ok(took >= burnt, `the fires reported ${took} cells and ${burnt} are still bare`);
// Against the land and not a fraction of it, because this is a flux and not a
// stock: a cell can burn in the spring, grow back, and burn again by autumn, so
// the year's total is not bounded by the size of the map at all. What it must
// not exceed is the land itself — a world where the average cell burns more
// than once a year is not a world with fires in it, it is a world on fire.
let dryLand = 0;
for (let i = 0; i < CELLS; i++) if (!submerged(f, i)) dryLand++;
assert.ok(took < dryLand, `the average cell must not burn twice a year: ${took} over ${dryLand}`);
for (const e of lit) {
  assert.ok(e.size > 0, "a strike that took nothing is weather, not an event");
  assert.strictEqual(e.rules, RULE_VERSION, "stamped with the rules that ran it");
  assert.ok(e.x >= 0 && e.x < SIZE && e.y >= 0 && e.y < SIZE, `fire at ${e.x},${e.y} is off the map`);
  assert.ok(f.veg[e.y * SIZE + e.x] < 2000, "and it is filed where the ground actually burned");
}
// This is the only world here that catches fire, so the determinism check has
// to be made again on it, or the one rule in the tick that draws on chance
// goes unwatched. Swapping the seeded hash for Math.random fails this line.
const [encore, hist2] = mature();
same(pack(encore), pack(f), "a world that burns must burn the same way twice");
assert.deepStrictEqual(hist2.filter((e) => e.kind === "fire"), lit,
  "and it must be written down the same way twice");

// The regression the whole rule was rewritten for, asked by striking the same
// world in different places. Spread used to be deterministic — every neighbour
// with fuel caught — so a fire ate its entire connected fuel region, and that
// region was ninety per cent of the continent: every fire came out at exactly
// BURN_CAP and the cap was the rule rather than the backstop. If that ever
// comes back these sizes all match again.
//
// Not asked of the year's own fires above, because this fixture is every cell
// closed dry canopy and so far above the percolation threshold that it yields
// one fire and that fire is capped. Which is right for such a world, and no use
// for showing that size varies. `f` is free to be burnt now: the two checks
// that needed it pristine have both been made.
const spots: number[] = [];
for (let i = 0; i < CELLS && spots.length < 8; i += 977) if (f.veg[i] > 5000) spots.push(i);
assert.ok(spots.length > 1, "a mature world should offer somewhere to strike");
const canopy = Uint16Array.from(f.veg);
const sizes = spots.map((i, k) => { f.veg.set(canopy); f.tick = 90000 + k * 13; return burn(f, i); });
f.veg.set(canopy);
assert.ok(new Set(sizes).size > 1, `fires have to differ in size, got ${sizes}`);
assert.ok(sizes.some((n) => n > 0), `and some of them have to take hold, got ${sizes}`);

// The sea crossing a mark. It moves by the century, so a run that waited for one
// would cost minutes; but `sea()` is pure in the tick and the seed, so the day
// it happens can be found by arithmetic and the world set down on the eve of it.
const MARK = 5000;   // must match the sim's own, or this test asks about nothing
const notchOf = (t: number, seed: number) => Math.trunc(sea(t, seed) / MARK);
let crossing = -1;
for (let t = 1; t < 365 * 400 && crossing < 0; t++) {
  if (notchOf(t, 1234) !== notchOf(t - 1, 1234)) crossing = t;
}
assert.ok(crossing > 0, "four centuries of this seed should move the sea five metres");
let tide = generate(1234);
// Two days: the first is the eve, and it is what a world resumed from storage
// has never had — a yesterday. The second is the day the sea changes mark.
tide.tick = crossing - 1;
const [tideRan, tideTold] = run(tide, 2);
tide = tideRan;
const turned = tideTold.filter((e) => e.kind === "sea");
assert.strictEqual(turned.length, 1, `one crossing at tick ${crossing}, got ${turned.length}`);
assert.strictEqual(turned[0].tick, crossing, "dated the day it crossed");
assert.strictEqual(turned[0].x, -1, "the sea happens everywhere, so it points nowhere");
assert.strictEqual(turned[0].y, -1, "and its y says so too");
assert.strictEqual(turned[0].size, (sea(crossing, 1234) / 1000) | 0, "in metres against the datum");
// And a world that has only just been picked up off the disk still catches it.
// This is the whole point of asking `sea` for yesterday instead of remembering
// it: a restart used to cost the first crossing after it, silently.
const resumed = generate(1234);
resumed.tick = crossing;
assert.deepStrictEqual(run(resumed, 1)[1].filter((e) => e.kind === "sea"), turned,
  "a world resumed on the day must report the crossing the same as one that ran into it");

// And an ordinary day after it says nothing at all — two steps, so the second
// of them is a day with a known yesterday rather than one that only primes.
tide.tick = crossing + 5;
assert.deepStrictEqual(run(tide, 2)[1].filter((e) => e.kind === "sea"), [],
  "a day that crosses no mark is not an event");

// Water is accounted for. `ground is conserved` follows rock and soil, and
// nothing followed water until the sea was caught conjuring it into hollows it
// could not reach. The tick may only rain it, dry it, move it downhill, or hand
// it to the sea; anything else is water from nowhere, and this is the line that
// says so. Exact, every day, not a range.
let acct = generate(4242);
for (let t = 0; t < 200; t++) {
  const before = puddle(acct);
  const today = step(acct);
  acct = today.world;
  const b = today.budget;
  const after = puddle(acct);
  // Spilled is in the identity and not left out of it, so this line stays true
  // whatever the ceilings do. Leaving it out made the sum right only because
  // the next line says nothing spills, which is two claims wearing one check.
  assert.strictEqual(after - before, b.rained - b.dried + b.tide - b.spilled,
    `day ${t}: the map holds ${after - before}mm more, the accounts say ${b.rained - b.dried + b.tide - b.spilled}mm`);
  // The ceilings are a floor under an arithmetic accident, not a working part.
  // A world that hits them is destroying water and calling it drainage.
  assert.strictEqual(b.spilled, 0, `day ${t}: ${b.spilled}mm went over the 65535 ceiling`);
}

// Slope failure, asked directly. It is the only rule that can make a closed
// basin, so it is the only one holding the continent's lakes open past the
// first century — and it moves ground in two units at once, so it is exactly
// the shape of rule that silently destroys mass. Asked on a made surface
// rather than through a run, because the undercut channels are a few dozen
// cells of one world and a run gives no way to know whether the ones that
// failed were the ones that should have.
const face = (): World => {
  const w: World = {
    seed: 1234, tick: 0, ruleVersion: 0,
    elev: new Int16Array(CELLS), soil: new Uint16Array(CELLS),
    water: new Uint16Array(CELLS), veg: new Uint16Array(CELLS),
    flow: new Uint16Array(CELLS), rain: new Uint8Array(CELLS),
  };
  for (let i = 0; i < CELLS; i++) {
    const high = (i % SIZE) % 2 === 0;       // a forty-metre face beside every channel
    w.elev[i] = high ? 450 : 50;
    w.soil[i] = 400;
    w.water[i] = 65535;                      // saturated, which is what fails a slope
    w.veg[i] = 0;
    w.flow[i] = high ? 0 : 5000;             // and the troughs carry rivers
  }
  return w;
};
const ground = (w: World) => {
  let m = 0;
  for (let i = 0; i < CELLS; i++) m += w.elev[i] * 100 + w.soil[i];
  return m;
};
const hill = face();
const rock = ground(hill);
let failures = 0, bared = 0;
// `slump` hands back what it buried, so this collects the record and the ground
// in one pass. It used to have to drain a process-wide log first, in case a
// loud slide from one of the runs above arrived in the middle of this block.
const wrote: Event[] = [];
for (let t = 0; t < 40; t++) {
  hill.tick = t;
  const before = Int16Array.from(hill.elev);
  wrote.push(...slump(hill));
  for (let i = 0; i < CELLS; i++) if (before[i] !== hill.elev[i]) failures++;
}
for (let i = 0; i < CELLS; i++) if ((i % SIZE) % 2 === 0 && hill.soil[i] === 0) bared++;
assert.ok(failures > 0, "a saturated forty-metre face over a river has to fail");
assert.strictEqual(ground(hill), rock, "and a slide must not create or destroy any ground");
assert.ok(bared > 0, `a face that failed should be stripped to rock, ${bared} were`);
for (let i = 0; i < CELLS; i++) assert.ok(hill.soil[i] < 65535, "debris must not pile past the ceiling");

// The chronicle, asked here because this is where slides are certain. Through a
// run they are not: the continent sheds about forty a year and only a tenth of
// them clear LOUD, so a seed can pass a year in silence — which is the point of
// the bar, and makes a run a poor place to ask whether the writing-down works.
// The slide is the only kind a made world can produce; fire and the sea travel
// the same two lines out of the tick.
// Same ground, same record: the chronicle has to be as reproducible as the
// world, or two runs of one seed disagree about what happened in it.
const rerun = face();
const again: Event[] = [];
for (let t = 0; t < 40; t++) { rerun.tick = t; again.push(...slump(rerun)); }
assert.deepStrictEqual(again, wrote, "one seed must write one chronicle");

// A face under the bar moves the same ground and says nothing about it. This
// is the whole of what LOUD does, and the only place it can be asked plainly:
// on the made world every face is the same height, so the bar is either over
// all of them or under all of them.
const low = face();
for (let i = 0; i < CELLS; i++) if ((i % SIZE) % 2 === 0) low.elev[i] = 250;   // a twenty-metre face
const shelf = Int16Array.from(low.elev);
const hush: Event[] = [];
for (let t = 0; t < 40; t++) { low.tick = t; hush.push(...slump(low)); }
assert.ok([...low.elev].some((v, i) => v !== shelf[i]), "a twenty-metre face over a river still has to fail");
assert.deepStrictEqual(hush, [], "but a slip under the bar is not news");

assert.ok(wrote.length > 0, "a face that failed should be written down");
assert.deepStrictEqual(wrote, [...wrote].sort((p, q) => p.tick - q.tick), "the chronicle runs forwards");
for (const e of wrote) {
  assert.strictEqual(e.kind, "slide");
  assert.ok(e.tick >= 0 && e.tick < 40, `an event must be dated by the day it happened, got ${e.tick}`);
  // A forty-metre face fails to the level of the channel, so that is what the
  // record has to say it dropped — in metres, not in the decimetres elev counts.
  assert.strictEqual(e.size, 40, "and measured in metres of rock");
  // Filed against the channel that was buried, which is a trough, not a face.
  assert.strictEqual(e.x % 2, 1, `a slide is filed against the river at ${e.x},${e.y}`);
  assert.ok(e.y >= 0 && e.y < SIZE, `${e.x},${e.y} is off the map`);
}

// Dry ground does not fail, however steep: water is the trigger, which is what
// ties the one rule that builds relief to the weather.
const dry = face();
dry.water.fill(0);
const still = ground(dry);
const wasElev = Int16Array.from(dry.elev);
for (let t = 0; t < 40; t++) { dry.tick = t; slump(dry); }
assert.strictEqual(ground(dry), still, "dry ground cannot move");
assert.deepStrictEqual([...dry.elev], [...wasElev], "and a dry face must stand");

// A channel with no river in it is not undercut, so nothing above it falls:
// the rule is about rivers cutting slopes out, not about steepness alone.
const unwatered = face();
unwatered.flow.fill(0);
const quiet = ground(unwatered);
const heldElev = Int16Array.from(unwatered.elev);
for (let t = 0; t < 40; t++) { unwatered.tick = t; slump(unwatered); }
assert.deepStrictEqual([...unwatered.elev], [...heldElev], "a slope over dry ground stands");
assert.strictEqual(ground(unwatered), quiet, "and nothing moves");

// Field capacity is the threshold, not "is there any water". Asked at the
// boundary, because a fixture that is either bone dry or brim full proves only
// that water is a trigger: swap the rule's soil/8 for any constant under 65535
// and a wet-or-dry fixture cannot tell the difference.
const brink = (fill: number) => {
  const w = face();
  w.water.fill(fill);
  const before = Int16Array.from(w.elev);
  for (let t = 0; t < 40; t++) { w.tick = t; slump(w); }
  let moved = 0;
  for (let i = 0; i < CELLS; i++) if (before[i] !== w.elev[i]) moved++;
  return moved;
};
const HOLDS = 400 >> 3;    // what the fixture's 400mm of soil can hold against gravity
assert.strictEqual(brink(HOLDS - 1), 0, "ground below field capacity still has friction");
assert.ok(brink(HOLDS) > 0, "ground holding all it can has none left");

// A channel already carrying all the debris it can hold. The soil ceiling is
// the one clamp the rule needs — rock cannot overflow, because a slide moves
// elev[face] - elev[dam] and so only ever swaps two heights that were both
// representable a moment ago — and it was dead to every assertion here until
// this fixture: deleting it changed no number in the suite. It has to be built
// carefully, because loading a channel with soil is what makes it tall: pile
// 65 metres into the trough of the fixture above and the trough stands higher
// than the face, no face is found, and the test passes by doing nothing.
const packed = (): World => {
  const w = face();
  for (let i = 0; i < CELLS; i++) {
    const high = (i % SIZE) % 2 === 0;
    w.elev[i] = high ? 1200 : 50;            // so the face still stands over it
    w.soil[i] = high ? 400 : 65400;          // with 135mm of room left below
  }
  return w;
};
const brim = packed();
const brimGround = ground(brim);
brim.tick = 0;
slump(brim);
let filled = 0;
for (let i = 0; i < CELLS; i++) {
  assert.ok(brim.soil[i] <= 65535, "soil cannot pass its ceiling");
  if ((i % SIZE) % 2 === 1 && brim.soil[i] === 65535) filled++;
}
assert.ok(filled > 0, "a channel should take what room it has and stop");
assert.strictEqual(ground(brim), brimGround, "and the rest stays on the face");

// A ridge can stand over two channels and be chosen by both on the same pass,
// and the second of those measured a face that has already gone. Deleting the
// guard against it left every assertion above passing, because a double shed
// subtracts and adds the same number and so balances while taking off a face
// more than the face had standing. Asked directly: after a pass, no face may
// have been cut below the channel it stood over.
const twice = face();
const stood = Int16Array.from(twice.elev);      // the ground as the slides found it
twice.tick = 0;
slump(twice);
for (let i = 0; i < CELLS; i++) {
  if ((i % SIZE) % 2 !== 0) continue;               // faces sit in the even columns
  const x = i % SIZE;
  if (x === 0 || x === SIZE - 1) continue;          // both channels must exist
  // Against the ground as it stood, and on the rock: every channel here is
  // itself buried by the face on its other side, so comparing against the
  // ground afterwards asks a question the fixture cannot answer, and comparing
  // surfaces would read a bare scar beside a loaded channel as upside down.
  // Shed twice, a face would drop to 50 - 400 rather than stopping at 50.
  const low = Math.min(stood[i - 1], stood[i + 1]);
  assert.ok(twice.elev[i] >= low,
    `a face shed more than once at ${x}: ${twice.elev[i]} against ${low}`);
}

// And the reason the rule exists: a dam has to leave a closed basin behind it.
// A channel running downhill, one wet face standing over it, and the cell
// upstream of the dam should afterwards have nowhere to drain. The fixture
// above cannot ask this — a checkerboard has no downstream.
const valley = (): World => {
  const w = face();
  const mid = SIZE >> 1;
  for (let i = 0; i < CELLS; i++) {
    const x = i % SIZE, y = (i / SIZE) | 0;
    w.elev[i] = y === mid ? 1000 - x : 3000;       // a channel falling a decimetre a cell
    w.soil[i] = 0;
    w.water[i] = 0;
    w.flow[i] = y === mid ? 5000 : 0;
  }
  const face_ = (mid - 1) * SIZE + 100;            // one saturated slope over x=100
  w.elev[face_] = 1000 - 100 + 100;                // ten metres above the channel
  w.water[face_] = 65535;
  return w;
};
const dammed = valley();
const mid = SIZE >> 1, above = mid * SIZE + 99;
const drains = (w: World, i: number) => {
  const here = w.elev[i] * 100 + w.soil[i];
  const x = i % SIZE, y = (i / SIZE) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      if (w.elev[ny * SIZE + nx] * 100 + w.soil[ny * SIZE + nx] < here) return true;
    }
  }
  return false;
};
assert.ok(drains(dammed, above), "the channel drains before anything falls into it");
const valleyGround = ground(dammed);
for (let t = 0; t < 200 && drains(dammed, above); t++) { dammed.tick = t; slump(dammed); }
assert.ok(!drains(dammed, above), "a slide has to leave the reach above it with nowhere to go");
assert.strictEqual(ground(dammed), valleyGround, "and it still must not make or destroy ground");

// Roots hold it: the same faces under closed canopy fail less often.
const rooted = face();
rooted.veg.fill(VEG_MAX);
let held = 0;
for (let t = 0; t < 40; t++) {
  rooted.tick = t;
  const before = Int16Array.from(rooted.elev);
  slump(rooted);
  for (let i = 0; i < CELLS; i++) if (before[i] !== rooted.elev[i]) held++;
}
assert.ok(held < failures, `canopy should hold a face together, ${held} failed against ${failures}`);

// And the tick has to be using it. Not by the size of a drop — `carve` cuts up
// to BITE, four metres of bedrock, in a single pass, so river incision clears
// any threshold a landslide would and the assertion passed with the rule
// switched off entirely. What no other rule can do is put rock back: worldgen
// aside, every rule in the tick only ever lowers bedrock, and slump alone
// raises it. A cell standing on more rock than it was made with was buried by
// a slide.
const genesis = generate(1234);
let buried = 0;
for (let i = 0; i < CELLS; i++) if (a.elev[i] > genesis.elev[i]) buried++;
assert.ok(buried > 0, "a year should bury a channel somewhere");

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

// Whether the world still has the shape it is supposed to have.
//
// `test` asks whether the rules are correct: ground is conserved, a seed is
// reproducible, a slide is filed where it happened. Those are questions with
// right answers. This asks the other kind — whether the world is still
// *interesting*, which has no right answer but does have wrong ones, and every
// wrong one so far was found by eye, weeks late, after a rule change quietly
// flattened something nobody was watching.
//
//   pnpm character                 three seeds, fifty years each
//   pnpm character 30              a quicker pass, with the slow checks unasked
//   pnpm character 200 3           two centuries of it, for the slow questions
//
// Seeds run in parallel, one process each, so the wall clock is one seed's
// rather than all of them: fifteen minutes became six. Fifty years is the
// default because that is where the last of the fast checks settles — the
// drainage network is still cutting at thirty. Checks that need longer say so
// with `needs`, and a run too short to ask one reports that it did not ask
// rather than reporting a pass. The basin trajectory wants a century and a
// half; nothing else wants more than fifty.
//
// Deliberately not in CI. `pnpm test` is half a minute and gates every deploy;
// this is a quarter of an hour and gates a judgement, which is a thing a person
// does before changing a rule, not a thing a push does.
//
// Each invariant is a range, not a target. Inside the range there is nothing to
// optimise toward and no corner to be driven into: a world that satisfies all
// of them is acceptable, and one that satisfies them and still looks wrong is
// telling you about a property you have not named yet. Adding that property is
// the work. The ranges are written from what the world ought to do, never from
// what it happens to do today, which is why some of them fail — see `known`.
//
// Slow on purpose. Fires need a canopy dry enough to carry one and do not
// appear before about world-year fifteen; the basin count only shows its
// trajectory over centuries. A run that finishes quickly is a run that cannot
// ask most of these questions.
//
// ponytail: seeds run one after another. They are wholly independent, so this
// is a `child_process.fork` per seed away from being three times faster — worth
// doing the first time the wait actually stops you running it.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { step, chronicle, type Event } from "./index.ts";
import { vitals, opening, type Vitals } from "./vitals.ts";

const YEARS = Number(process.argv[2] ?? 50);
const SEEDS = Number(process.argv[3] ?? 3);
const DAYS = 400;
const EVERY = 4;   // years between readings

type Run = { seed: number; series: Vitals[]; events: Event[] };

/** A range a number has to sit inside, with the reason it is that range. */
type Check = {
  name: string;
  of: string;                      // what is measured, in words
  lo: number;
  hi: number;
  value: (r: Run) => number;
  why: string;
  known?: string;                  // a failure already understood, and why it stands
  needs?: number;                  // world-years before this means anything. A run
                                   // shorter than it does not ask the question and
                                   // does not pretend to have answered it
};

const last = (r: Run) => r.series[r.series.length - 1];
const at = (r: Run, year: number) =>
  r.series.reduce((best, v) => (Math.abs(v.year - year) < Math.abs(best.year - year) ? v : best));
const fires = (r: Run) => r.events.filter((e) => e.kind === "fire").map((e) => e.size);
const median = (xs: number[]) => (xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[xs.length >> 1]);

// Every one of these is a shape the world has actually been wrong in, or a
// shape the eye reads first and no number was watching. Nothing here is a
// preference: each range has a failure behind it.
const CHECKS: Check[] = [
  {
    name: "ground is conserved",
    of: "total rock and soil against where it started, in parts per million",
    lo: 0, hi: 1,
    value: (r) => Math.abs(last(r).ground - r.series[0].ground) / r.series[0].ground * 1e6,
    why: "sediment has been silently destroyed at the soil ceiling twice. Nothing in the tick may create or destroy ground",
  },
  {
    name: "the land keeps its relief",
    of: "median drop to the lowest neighbour, millimetres",
    lo: 4000, hi: 40000,
    value: (r) => last(r).fall,
    why: "creep and deposition both grade the land down. Left alone they win, and a continent with no fall in it has no rivers and no weather",
  },
  {
    name: "basins are not spent",
    of: "closed depressions at the end, as a share of what there were at year twenty",
    lo: 0.8, hi: 4,
    value: (r) => (at(r, 20).basins > 0 ? last(r).basins / at(r, 20).basins : 0),
    why: "worldgen's hollows are a one-time gift. They fell 246 to 25 over two centuries and took every lake with them, which is what slope failure was added to stop",
    needs: 150,
    known: "slowed, not stopped over centuries: measured 353 at year twenty against 230 at year two hundred. Sinkholes are the candidate",
  },
  {
    name: "there is standing water",
    of: "lake cells at the end",
    lo: 40, hi: 8000,
    value: (r) => last(r).lakes,
    why: "a world with no water standing in it reads as a desert however much rain falls on it",
  },
  {
    name: "the ground is not brim full",
    of: "share of land holding all the water it can",
    lo: 0, hi: 0.5,
    value: (r) => last(r).saturated,
    why: "this sat at 100% over seven eighths of the land for forty years while every growth rule quietly read it, so every cell looked identical and the continent had one biome",
  },
  {
    name: "soil neither strips nor runs away",
    of: "mean loose material over land, millimetres",
    lo: 150, hi: 2000,
    value: (r) => last(r).soil,
    why: "without bedrock weathering the island stripped itself to rock in decades; with too much of it soil ran to 3000mm and river discharge fell by two thirds",
  },
  {
    name: "the continent is not bare rock",
    of: "share of land reading as rock",
    lo: 0, hi: 0.35,
    value: (r) => last(r).rock,
    why: "the same failure from the other side, and the one the eye reads first",
  },
  {
    name: "rivers run the whole way",
    of: "the longest reach, as a multiple of how far it is across the continent",
    lo: 0.4, hi: 8,
    // A drainage network is still cutting at thirty years: measured 0.40 then
    // and 0.66 on the same seed at sixty. The floor is about a mature world, so
    // asking it of a young one measures how old the world is, not whether its
    // rivers run.
    needs: 50,
    value: (r) => (last(r).span > 0 ? last(r).river / last(r).span : 0),
    why: "accumulation over the raw surface dies at every pit. Nothing ran past about thirty cells until the flood fill went in. Against the continent's own span and not a count of cells: a reach 'runs the whole way' when it gets from somewhere inland to the sea, which is about half a span, and that stays true if SIZE ever changes. The absolute hundred this started as came from a single seed's test assertion and failed the first other seed it met, at 86 cells on a continent exactly as wide as the one where 165 was normal. The span is the root of the island's area, so it reads a ragged coastline as narrower than it is and flatters the ratio — the bias is toward passing, so a failure here is real and a pass is the weaker claim",
  },
  {
    name: "the country is mixed",
    of: "the smaller of grass and forest, as a share of the two together",
    // A floor with the arithmetic maximum written after it, not a range: the
    // smaller of two shares cannot pass a half, so nothing could ever fail this
    // from above and pretending otherwise would be a third dead ceiling. Half
    // is the two in perfect balance, which is the best this can be.
    lo: 0.1, hi: 0.5,
    value: (r) => {
      const v = last(r);
      const both = v.grass + v.forest;
      return both > 0 ? Math.min(v.grass, v.forest) / both : 0;
    },
    why: "the whole continent crossed barren to grass to forest in one year each and then never changed again. This is the area split only — whether both kinds of country exist at all. Whether they are in different *places* is a spatial question that no ratio can answer, and is asked separately below",
  },
  {
    name: "the woods take their time",
    of: "years before forest covers a tenth of the land",
    lo: 8, hi: 200,
    // Infinity and not `YEARS + 1`: with the default sixty years that sentinel
    // is 61, which sits inside this range, so a continent where the forest
    // never arrives at all — the failure this exists to catch — reported a
    // plausible year and passed.
    value: (r) => r.series.find((v) => v.forest / v.land > 0.1)?.year ?? Infinity,
    why: "a mature forest is about sixteen world-years by design. A continent that greens in two has no history in it, and one that never greens is barren",
  },
  {
    name: "the woods are clumped",
    of: "boundary per forest cell against the same trees scattered at random",
    lo: 0, hi: 0.8,
    value: (r) => last(r).edge,
    why: "the eye reads clumping before it reads anything else. Against chance and not against four, because raw boundary per cell falls as the square root of area for any fixed shape — so measured raw, a rule that merely grew more forest would read as better clumping. The first version of this check was raw, and its ceiling of 1.6 out of 4 read the world as nearly noise when at 7.6% cover a random scatter gives 3.7 and the world gives 2.1",
  },
  {
    name: "the woods are neither one nor a thousand",
    of: "share of all forest sitting in the largest wood",
    lo: 0.1, hi: 0.9,
    value: (r) => last(r).biggest,
    why: "one wood holding everything and forty holding a fortieth each are different countries, and mean canopy cannot tell them apart",
    known: "0.04 to 0.07, so the largest wood holds a twentieth of the forest. Read it beside the clumping figure and not alone: this is a percolation measure, and below the threshold even a well-aggregated field has no single dominant cluster, so some of this is the low forest cover rather than the arrangement",
  },
  {
    name: "the map is made of places",
    of: "how far from chance toward perfectly zoned, 0 to 1",
    lo: 0.25, hi: 1,
    value: (r) => last(r).mingle,
    why: "asked of every biome at once, because the area checks cannot see this. Grass and forest can stand in exactly the right proportion and be stirred through each other everywhere, and a map like that reads as static however good its histogram is. Zero is a world that drew each cell independently; a developed continent measures 0.5 to 0.6. The first version divided by chance instead, and its own ceiling was then 1/chance — so a world where one biome ran to 85% could not have passed however well arranged it was, which is the mistake the clumping figure had made one field higher up. A world of a single biome scores near the top here and ought to: everything is alike. What is wrong with such a world is its histogram, and the check above is the one that reads that",
  },
  {
    name: "slopes fail",
    of: "channels buried per year",
    lo: 5, hi: 400,
    value: (r) => r.series.reduce((n, v) => n + v.slides, 0) / YEARS,
    why: "it is the only rule that can make a closed basin, and it did nothing at all in three earlier versions of itself. Per year and with a real ceiling: the first version totalled over the whole run against a bound above the number of cells in the world, which is a floor dressed as a range",
  },
  {
    name: "the world burns, rarely",
    of: "fires per hundred years",
    lo: 5, hi: 300,
    value: (r) => (fires(r).length * 100) / YEARS,
    why: "fire is the only thing that happens to a world that has finished growing. Without it the map is done the day the last cell matures; with too much of it nothing grows old",
  },
  {
    name: "fires differ in size",
    of: "the median fire against the largest",
    lo: 0, hi: 0.9,
    value: (r) => {
      const f = fires(r);
      // Too few to say. Returning 0 here — "perfectly varied" — let a world
      // that never burned at all sail through the check about how its fires
      // differ, which is the same hole the "never arrived" sentinel had.
      // Not a number fails, and the rate check above says what is really wrong.
      if (f.length < 3) return NaN;
      return median(f) / Math.max(...f);
    },
    why: "if every fire is the same size then one number decides how big a fire is, and the fuel, the wet ground and the rivers that are supposed to stop it never get a say",

  },
];

function run(seed: number): Run {
  const [w, start] = opening(seed);
  let was = start;
  const series: Vitals[] = [vitals(w, 0, was)];
  chronicle();   // whatever an earlier seed left is not this one's history
  const events: Event[] = [];
  was = Int16Array.from(w.elev);
  for (let year = 1; year <= YEARS; year++) {
    for (let d = 0; d < DAYS; d++) step(w);
    events.push(...chronicle());
    if (year % EVERY === 0 || year === YEARS) {
      series.push(vitals(w, year, was));
      was = Int16Array.from(w.elev);
    }
  }
  return { seed, series, events };
}

// Fixed, and the live world's seed among them: a property that holds on three
// continents and not on the one that is actually running is not much use.
const SEED_LIST = [1234, 20260910, 7, 4242, 99].slice(0, SEEDS);

// One process a seed. They share nothing — the sim keeps scratch arrays and a
// chronicle at module scope, and a fresh process is the only way to be certain
// one continent's leftovers never reach another's measurements — and the wall
// clock becomes one seed's instead of all of them.
const ALONE = process.env.ERAS_SEED;
if (ALONE) {
  // Checked before the run and not after it: `process.send` exists only down an
  // IPC channel, so running this file by hand with ERAS_SEED set would
  // otherwise simulate for minutes and then throw with nothing to show for it.
  if (!process.send) throw new Error("ERAS_SEED only means anything to a forked child");
  process.send(run(Number(ALONE)));
} else {
  console.log(`${SEEDS} seeds, ${YEARS} years of ${DAYS} days each, side by side.`);
  const started = Date.now();
  const children: ReturnType<typeof fork>[] = [];
  const runs = await Promise.all(SEED_LIST.map((seed) => new Promise<Run>((ok, no) => {
    const child = fork(fileURLToPath(import.meta.url), process.argv.slice(2), {
      execArgv: process.execArgv,          // the child needs the same type stripping
      env: { ...process.env, ERAS_SEED: String(seed) },
    });
    children.push(child);
    child.on("message", (m) => {
      // Said as each one lands, not once at the end. The serial version printed
      // a line per seed, and without it a seed that hangs — which is exactly the
      // kind of regression this exists to catch — shows as nothing at all.
      console.log(`  seed ${seed} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
      ok(m as Run);
    });
    // A spawn that fails emits `error` and never emits `exit`, and an unhandled
    // `error` on an emitter takes the whole parent down with a stack trace
    // instead of a sentence.
    child.on("error", no);
    child.on("exit", (code) => no(new Error(`seed ${seed} exited ${code} with nothing to say`)));
  }))).catch((e) => {
    // The siblings are minutes of CPU each and would go on to send into a
    // channel that is already gone. Stop them before saying why.
    for (const c of children) c.kill();
    throw e;
  });
  console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s in all`);
  report(runs);
}

function report(runs: Run[]) {

// A check passes when every seed is inside the range. One seed out is the
// interesting case and gets named: the weather swings hard enough that a
// property true of the world can be false of one decade of one continent.
let failed = 0, expected = 0;
const rows: string[] = [];
const standing: Check[] = [];   // known failures that are still failing
let unasked = 0;
for (const c of CHECKS) {
  // A run too short to answer a question has not answered it. Saying "ok" here
  // would be the same lie as a sentinel inside its own range: a pass nobody
  // earned, on a check nobody ran.
  if (c.needs !== undefined && YEARS < c.needs) {
    unasked++;
    rows.push(`--    ${c.name.padEnd(38)}${"not asked".padStart(24)}   needs ${c.needs} years`);
    continue;
  }
  const got = runs.map((r) => ({ seed: r.seed, v: c.value(r) }));
  // Number.isFinite first, because NaN fails both comparisons and would
  // otherwise read as inside the range. A check that cannot be computed has
  // not passed.
  const out = got.filter(({ v }) => !Number.isFinite(v) || v < c.lo || v > c.hi);
  const mark = out.length === 0 ? "ok  " : c.known ? "known" : "FAIL";
  if (out.length > 0) {
    if (c.known) { expected++; standing.push(c); } else failed++;
  }
  const shown = got.map(({ v }) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0))).join(" ");
  rows.push(`${mark.padEnd(6)}${c.name.padEnd(38)}${shown.padStart(24)}   want ${c.lo}..${c.hi}`);
  if (out.length > 0 && out.length < runs.length) {
    rows.push(`${" ".repeat(6)}  out on ${out.map((o) => o.seed).join(", ")} only — ${c.of}`);
  }
}
console.log();
console.log(`${"".padEnd(6)}${"".padEnd(38)}${runs.map((r) => r.seed).join(" ").padStart(24)}`);
for (const r of rows) console.log(r);
console.log();
// Only the ones that actually failed. A known failure that has stopped failing
// is news, and printing its excuse every run would hide that it had.
for (const c of standing) console.log(`known: ${c.name} — ${c.known}`);
console.log();
const short = unasked > 0 ? `, ${unasked} not asked at ${YEARS} years` : "";
console.log(failed === 0
  ? `the world is still itself (${expected} known failures stand${short})`
  : `${failed} unexpected, ${expected} known${short}. A range is either wrong or the world is`);
process.exitCode = failed === 0 ? 0 : 1;
}

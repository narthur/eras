// The world's vital signs, over as long a run as you care to wait for.
//
// This prints them. It is not a test: nothing here passes or fails, and no
// number is asserted. It puts two runs side by side — before a change and
// after it, or one constant against another. For the version that says whether
// the world still has the right shape, see `character`.
//
//   pnpm bench                 a century of seed 1234
//   pnpm bench 200 7           two centuries of seed 7
//   pnpm bench 40 1234 5       forty years, reported every five
//
// The numbers that have caught something, and what they caught:
//
//   basins    closed depressions. With nothing in the rules able to make one,
//             these fell 246 → 25 over two centuries and took the lakes with
//             them, which is what slope failure was added for
//   lakes     cells under standing water. Swings with the weather, so read it
//             against the basin count rather than on its own
//   ponded    total standing water. The same thing without the threshold, so
//             a world drying out shows here before the lake count moves
//   damp      median soil moisture. Sat at 100% over seven eighths of the land
//             for forty years while every growth rule quietly used it
//   fall      median drop to the lowest neighbour: whether the land still has
//             relief, or diffusion has ground it flat
//   soil      mean loose material. Ran away to 3000mm once and strangled the
//             rivers, which showed up as their discharge falling by two thirds
//   veg       mean canopy, and how much of the land is grass against forest.
//             Crossed barren → grass → forest in one year each when the growth
//             rule took no account of the cell
//   raw/clmp  how ragged the woods are: non-forest neighbours per forest cell,
//             then that same figure divided by what the trees scattered at
//             random over the same land would give. Read the second one. Raw
//             boundary per cell falls as the square root of area for any fixed
//             shape, so a rule that only grew more forest reads as better
//             clumping and one that shrank it reads as fragmentation — which
//             is the comparison this is for. Below one is clumped; one is
//             indistinguishable from noise
//   mingl     neighbouring land sharing a biome, against the chance of it.
//             Asked of every biome at once, because grass and forest can sit
//             in exactly the right proportion and still be stirred through
//             each other everywhere, and no per-class number can see it
//   woods     how many separate woods, and what share of all forest is in the
//             largest. One wood holding everything is a different country from
//             forty holding a fortieth each, and mean canopy cannot tell them
//             apart
//   river     the longest reach, which is how the priority flood was found to
//             be necessary: without it nothing ran past about thirty cells
//   slides    channels buried since the last report. A drop of a given size
//             does not identify a slide — `carve` takes up to BITE, four
//             metres of bedrock, in one pass, so ordinary river incision
//             clears any threshold a landslide would. What is unique to a
//             slide is the other end of it: raising bedrock. Worldgen aside,
//             every other rule only ever lowers it, so a cell whose rock rose
//             was buried by a slide and nothing else. Two slides into one
//             channel inside one report window count once
//   ground    total rock and soil. Should not move at all. Sediment has been
//             silently destroyed at the soil ceiling twice
import { step, RULE_VERSION } from "./index.ts";
import { vitals, opening } from "./vitals.ts";

const YEARS = Number(process.argv[2] ?? 100);
const SEED = Number(process.argv[3] ?? 1234);
const EVERY = Number(process.argv[4] ?? Math.max(1, Math.round(YEARS / 10)));
const DAYS = 400;   // days to a year here. The world itself has no year in it —
                    // the viewer's clock happens to divide by 365 — so this is
                    // only the interval these rows are reported on

let [w, start] = opening(SEED);
let was = start;

function line(year: number, ms: number) {
  const v = vitals(w, year, was);
  was = Int16Array.from(w.elev);
  console.log([
    String(v.year).padStart(5),
    String(v.basins).padStart(6),
    String(v.lakes).padStart(6),
    (v.ponded / 1e6).toFixed(2).padStart(7),
    `${v.damp}%`.padStart(5),
    `${(v.saturated * 100).toFixed(0)}%`.padStart(4),
    String(v.fall).padStart(5),
    v.soil.toFixed(0).padStart(5),
    `${(v.veg * 100).toFixed(0)}%`.padStart(4),
    String(v.grass).padStart(6),
    String(v.forest).padStart(6),
    v.edgeRaw.toFixed(2).padStart(5),
    v.edge.toFixed(2).padStart(5),
    v.mingle.toFixed(1).padStart(5),
    `${v.patches}/${(v.biggest * 100).toFixed(0)}%`.padStart(9),
    String(v.river).padStart(6),
    String(v.slides).padStart(6),
    (v.ground / 1e6).toFixed(3).padStart(9),
    ms > 0 ? ms.toFixed(1).padStart(5) : "    -",
  ].join(" "));
}

console.log(`seed ${SEED}, rules v${RULE_VERSION}, ${YEARS} years of ${DAYS} days, reported every ${EVERY}`);
console.log([
  " year", "basins", " lakes", " ponded", " damp", " sat", " fall", " soil", " veg",
  " grass", "forest", "  raw", " clmp", "mingl", "woods/big", " river", "slides", "   ground", "ms/t",
].join(" "));
line(0, 0);
let spent = 0, ticked = 0;
for (let year = 1; year <= YEARS; year++) {
  const t0 = Date.now();
  for (let d = 0; d < DAYS; d++) w = step(w).world;
  spent += Date.now() - t0;
  ticked += DAYS;
  if (year % EVERY === 0 || year === YEARS) {
    line(year, spent / ticked);      // milliseconds a tick since the last report
    spent = 0;
    ticked = 0;
  }
}

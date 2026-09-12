// The world's vital signs, over as long a run as you care to wait for.
//
// Every rule added so far has been judged by re-measuring the same dozen
// things, and every time the measuring was rewritten from scratch in a scratch
// file and thrown away. This is that measurement, kept. It is not a test:
// nothing here passes or fails, and no number is asserted. It prints what the
// world is doing so that two runs can be put side by side — before a change
// and after it, or one constant against another.
//
//   pnpm bench                 a century of seed 1234
//   pnpm bench 200 7           two centuries of seed 7
//   pnpm bench 40 1234 5       forty years, reported every five
//
// The numbers that have caught something, and what they caught:
//
//   basins    closed depressions. Fell 246 → 25 over two centuries with
//             nothing able to make one, which is what slope failure is for
//   lakes     cells under standing water. Swings with the weather, so read it
//             against the basin count rather than on its own
//   ponded    total standing water. The same thing without the threshold, so
//             a world drying out shows here before the lake count moves
//   damp      median soil moisture. Sat at 100% over seven eighths of the land
//             for forty years while every growth rule quietly used it
//   fall      median drop to the lowest neighbour: whether the land still has
//             relief, or diffusion has ground it flat
//   soil      total loose material. Ran away to 3000mm once and strangled the
//             rivers, which showed up as their discharge falling by two thirds
//   veg       mean canopy, and how much of the land is grass against forest.
//             Crossed barren → grass → forest in one year each when the growth
//             rule took no account of the cell
//   river     the longest reach, which is how the priority flood was found to
//             be necessary: without it nothing ran past about thirty cells
//   scars     ground that dropped more than two metres since the last report.
//             Weathering takes a decimetre at a time and creep takes none, so
//             this counts slope failures and nothing else
//   ground    total rock and soil. Should not move at all. Sediment has been
//             silently destroyed at the soil ceiling twice
import { generate, step, biome, Biome, features, submerged, CELLS, SIZE, VEG_MAX, RULE_VERSION } from "./index.ts";

const YEARS = Number(process.argv[2] ?? 100);
const SEED = Number(process.argv[3] ?? 1234);
const EVERY = Number(process.argv[4] ?? Math.max(1, Math.round(YEARS / 10)));
const DAYS = 400;   // days in a year, as the rest of the world counts them

const w = generate(SEED);
let was = Int16Array.from(w.elev);

function line(year: number, ms: number) {
  let basins = 0, lakes = 0, ponded = 0, ground = 0, soil = 0, veg = 0;
  let grass = 0, forest = 0, land = 0, scars = 0, saturated = 0;
  const falls: number[] = [], damps: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    ground += w.elev[i] * 100 + w.soil[i];
    if (was[i] - w.elev[i] >= 20) scars++;
    if (submerged(w, i)) continue;
    land++;
    soil += w.soil[i];
    veg += w.veg[i];
    const b = biome(w, i);
    if (b === Biome.Lake) lakes++;
    if (b === Biome.Grass) grass++;
    if (b === Biome.Forest) forest++;
    const over = w.water[i] - (w.soil[i] >> 3);
    if (over > 0) ponded += over;
    // Moisture as the plants feel it: the root zone, not the whole profile.
    const root = Math.min(w.soil[i], 1200) >> 3;
    if (root > 0) {
      const damp = ((w.water[i] * 100) / root) | 0;
      damps.push(damp);
      if (damp >= 100) saturated++;
    }
    // The drop to the lowest neighbour. No neighbour lower is a closed basin.
    const here = w.elev[i] * 100 + w.soil[i];
    const x = i % SIZE, y = (i / SIZE) | 0;
    let low = here;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const t = w.elev[ny * SIZE + nx] * 100 + w.soil[ny * SIZE + nx];
        if (t < low) low = t;
      }
    }
    if (here === low) basins++; else falls.push(here - low);
  }
  falls.sort((a, b) => a - b);
  damps.sort((a, b) => a - b);
  was = Int16Array.from(w.elev);
  const river = features(w).find((f) => f.kind === "river");
  const cols = [
    String(year).padStart(5),
    String(basins).padStart(6),
    String(lakes).padStart(6),
    (ponded / 1e6).toFixed(2).padStart(7),
    `${damps[damps.length >> 1]}%`.padStart(5),
    `${((saturated / land) * 100).toFixed(0)}%`.padStart(4),
    String(falls[falls.length >> 1]).padStart(5),
    (soil / land).toFixed(0).padStart(5),
    `${((veg / land / VEG_MAX) * 100).toFixed(0)}%`.padStart(4),
    String(grass).padStart(6),
    String(forest).padStart(6),
    String(river?.size ?? 0).padStart(6),
    String(scars).padStart(6),
    (ground / 1e6).toFixed(3).padStart(9),
    ms > 0 ? ms.toFixed(1).padStart(5) : "    -",
  ];
  console.log(cols.join(" "));
}

console.log(`seed ${SEED}, rules v${RULE_VERSION}, ${YEARS} years of ${DAYS} days, reported every ${EVERY}`);
console.log([
  " year", "basins", " lakes", " ponded", " damp", " sat", " fall", " soil", " veg",
  " grass", "forest", " river", " scars", "   ground", "ms/t",
].join(" "));
line(0, 0);
let spent = 0, ticked = 0;
for (let year = 1; year <= YEARS; year++) {
  const t0 = Date.now();
  for (let d = 0; d < DAYS; d++) step(w);
  spent += Date.now() - t0;
  ticked += DAYS;
  if (year % EVERY === 0 || year === YEARS) {
    line(year, spent / ticked);      // milliseconds a tick since the last report
    spent = 0;
    ticked = 0;
  }
}

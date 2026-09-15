import { type Event, happening } from "./chronicle.ts";
import { CELLS, VEG_MAX, type World, hash2, neighbours } from "./grid.ts";
import { type Coast, coastline, sea } from "./sea.ts";

// Soil moves downhill without waiting for rain. Frost lifts it, roots prise it,
// animals kick it, and gravity takes the rest: on any slope the loose material
// creeps, faster the steeper it is. This is the other half of a valley — the
// river cuts the line, creep grades the ground on either side of it and rounds
// off what the noise of worldgen left sharp. Run with the drainage rather than
// daily, at a pass's worth each time, because nothing here moves in a day.
const CREEP = 5;      // ten-thousandths of the fall between two cells, per pass

const CLIFF = 6000;   // millimetres of fall past which creep no longer quickens

// A slope fails into the river that undercut it, and dams it.
//
// This is the one rule in the world that can make a closed basin. Everything
// else grades the land down — sediment fills pits, creep rounds them off, and
// tectonics is excluded from the tick by design. Before this rule the 246
// depressions worldgen leaves were a gift the world spent: 170 left by year
// ten, 25 by year two hundred, and a single cell of standing water. With it the
// count climbs instead — 380 by year twenty and 446 by year one hundred, with
// 296 cells under standing water at year fifty against the 53 the same world
// had without. The year matters and is easy to leave off: the lakes are not
// monotonic, and the same run reads 584 cells at year twenty and 130 at year
// two hundred.
//
// Written from the channel rather than from the hillside, which is the whole
// of what makes it work. Asked the obvious way round — take the steepest
// faces on the continent and let them fail downhill — it dams nothing,
// because steepness and drainage are anti-correlated here: of the 547 faces
// with a thirty-metre drop, exactly one had a stream at the foot of it, and
// the trunk valleys that carry the water are broad and gentle. Sending the
// debris down the gully to look for water was no better; the walk stalls on
// the first flat, and the median face cannot reach a channel carrying more
// than one cell's worth of rain. Undercutting is the real mechanism anyway: a
// river cuts the toe out of the slope above it, saturated ground on that
// slope lets go, and the channel is buried — which is why landslide dams sit
// on rivers rather than wherever the ground happens to be steepest.
//
// The debris arrives as bedrock, not soil, and that also decides whether the
// rule works. Delivered as soil a dam is a sponge and a snack: field capacity
// is soil/8, so six metres of debris holds 750mm of water against the sky and
// no pond forms, and `carve` takes loose material first, so the stream cuts
// it within a pass. Measured that way it raised the depression count to 225
// at year thirty against the baseline's 119 and still left the standing water
// *lower* — more basins, drier world. So rock moves as rock and soil as soil,
// each conserved in its own unit, and nothing converts.
const DAMS = 500;         // drainage past which a channel is worth damming. Set

                          // at the trunk rivers instead, the dams were cut as
                          // fast as they were built: the bigger the stream, the
                          // more cutting power stands against what blocks it
const SCARP = 6000;       // millimetres a face must stand above the channel

const SHED = 1;           // the face fails to the level of the channel below it,

                          // so the channel rises by the whole height it stood
                          // under. Anything less is cut straight back out: BITE
                          // lets a river take four metres of bedrock in one
                          // pass, and a third of the face height came to 3.6-5.6m,
                          // so every dam of that size went in the pass that
                          // built it and the basin count moved by three in
                          // thirty years
const SLIDE_ODDS = 0.100; // per undercut channel per pass of 64 days. A slope

                          // that stayed wet would go inside two years, but the
                          // wet precondition is intermittent and the eligible
                          // faces are few: the continent buries about forty
                          // channels a year at this figure
// Metres of rock below which a slide is not news. Measured over forty years:
// the continent sheds about fifty a year, median fifteen metres, and a record
// that took all of them would be a list of one kind of thing with a fire lost
// somewhere in it. Four a year clear this bar, which is a pace that takes
// months of watching to fill a panel rather than an afternoon. The ground still
// moves either way — this decides what is written down, not what happens.
//
// Forty years and not three, which is what this said before and is long enough
// to mislead: the young world's slides are smaller and rarer, so three years
// gives a median of ten metres and barely one a year over the bar. The rivers
// have to cut before there is much for them to undercut.
const LOUD = 40;

export function slump(w: World, coast: Coast = coastline(w)): Event[] {
  const { elev, soil, water, veg, flow } = w;
  const told: Event[] = [];
  // Face, channel and rock, decided before any of it moves, three numbers to a
  // slide. Collected first and applied after, so a slide that ran as it was
  // found could not bury a channel a later cell was still measuring itself
  // against — the reason this is two loops and not one.
  const slides: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (flow[i] <= DAMS) continue;
    const here = elev[i] * 100 + soil[i];
    if (coast[i] === 1) continue;
    // The highest slope standing over this reach, and it has to be wet. Ground
    // holding all it can is ground with no friction left, which is why real
    // slopes fail in the wet and not in the drought — and it ties the one rule
    // that builds relief to the weather.
    let face = -1, top = here + SCARP;
    for (const j of neighbours(i)) {
      if (water[j] < soil[j] >> 3) continue;
      const there = elev[j] * 100 + soil[j];
      if (there > top) { top = there; face = j; }
    }
    if (face < 0) continue;
    // Roots hold the face together, as they hold the riverbed and the hillside.
    const odds = (SLIDE_ODDS * VEG_MAX) / (VEG_MAX + veg[face] * 3);
    if (hash2(i, w.tick, w.seed + 2311) >= odds) continue;
    // Decided against the ground as it stood and applied afterwards, for the
    // same reason fires are collected rather than lit where they start: a
    // slide that ran as it was found would bury a channel that a later cell
    // was still measuring itself against, so what failed would depend on
    // which way the scan happened to be going.
    // Measured on the rock, not on the surface. The loose soil goes as well as
    // the rock, so taking the whole surface difference in bedrock and then
    // sending the soil after it cuts the face past the channel by exactly its
    // own soil depth — it fails *to* the level below it, not through it.
    const rock = ((elev[face] - elev[i]) / SHED) | 0;
    slides.push(face, i, rock > 0 ? rock : 0);
  }
  for (let k = 0; k < slides.length; k += 3) {
    const face = slides[k], dam = slides[k + 1];
    let rock = slides[k + 2];
    // A ridge cell can stand over two channels and be picked by both, and the
    // second of those was measured against ground that has already gone. Never
    // stand the ground on its head: a face no longer above its channel has
    // nothing left to give it.
    if (elev[face] * 100 + soil[face] <= elev[dam] * 100 + soil[dam]) continue;
    // Only what fits. What will not fit stays on the face rather than being
    // quietly destroyed — the ground has to balance. Soil needs the guard;
    // rock does not, and a clamp on it would be dead code dressed as caution:
    // the amount is elev[face] - elev[dam], so the channel lands exactly where
    // the face was and the face exactly where the channel was, both of which
    // were representable a moment ago. Neither end can leave Int16.
    const loose = Math.min(soil[face], 65535 - soil[dam]);
    if (rock <= 0 && loose <= 0) continue;
    elev[face] -= rock;
    elev[dam] += rock;
    soil[face] -= loose;
    soil[dam] += loose;
    veg[face] = 0;                               // a fresh scar is bare rock
    veg[dam] = 0;                                // and the channel is buried
    // Filed against the channel rather than the face: what makes this worth
    // recording is the river that stopped, not the hillside that is now short.
    // In metres of rock, which is what elev counts in tens of.
    const fell = (rock / 10) | 0;
    if (fell >= LOUD) told.push(happening(w, "slide", dam, fell));
  }
  return told;
}

export function crawl(w: World, coast: Coast) {
  const { elev, soil, veg } = w;
  const level = sea(w.tick, w.seed);
  // Read from a copy, write to the live ground. Read and write the same array
  // and a cell can pass on soil that only arrived this pass, which it can only
  // do from the side the scan came from — creep would run faster downhill to
  // the south-east than to the north-west, for no reason but the loop order.
  // The soil as it stood when the pass began. Creep has to read one surface and
  // write another, or a cell is fed by a neighbour that already crept this
  // morning and the hillside walks in whichever direction the loop runs.
  const was = Uint16Array.from(soil);
  const side = new Int32Array(8);    // where this cell is shedding to
  const share = new Int32Array(8);   // and how much it would send each way
  for (let i = 0; i < CELLS; i++) {
    const have = was[i];
    const here = elev[i] * 100 + have;
    if (have === 0 || coast[i] === 1) continue;
    let n = 0, demand = 0;
    for (const j of neighbours(i)) {
      // A neighbour under the sea is the shoreline, not its own bed: soil that
      // creeps to the water's edge is gone, and how deep the water is beyond
      // has nothing to do with how fast the hillside above it moves. Measured
      // the other way, the drop into deep water sets the rate all round the
      // coast and the continent wears a ring of bare rock.
      const there = elev[j] * 100 + was[j];
      // Soil that creeps to the water's edge is gone, and the sea's surface is
      // the floor under that — but only where the sea is. Into a dry hollow the
      // hillside sheds onto the hollow's own floor, however far below the
      // datum that floor happens to lie.
      const floor = coast[j] === 1 ? level : there;
      let fall = here - (floor > there ? floor : there);
      if (fall <= 0) continue;
      // And past sixty metres in one cell it is a face rather than a hillside.
      // Left proportional, the steepest ground sheds soil faster than bedrock
      // can weather into it and all of it goes to bare rock.
      if (fall > CLIFF) fall = CLIFF;
      // Roots hold the ground here as they hold it in the riverbed.
      let move = (((fall * CREEP) / 10000) * VEG_MAX) / (VEG_MAX + veg[i] * 3) | 0;
      if (move > fall >> 3) move = fall >> 3;   // never stand the ground on its head
      if (move <= 0) continue;
      side[n] = j;
      share[n] = move;
      n++;
      demand += move;
    }
    for (let k = 0; k < n; k++) {
      // A cell with less soil than it would shed loses the same fraction on
      // every side, rather than filling the first sides the loop happens to
      // reach and leaving the rest of the hill standing.
      let move = demand > have ? ((share[k] * have) / demand) | 0 : share[k];
      const j = side[k];
      if (move > 65535 - soil[j]) move = 65535 - soil[j];
      if (move <= 0) continue;
      soil[i] -= move;
      soil[j] += move;
    }
  }
}

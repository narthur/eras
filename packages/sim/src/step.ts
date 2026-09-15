import { type Event, happening } from "./chronicle.ts";
import { FIRE_ODDS, burn } from "./fire.ts";
import { RIVER_EVERY, drain } from "./flood.ts";
import { CELLS, RULE_VERSION, VEG_MAX, type World, clamp, copy, hash2, neighbours } from "./grid.ts";
import { SHELTER, carry, fills, near } from "./growth.ts";
import { coastline, notchOf, sea } from "./sea.ts";
import { OPEN, STORMS, falling, fronts, weather } from "./weather.ts";

/**
 * A world and everything else the day produced. `step` hands this back rather
 * than leaving the events and the water accounts in module variables for a
 * caller to come and collect: a global that has to be drained in the right
 * order is a race waiting for a second caller, and this world has already lost
 * a day's events to exactly that.
 */
export type Day = { world: World; events: Event[]; budget: Budget };

// Where the day's water came from and went. Every line in the tick that changes
// `water` by anything other than moving it from one cell to another adds itself
// up here, so the total on the map can be reconciled against them exactly. It
// exists because the sea used to conjure water into any low hollow and nothing
// noticed for days: `ground is conserved` follows rock and soil, and no check
// followed water at all. It also catches the quieter thing — the ceilings at
// 65535 silently destroying what will not fit.
export type Budget = {
  rained: number;    // fell out of the sky
  dried: number;     // went back into it
  tide: number;      // the sea set it, being a sink and a source both
  spilled: number;   // lost at the Uint16 ceiling, which should be nothing
};

/**
 * Four running totals over a 65,536-cell pass. Kept as one mutable object made
 * fresh each day and handed back at the end of it: a reduce that returned a new
 * object per cell would allocate a quarter of a million of them a tick to
 * express four additions. This is the performance exception, and it is the
 * whole of it — the object never leaves the `step` that made it.
 */
const ledger = (): Budget => ({ rained: 0, dried: 0, tide: 0, spilled: 0 });

/** The water standing on the whole map, in millimetres. */
export function puddle(w: World): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) n += w.water[i];
  return n;
}

/**
 * One world-day: rain, flow, erosion, deposition, growth, fire. Takes the world
 * as it stands and hands back the next one, what happened in it, and where the
 * day's water came from and went. The world passed in is not touched.
 */
export function step(prev: World): Day {
  const w = copy(prev);
  const { elev, soil, water, veg, rain } = w;
  const events: Event[] = [];
  const day = ledger();
  // Where lightning struck, collected as the growth loop runs and lit after it.
  // Lighting them where they are found would let a fire spread into cells that
  // had not grown yet today, and the rules would depend on the loop order.
  const fires: number[] = [];
  // Where the water goes, as against where today's water is. Rare, and pinned
  // to the day rather than to how long this copy of the world has been awake.
  // Also on the first tick under new rules, since a world that arrives carrying
  // some older idea of what `flow` meant should not draw rivers from it.
  const dug = (w.tick % RIVER_EVERY === 0 || w.ruleVersion !== RULE_VERSION) ? drain(w) : undefined;
  if (dug) events.push(...dug.events);
  // The mask the rest of the day reads. On a drain day it is the one drawn
  // after the ground moved, which is what the old cache would have held; on
  // every other day nothing has moved the ground since yesterday, so a fresh
  // one is the same answer. Carried to the end of the tick deliberately: the
  // weathering below adds soil, and taking the coastline again after it would
  // be a different rule than the one this world has always run.
  const coast = dug ? dug.coast : coastline(w);

  // rain, then evaporation. Vegetation holds moisture back.
  const wet = weather(w.tick, w.seed);
  const level = sea(w.tick, w.seed);
  // Day one has no yesterday to have crossed anything from.
  if (w.tick > 0 && notchOf(level) !== notchOf(sea(w.tick - 1, w.seed))) {
    events.push(happening(w, "sea", -1, (level / 1000) | 0));
  }
  const sky = fronts(w.tick, w.seed);
  // The surface the runoff reads, and the order it reads it in. Both fill as
  // the rain loop below runs and are used by the pass after it, so they are
  // made here rather than inside either.
  const height = new Int32Array(CELLS);
  const order = new Int32Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    if (coast[i] === 0) {
      // A sixteenth of the day's rainfall weight reaches the ground as water,
      // about 3 metres a year on the median cell, where an eighth was seven
      // metres — wetter than any rainforest — and
      // — the part that showed — evaporation takes 12% of the store a day, so
      // the store settled at eight times the daily input, above what the soil
      // can hold. Every cell that was not desert therefore stood brim full with
      // the surplus running off, and the damp reading was 100% over seven
      // eighths of the land. Now the store settles below the brim and follows
      // the rain and the ground it sits on: ridges and rain shadows dry, valley
      // floors wet because what falls upslope arrives in them.
      //
      // And it arrives in storms rather than as a daily drizzle. That is not
      // decoration: soil below field capacity soaks up an average day entirely,
      // so a world watered evenly never spills, and a world that never spills
      // has no runoff, no standing water and no lakes in it, however much rain
      // falls. A storm lands eight days' worth at once, the soil takes what it
      // can hold and the rest runs off — which is how a landscape can be half
      // dry and still have rivers in it. Drawn for a patch of country rather
      // than a cell, because weather arrives as fronts.
      const fell = (((rain[i] * wet) / 100) | 0) >> 4;
      const pour = falling(sky, i);
      if (pour > 0) {
        const drop = (fell * STORMS * pour) / 1000 | 0;
        const was = water[i];
        water[i] = Math.min(65535, was + drop);
        day.rained += water[i] - was;
        day.spilled += drop - (water[i] - was);
      }
      // Two different things dry out at two different rates. Water held in the
      // soil goes as a share of what is there, faster where there is no canopy
      // over it. Water standing on the surface goes as a depth, a few
      // millimetres a day off the top, the way a pond does — taken as a share
      // of the whole store instead, a lake a metre deep lost 160mm a day,
      // fifty-eight metres a year, and no pit on the continent could hold
      // water long enough to become one.
      const cap = soil[i] >> 3;
      const stored = water[i] < cap ? water[i] : cap;
      const standing = water[i] - stored;
      const dries = (stored * (160 - ((veg[i] * 80) / VEG_MAX | 0))) / 1000 | 0;
      const before = water[i];
      water[i] = Math.max(0, before - dries - (standing < OPEN ? standing : OPEN));
      day.dried += before - water[i];
    }
    height[i] = elev[i] * 100 + soil[i] + water[i];
    order[i] = i;
  }

  // Flow downhill, highest surface first, so water crosses the map in one pass.
  // Ties break on index: the iteration order is part of the rules.
  const ord = order.sort((a, b) => height[b] - height[a] || a - b);

  for (let k = 0; k < CELLS; k++) {
    const i = ord[k];
    if (water[i] === 0) continue;
    let lowest = -1, lowestH = height[i];
    for (const j of neighbours(i)) {
      if (height[j] < lowestH) { lowestH = height[j]; lowest = j; }
    }
    if (lowest < 0) continue;
    // soil holds moisture back; only what it cannot hold runs off
    const spare = water[i] - (soil[i] >> 3);
    if (spare <= 0) continue;
    // move half the head difference, never more than there is spare water
    const t = Math.min(spare, (height[i] - lowestH) >> 1);
    if (t === 0) continue;
    water[i] -= t;
    const had = water[lowest];
    water[lowest] = Math.min(65535, had + t);
    day.spilled += t - (water[lowest] - had);

    height[i] = elev[i] * 100 + soil[i] + water[i];
    height[lowest] = elev[lowest] * 100 + soil[lowest] + water[lowest];
  }

  const dawn = Uint16Array.from(veg);   // the canopy every cell is seeded from, before any of it grows
  for (let i = 0; i < CELLS; i++) {
    // The sea is a sink: it refills to its own level and swallows what arrives.
    // Only where it has actually reached, though — filling every low cell put
    // water into hollows nothing could have carried it to, and conjured it
    // besides, since this is an assignment and not a transfer. A basin walled
    // off below sea level now takes rain like any other basin and ponds by the
    // same rules, which is what a Caspian is.
    if (coast[i] === 1) {
      const stood = water[i];
      water[i] = Math.max(0, level - (elev[i] * 100 + soil[i]));
      day.tide += water[i] - stood;
      veg[i] = Math.max(0, veg[i] - 50);
      continue;
    }
    // Bedrock weathers into soil: the same stuff in another state, so the
    // ground does not rise — it only becomes something that can be carried.
    // Taking the rock rather than conjuring the soil is what lets a slope
    // retreat: creep strips the loose material off it, the bare rock beneath
    // weathers in turn, and the hillside works its way back. It stops once
    // there is soil enough to bury the rock, which is also what keeps flat
    // country from deepening for ever and strangling the rivers — they fell
    // by two thirds over forty years when soil ran away to 3000mm. Staggered
    // by cell, so the continent does not weather all on the same morning.
    if (soil[i] < 1200 && elev[i] > 0 && (w.tick + i) % 1600 === 0) {
      soil[i] += 100;
      elev[i] -= 1;
    }
    const s = soil[i], held = s >> 3, excess = water[i] - held;
    // Roots reach the top of the profile, not the bottom of it. Water held
    // below them is still held — it is why the runoff calculation uses the
    // whole depth — but it is not water the plant can drink, and counting it
    // would make the deepest ground the driest: a delta with twenty-five
    // metres of silt on it would read as a desert and stay bare forever.
    const root = (s < 1200 ? s : 1200) >> 3;
    // What this cell can carry. Rainfall is the permanent term: it varies two to
    // one across the continent and never moves, so it is what makes forest
    // country and grass country different places rather than different years.
    // Soil gates the young world, which has not yet enough of it to root a
    // forest. Drought bites only when the ground falls well below what it can
    // hold — moisture alone was no use as the main term, because saturated soil
    // reads 100% nearly everywhere for the first forty years and every cell
    // then looks identical, which is how the whole continent used to cross from
    // barren to grass to forest in one year each and never change again.
    const damp = root > 0 ? ((water[i] * 100) / root) | 0 : 0;
    // Against the rain of the day rather than the map, so that what the land
    // can carry rises and falls with the decades and the margins move.
    const falls = ((rain[i] * wet) / 100) | 0;
    // What the cell can hold, and then what its neighbours let it hold. A wood
    // makes its own weather — shade, humus, shelter from the wind — so ground
    // inside one carries canopy that the same ground in the open would not.
    // This is the term that can join two woods into one: the rate bonus alone
    // only got a cell to its own ceiling faster, and a ceiling set by rainfall
    // is why six hundred separate woods never became six.
    const cap = carry(falls, s, damp) + SHELTER * near(dawn, i);
    let d: number;
    if (excess > 1200) d = -20;              // drowned
    else if (s < 80) d = -5;                 // bare rock
    else if (veg[i] > cap) d = -3;           // more canopy than the ground keeps
    else d = fills(cap);                     // good ground fills in faster
    veg[i] = clamp(veg[i] + d, 0, VEG_MAX);
    // Dry canopy, long odds, drawn from the cell and the day so the same world
    // burns in the same places. Collected rather than lit here: a fire that
    // spread while the growth loop was still running would reach cells that
    // had not grown yet today, and the rules would depend on the loop order.
    if (veg[i] > 5000 && falls < 150 && hash2(i, w.tick, w.seed) < FIRE_ODDS) fires.push(i);
  }
  for (const i of fires) {
    const burnt = burn(w, i);
    // A strike that finds nothing to take is not an event; it is weather.
    if (burnt > 0) events.push(happening(w, "fire", i, burnt));
  }
  w.tick++;
  w.ruleVersion = RULE_VERSION;   // stamp the rules that actually ran this tick
  return { world: w, events, budget: day };
}

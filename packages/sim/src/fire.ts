import { CELLS, VEG_MAX, type World, hash2, neighbours } from "./grid.ts";

// Fire is the only thing that happens to a world that has finished growing.
// Without it the map is done the day the last cell matures; with it the land
// keeps a patchwork of ages, because a burn grows back at its own cell's rate.
// Measured on seed 20260910 over sixty years, once the chronicle could be read:
// thirteen fires, the first in year fifteen — about one every five years. And
// twelve of the thirteen burnt exactly BURN_CAP cells, because spread was
// deterministic and the connected fuel region was ninety per cent of the
// continent. That is what `catches` below was written to fix.
// Five times what it was, because most strikes now come to nothing. The old
// figure was set when spread was certain and every strike became a fire of
// exactly the cap; with the odds of catching what they are, about a third of
// strikes take hold at all and the world was down to three fires a century on
// one seed, which is a world that has stopped happening.
export const FIRE_ODDS = 0.0000025;   // per dry canopy cell per day

const FUEL = 2000;             // canopy below this will not carry a fire at all

const DRY = 40;                // percent of root-zone moisture below which

                               // nothing is holding the fire back but the fuel
const BURN_CAP = 6000;         // cells: a backstop, not the rule. See `catches`

/**
 * Whether a cell takes fire when the flames reach it. This is the whole of what
 * decides how big a fire is, and it used to be decided by nothing: every
 * neighbour with fuel caught, so a fire ate its entire connected fuel region
 * and the only thing that ever stopped one was the cap. Measured at year 30,
 * that region was 17,872 cells — ninety per cent of everything burnable on the
 * continent, and thirty-six times the cap. So every fire was exactly the cap.
 *
 * Now a cell catches or it does not, on its own fuel and its own dryness, once
 * per day: a spread that is a coin flip per cell is site percolation, and
 * percolation has a threshold. Below it a fire dies where it started; above it
 * it runs to the edge of the dry ground; near it the size varies over orders of
 * magnitude, which is both what real fires do and the only way this world gets
 * a fire worth writing down. Dry decades put the continent above the threshold
 * and wet ones below, so fire is tied to the weather exactly as slope failure
 * is, and for the same reason.
 */
function catches(w: World, i: number): number {
  const root = Math.min(w.soil[i], 1200) >> 3;
  const damp = root > 0 ? Math.min(100, ((w.water[i] * 100) / root) | 0) : 0;
  // The drought term pivots, as the growth rule's does. Ground at half of what
  // it can hold is not wet — forests burn in that — and taken proportionally it
  // halved the odds everywhere and put the whole continent under the threshold,
  // where the biggest fire in four hundred strikes was thirty-six cells. It
  // bites from DRY upward instead, and only ground near saturation puts a fire
  // out on its own.
  const dry = damp >= 100 ? 0 : damp <= DRY ? 1 : (100 - damp) / (100 - DRY);
  // Thin grass at a fifth of full canopy catches at a fifth the rate, so the
  // open ground between two woods is a barrier without being declared one.
  // No coefficient in front of it: bone-dry closed canopy takes fire every
  // time, which is the honest ceiling and leaves nothing here to tune. The
  // odds simply are how much there is to burn, times how dry it is.
  return (w.veg[i] * dry) / VEG_MAX;
}

// Burns outward from the strike through anything dry enough to carry it.
//
// Nothing joins the edge twice — `queued` sees to that — so the fuel check at
// the top of the loop is not there to weed out duplicates any more, as it was
// before. What it still catches is the strike itself, which goes on the edge
// unconditionally: `burn` is exported, and a caller may strike bare ground.
//
// Both arrays are made per fire and thrown away with it. They used to be module
// -level and shared, which meant `queued` could not simply hold a flag — it
// held a stamp from a counter that rose with every fire ever lit, because
// clearing 65,536 cells per strike was the thing being avoided. That counter
// wrapped after two thousand million fires, which was five thousand million
// centuries away and still a thing that had to be written down and reasoned
// about. A fresh array is already zero, so the flag is just a flag.
export function burn(w: World, at: number): number {
  const { veg, water, soil } = w;
  const front = new Int32Array(CELLS);
  const queued = new Uint8Array(CELLS);
  let n = 0, burnt = 0;
  queued[at] = 1;
  front[n++] = at;
  // The next cell to catch is any cell on the edge, not the oldest or the
  // newest. Taking the newest sends the fire down one diagonal and scars the
  // country with straight lines; taking the oldest advances every side at the
  // same rate and burns a rectangle. Taking one at random off the whole edge
  // grows the blunt, ragged, roughly round patch a fire actually leaves.
  while (n > 0 && burnt < BURN_CAP) {
    const r = (hash2(at, burnt, w.tick + w.seed) * n) | 0;
    const i = front[r];
    front[r] = front[--n];   // whoever was last takes the empty place
    if (veg[i] < FUEL) continue;                   // burnt already, or no fuel
    if (water[i] - (soil[i] >> 3) > 0) continue;   // a river or a lake stops it
    // Keyed on the cell and the day, so a cell that would not catch does not
    // get a second answer when the flames arrive from another side. That is
    // what makes this percolation rather than a slow way of burning everything.
    if (hash2(i, w.tick, w.seed + 6151) >= catches(w, i)) continue;
    veg[i] = 0;
    burnt++;
    for (const j of neighbours(i)) {
      // Once each. The edge used to hold a cell once per side it was reachable
      // from, which gave the well-connected middle of a fire several times the
      // chance of being drawn next and pulled the shape inward.
      if (veg[j] >= FUEL && queued[j] === 0) { queued[j] = 1; front[n++] = j; }
    }
  }
  return burnt;
}

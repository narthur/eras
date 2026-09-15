import { RULE_VERSION, SIZE, type World } from "./grid.ts";

// What happened, as against what is. The world state is a photograph: it holds
// the dammed valley but not the day the slope came down, and a world that is
// only ever a photograph has no history in it to read. So the tick writes down
// the few things it does that are discrete enough to have a date.
//
// Only rare things. Erosion and growth happen everywhere every day and belong
// to the picture, not to the record; a chronicle that logged them would be a
// second copy of the world with none of its clarity. Features are left out for
// a different reason: they are derived and unnamed, so the same river arriving
// and departing as it flickers across a threshold would bury everything real.

export type EventKind = "fire" | "slide" | "sea";

export type Event =
  { tick: number; rules: number; kind: EventKind; x: number; y: number; size: number };

// The canonical list, exported so nothing downstream keeps its own copy of it.
// A reader that filters by kind and a writer that adds one have to be able to
// disagree loudly rather than quietly.
export const EVENT_KINDS = ["fire", "slide", "sea"] as const satisfies readonly EventKind[];

/**
 * One thing that happened, ready to be handed up. `at` is a cell, or -1 for the
 * things that happen to the whole world.
 *
 * A constructor and not a sink. This used to push onto a module-level array
 * that the caller drained, which meant the log had to be capped in case nobody
 * ever did, and meant a second caller draining between two ticks silently took
 * the first one's history. Neither problem exists once the day hands back what
 * it did: there is nothing to accumulate and nothing to race for.
 */
export function happening(w: World, kind: EventKind, at: number, size: number): Event {
  const x = at < 0 ? -1 : at % SIZE, y = at < 0 ? -1 : (at / SIZE) | 0;
  // The rules that are running, not `w.ruleVersion`, which is stamped at the end
  // of the tick and so still says yesterday's on the first day under new ones.
  // Old rows stay labelled with the rules of their era, which is the only way a
  // log that outlives its own thresholds stays self-describing.
  return { tick: w.tick, rules: RULE_VERSION, kind, x, y, size };
}

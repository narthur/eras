// The world. Pure state machine: no I/O, no clock, no randomness beyond the
// seed. This file is the doorway and nothing else: every rule lives in the
// module named for it, and everything the package offers is re-exported here so
// that a caller writes `from "@eras/sim"` and never has to know which.
//
// Read them in dependency order, which is also roughly the order a day happens
// in: grid, sea, weather, then the rules that move ground — erosion, flood —
// then fire and growth, and step, which composes the lot.

export { CELLS, RULE_VERSION, SIZE, VEG_MAX, type World } from "./grid.ts";
export { EVENT_KINDS, type Event, type EventKind } from "./chronicle.ts";
export { type Coast, coastline, sea, submerged } from "./sea.ts";
export { type Sky, VEER, rainfall, wave, weather } from "./weather.ts";
export { burn } from "./fire.ts";
export { carry, fills } from "./growth.ts";
export { slump } from "./erosion.ts";
export { generate } from "./worldgen.ts";
export { Biome, biome, pack, unpack } from "./biome.ts";
export { FEATURE_MIN, type Feature, type FeatureKind, features } from "./features.ts";
export { type Budget, type Day, step } from "./step.ts";

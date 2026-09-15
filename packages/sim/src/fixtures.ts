// Worlds and helpers more than one test file needs. Not a test file itself:
// vitest runs each `*.test.ts` in its own worker, so anything built here is
// built once per file that asks for it.
//
// Only what is shared or expensive. A cheap helper with one caller belongs
// beside its caller — `count` and `drains` lived here briefly and went back to
// the files that use them, because a shared module that is really six private
// ones is just indirection.

import { expect } from "vitest";
import { generate, step, CELLS, SIZE, VEG_MAX, type World, type Event } from "./index.ts";

/** Run a world on, and hand back both it and what happened while it did. */
export const run = (w: World, days: number): [World, Event[]] => {
  const told: Event[] = [];
  for (let i = 0; i < days; i++) {
    const day = step(w);
    w = day.world;
    told.push(...day.events);
  }
  return [w, told];
};

// Byte by byte, by hand. A failed toEqual on two worlds renders a diff of all
// 720KB of them, which takes ninety seconds and seven gigabytes to say what one
// offset says at once — found by breaking this on purpose. The comparison stays
// a raw loop for that reason, and only reaches for an assertion once it has
// something to report.
export const same = (x: ArrayBuffer, y: ArrayBuffer, what: string) => {
  const p = new Uint8Array(x), q = new Uint8Array(y);
  expect(p.length, `${what}: ${p.length} bytes against ${q.length}`).toBe(q.length);
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== q[i]) expect.fail(`${what}: byte ${i} is ${p[i]}, was ${q[i]}`);
  }
};

/** Total rock and soil, which nothing in the tick may create or destroy. */
export const ground = (w: World) => {
  let m = 0;
  for (let i = 0; i < CELLS; i++) m += w.elev[i] * 100 + w.soil[i];
  return m;
};

/**
 * A forty-metre face beside every channel, saturated, with a river in every
 * trough. Slope failure is asked on a made surface rather than through a run,
 * because the undercut channels are a few dozen cells of one world and a run
 * gives no way to know whether the ones that failed were the ones that should.
 */
export const face = (): World => {
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

/**
 * A channel already carrying all the debris it can hold. Built carefully,
 * because loading a channel with soil is what makes it tall: pile 65 metres
 * into the trough of `face` and the trough stands higher than the face, no face
 * is found, and the test passes by doing nothing.
 */
export const packed = (): World => {
  const w = face();
  for (let i = 0; i < CELLS; i++) {
    const high = (i % SIZE) % 2 === 0;
    w.elev[i] = high ? 1200 : 50;            // so the face still stands over it
    w.soil[i] = high ? 400 : 65400;          // with 135mm of room left below
  }
  return w;
};

/**
 * A channel running downhill with one wet face standing over it. `face` cannot
 * ask whether a dam leaves a closed basin: a checkerboard has no downstream.
 */
export const valley = (): World => {
  const w = face();
  const mid = SIZE >> 1;
  for (let i = 0; i < CELLS; i++) {
    const x = i % SIZE, y = (i / SIZE) | 0;
    w.elev[i] = y === mid ? 1000 - x : 3000;       // a channel falling a decimetre a cell
    w.soil[i] = 0;
    w.water[i] = 0;
    w.flow[i] = y === mid ? 5000 : 0;
  }
  const slope = (mid - 1) * SIZE + 100;            // one saturated slope over x=100
  w.elev[slope] = 1000 - 100 + 100;                // ten metres above the channel
  w.water[slope] = 65535;
  return w;
};

export const TICKS = 400;

/** A world already grown over, so there is something for a fire to take. */
export const mature = (): [World, Event[]] => {
  const m = generate(1234);
  m.veg.fill(9500);
  return run(m, TICKS);
};

export { VEG_MAX };

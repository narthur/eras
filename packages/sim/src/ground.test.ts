// Slope failure, asked directly. It is the only rule that can make a closed
// basin, so it is the only one holding the continent's lakes open past the
// first century — and it moves ground in two units at once, so it is exactly
// the shape of rule that silently destroys mass.

import { beforeAll, describe, expect, it } from "vitest";
import { slump, CELLS, SIZE, VEG_MAX, type Event } from "./index.ts";
import { face, ground, packed, valley, drains } from "./fixtures.ts";

// The forty-metre fixture, slumped for forty days. Shared by the checks below
// because several of them are about the same run seen from different sides.
let failures = 0, bared = 0;
const wrote: Event[] = [];

beforeAll(() => {
  const hill = face();
  const rock = ground(hill);
  // `slump` hands back what it buried, so this collects the record and the
  // ground in one pass. It used to have to drain a process-wide log first, in
  // case a loud slide from another test arrived in the middle of this one.
  for (let t = 0; t < 40; t++) {
    hill.tick = t;
    const before = Int16Array.from(hill.elev);
    wrote.push(...slump(hill));
    for (let i = 0; i < CELLS; i++) if (before[i] !== hill.elev[i]) failures++;
  }
  for (let i = 0; i < CELLS; i++) if ((i % SIZE) % 2 === 0 && hill.soil[i] === 0) bared++;

  expect(failures, "a saturated forty-metre face over a river has to fail").toBeGreaterThan(0);
  expect(ground(hill), "and a slide must not create or destroy any ground").toBe(rock);
  expect(bared, `a face that failed should be stripped to rock, ${bared} were`).toBeGreaterThan(0);
  for (let i = 0; i < CELLS; i++) {
    if (hill.soil[i] >= 65535) expect.fail("debris must not pile past the ceiling");
  }
});

describe("the chronicle of a slide", () => {
  // Asked here because this is where slides are certain. Through a run they are
  // not: the continent sheds about fifty a year and only a tenth of them clear
  // LOUD, so a seed can pass a year in silence — which is the point of the bar,
  // and makes a run a poor place to ask whether the writing-down works.

  it("is as reproducible as the world", () => {
    const rerun = face();
    const again: Event[] = [];
    for (let t = 0; t < 40; t++) { rerun.tick = t; again.push(...slump(rerun)); }
    expect(again, "one seed must write one chronicle").toEqual(wrote);
  });

  it("says nothing about a slip under the bar", () => {
    // The whole of what LOUD does, and the only place it can be asked plainly:
    // on the made world every face is the same height, so the bar is either
    // over all of them or under all of them.
    const low = face();
    for (let i = 0; i < CELLS; i++) if ((i % SIZE) % 2 === 0) low.elev[i] = 250;   // a twenty-metre face
    const shelf = Int16Array.from(low.elev);
    const hush: Event[] = [];
    for (let t = 0; t < 40; t++) { low.tick = t; hush.push(...slump(low)); }
    expect([...low.elev].some((v, i) => v !== shelf[i]),
      "a twenty-metre face over a river still has to fail").toBe(true);
    expect(hush, "but a slip under the bar is not news").toEqual([]);
  });

  it("runs forwards and is filed against the river", () => {
    expect(wrote.length, "a face that failed should be written down").toBeGreaterThan(0);
    expect(wrote, "the chronicle runs forwards")
      .toEqual([...wrote].sort((p, q) => p.tick - q.tick));
    for (const e of wrote) {
      expect(e.kind).toBe("slide");
      expect(e.tick >= 0 && e.tick < 40,
        `an event must be dated by the day it happened, got ${e.tick}`).toBe(true);
      // A forty-metre face fails to the level of the channel, so that is what
      // the record has to say it dropped — in metres, not in the decimetres
      // elev counts.
      expect(e.size, "and measured in metres of rock").toBe(40);
      // Filed against the channel that was buried, which is a trough, not a face.
      expect(e.x % 2, `a slide is filed against the river at ${e.x},${e.y}`).toBe(1);
      expect(e.y >= 0 && e.y < SIZE, `${e.x},${e.y} is off the map`).toBe(true);
    }
  });
});

describe("what has to be true for a slope to fail", () => {
  it("needs water", () => {
    // Dry ground does not fail, however steep: water is the trigger, which is
    // what ties the one rule that builds relief to the weather.
    const dry = face();
    dry.water.fill(0);
    const still = ground(dry);
    const wasElev = Int16Array.from(dry.elev);
    for (let t = 0; t < 40; t++) { dry.tick = t; slump(dry); }
    expect(ground(dry), "dry ground cannot move").toBe(still);
    expect([...dry.elev], "and a dry face must stand").toEqual([...wasElev]);
  });

  it("needs a river below it", () => {
    // A channel with no river in it is not undercut, so nothing above it falls:
    // the rule is about rivers cutting slopes out, not about steepness alone.
    const unwatered = face();
    unwatered.flow.fill(0);
    const quiet = ground(unwatered);
    const heldElev = Int16Array.from(unwatered.elev);
    for (let t = 0; t < 40; t++) { unwatered.tick = t; slump(unwatered); }
    expect([...unwatered.elev], "a slope over dry ground stands").toEqual([...heldElev]);
    expect(ground(unwatered), "and nothing moves").toBe(quiet);
  });

  it("turns on field capacity, not on any water at all", () => {
    // Asked at the boundary, because a fixture that is either bone dry or brim
    // full proves only that water is a trigger: swap the rule's soil/8 for any
    // constant under 65535 and a wet-or-dry fixture cannot tell the difference.
    const brink = (fill: number) => {
      const w = face();
      w.water.fill(fill);
      const before = Int16Array.from(w.elev);
      for (let t = 0; t < 40; t++) { w.tick = t; slump(w); }
      let moved = 0;
      for (let i = 0; i < CELLS; i++) if (before[i] !== w.elev[i]) moved++;
      return moved;
    };
    const HOLDS = 400 >> 3;   // what the fixture's 400mm of soil can hold against gravity
    expect(brink(HOLDS - 1), "ground below field capacity still has friction").toBe(0);
    expect(brink(HOLDS), "ground holding all it can has none left").toBeGreaterThan(0);
  });
});

describe("the guards that were dead to every other assertion", () => {
  it("stops at the soil ceiling", () => {
    // The soil ceiling is the one clamp the rule needs — rock cannot overflow,
    // because a slide moves elev[face] - elev[dam] and so only ever swaps two
    // heights that were both representable a moment ago — and it was dead to
    // every assertion here until this fixture: deleting it changed no number in
    // the suite.
    const brim = packed();
    const brimGround = ground(brim);
    brim.tick = 0;
    slump(brim);
    let filled = 0;
    for (let i = 0; i < CELLS; i++) {
      if (brim.soil[i] > 65535) expect.fail("soil cannot pass its ceiling");
      if ((i % SIZE) % 2 === 1 && brim.soil[i] === 65535) filled++;
    }
    expect(filled, "a channel should take what room it has and stop").toBeGreaterThan(0);
    expect(ground(brim), "and the rest stays on the face").toBe(brimGround);
  });

  it("does not let one face shed twice in a pass", () => {
    // A ridge can stand over two channels and be chosen by both on the same
    // pass, and the second of those measured a face that has already gone.
    // Deleting the guard against it left every assertion above passing, because
    // a double shed subtracts and adds the same number and so balances while
    // taking off a face more than the face had standing.
    const twice = face();
    const stood = Int16Array.from(twice.elev);   // the ground as the slides found it
    twice.tick = 0;
    slump(twice);
    for (let i = 0; i < CELLS; i++) {
      if ((i % SIZE) % 2 !== 0) continue;             // faces sit in the even columns
      const x = i % SIZE;
      if (x === 0 || x === SIZE - 1) continue;        // both channels must exist
      // Against the ground as it stood, and on the rock: every channel here is
      // itself buried by the face on its other side, so comparing against the
      // ground afterwards asks a question the fixture cannot answer, and
      // comparing surfaces would read a bare scar beside a loaded channel as
      // upside down. Shed twice, a face would drop to 50 - 400 rather than
      // stopping at 50.
      const low = Math.min(stood[i - 1], stood[i + 1]);
      if (twice.elev[i] < low) {
        expect.fail(`a face shed more than once at ${x}: ${twice.elev[i]} against ${low}`);
      }
    }
  });
});

it("leaves a closed basin behind a dam", () => {
  // The reason the rule exists. A channel running downhill, one wet face
  // standing over it, and the cell upstream of the dam should afterwards have
  // nowhere to drain. The checkerboard fixture cannot ask this — it has no
  // downstream.
  const dammed = valley();
  const mid = SIZE >> 1, above = mid * SIZE + 99;
  expect(drains(dammed, above), "the channel drains before anything falls into it").toBe(true);
  const valleyGround = ground(dammed);
  for (let t = 0; t < 200 && drains(dammed, above); t++) { dammed.tick = t; slump(dammed); }
  expect(drains(dammed, above), "a slide has to leave the reach above it with nowhere to go").toBe(false);
  expect(ground(dammed), "and it still must not make or destroy ground").toBe(valleyGround);
});

it("is held together by roots", () => {
  const rooted = face();
  rooted.veg.fill(VEG_MAX);
  let held = 0;
  for (let t = 0; t < 40; t++) {
    rooted.tick = t;
    const before = Int16Array.from(rooted.elev);
    slump(rooted);
    for (let i = 0; i < CELLS; i++) if (before[i] !== rooted.elev[i]) held++;
  }
  expect(held < failures, `canopy should hold a face together, ${held} failed against ${failures}`).toBe(true);
});

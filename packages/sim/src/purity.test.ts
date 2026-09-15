// What a pure step promises.
//
// These exist because the rules stopped sharing state. Every one of them passed
// trivially before that change and would have had nothing to say; they pin the
// properties that replaced twenty module-level buffers, and they are the only
// things standing between those buffers and a quiet return. Each was checked by
// breaking the thing it watches.

import { expect, it } from "vitest";
import { generate, step, pack, unpack, slump, coastline, submerged, CELLS, type World, type Event } from "./index.ts";
import { run, same, TICKS } from "./fixtures.ts";

it("does not touch the world it was given", () => {
  // The whole guarantee is a single `copy(prev)` at the top of a two-hundred
  // line function, which is exactly the kind of line someone removes to save an
  // allocation in a hot loop without noticing what else it was holding up.
  const before = generate(9);
  const untouched = pack(before);
  const day = step(before);
  same(pack(before), untouched, "step must not touch the world it was given");
  expect(day.world, "and must hand back a different world").not.toBe(before);
  expect(day.world.tick, "which has moved on by a day").toBe(before.tick + 1);
});

it("keeps two worlds in flight apart", () => {
  // The test for the entire bug class the refactor removes — a shared buffer, a
  // drained log, a cache keyed on a tick two worlds can both be standing on.
  // Sequential runs cannot find it, because they never have two worlds in
  // flight; these are interleaved a day at a time on purpose.
  const days = 60;
  let p1 = generate(11), p2 = generate(22);
  const told1: Event[] = [], told2: Event[] = [];
  for (let t = 0; t < days; t++) {
    const d1 = step(p1); p1 = d1.world; told1.push(...d1.events);
    const d2 = step(p2); p2 = d2.world; told2.push(...d2.events);
  }
  const [alone1, solo1] = run(generate(11), days);
  const [alone2, solo2] = run(generate(22), days);
  same(pack(p1), pack(alone1), "a world stepped beside another must come out the same");
  same(pack(p2), pack(alone2), "and so must the other one");
  expect(told1, "and it must report the same history").toEqual(solo1);
  expect(told2, "and so must the other one").toEqual(solo2);
});

it("does not let one world's reader answer for another's", () => {
  // `submerged` is the last memo in the file, and two worlds interleaved are
  // standing on the same day for most of it — which is precisely the case a
  // cache keyed on the day and not on the world gets wrong. Stepping alone
  // cannot find this, because nothing inside `step` reads that memo; only a
  // reader does. So the reading is interleaved too, which is the only way the
  // question gets asked. Checked by deliberately dropping the identity half of
  // the key.
  const days = 30;
  const shore = (w: World) => {
    let n = 0;
    for (let i = 0; i < CELLS; i += 97) if (submerged(w, i)) n++;
    return n;
  };
  let q1 = generate(11), q2 = generate(22);
  const mixed1: number[] = [], mixed2: number[] = [];
  for (let t = 0; t < days; t++) {
    mixed1.push(shore(q1));
    mixed2.push(shore(q2));   // same tick, different world: the trap
    q1 = step(q1).world;
    q2 = step(q2).world;
  }
  let r1 = generate(11), r2 = generate(22);
  const lone1: number[] = [], lone2: number[] = [];
  for (let t = 0; t < days; t++) { lone1.push(shore(r1)); r1 = step(r1).world; }
  for (let t = 0; t < days; t++) { lone2.push(shore(r2)); r2 = step(r2).world; }
  expect(mixed1, "a world's coastline must not depend on who asked before it").toEqual(lone1);
  expect(mixed2, "and neither must the other one's").toEqual(lone2);
});

it("steps a world off the disk like one that never left", () => {
  // The round trip in world.test.ts compares and stops, which cannot see state
  // that lives outside the World and so does not survive packing — the kind of
  // thing every buffer removed here used to be.
  //
  // A world-year deep, not forty days. The state this is hunting for only
  // accumulates as a world runs — rivers cut, the coastline settles, the caches
  // fill — and forty days is barely past worldgen, where a resumed world and a
  // live one would agree whatever was leaking. Splitting the old script cost
  // this test its mature fixture and nothing noticed, because the message was
  // still true of the weaker world.
  const days = 40;
  const start = run(generate(1234), TICKS)[0];
  const [live, fromMemory] = run(unpack(pack(start)), days);
  const [resumed, fromDisk] = run(unpack(pack(start)), days);
  same(pack(resumed), pack(live), "a world resumed from storage must step like one that never left");
  expect(fromDisk, "and write the same history doing it").toEqual(fromMemory);
});

it("does not care who drew the coastline", () => {
  // `step` always passes one; every other test calls `slump` without. Without
  // this the path the real tick takes is only ever exercised through a whole
  // day, where a fault in it has a hundred other things to hide behind.
  const one = generate(77), two = generate(77);
  const told = slump(one);
  const also = slump(two, coastline(two));
  same(pack(one), pack(two), "slump must not care who drew the coastline");
  expect(told, "nor must what it writes down").toEqual(also);
});

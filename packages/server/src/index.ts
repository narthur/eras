import { DurableObject } from "cloudflare:workers";
import { features, generate, step, pack, unpack, EVENT_KINDS, type Event, type Feature, type World } from "@eras/sim";

const BURST = 200;   // ticks per alarm, ~2s of CPU; catching up reschedules at once
const SEED = 20260910;
const MAX_SPECTATORS = 100;   // each one is another ~704KiB down the wire per tick
const FEATURE_EVERY = 30;    // world-days between sweeps; a forest takes decades
const PENDING_CAP = 4096;   // events held for a write that keeps failing
const RECENT = 4;   // chronicle lines per kind a viewer is sent. The rest stay in the
                    // table. Per kind rather than a flat tail for the same reason the
                    // feature list is: the world does one of these far more often than
                    // the others, and a plain "last twelve" is a list of landslides
                    // with the fire that happened last year already off the end of it.
                    // EVENT_KINDS comes from the sim so that adding a kind cannot
                    // quietly leave it stored but never shown

// One world-day per real minute. Override to run the world fast while tuning rules:
//   wrangler dev --var TICK_MS:50
type Env = { WORLD: DurableObjectNamespace<WorldDO>; TICK_MS?: string };

export class WorldDO extends DurableObject<Env> {
  private world?: World;
  private genesis = 0;
  private found: Feature[] = [];
  private foundAt = -FEATURE_EVERY;   // so the first sweep runs immediately
  private recent?: Event[];           // the tail of the chronicle, read once and then kept
  private pending: Event[] = [];      // reported by the ticks, not yet durable

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The chronicle outlives the tick that wrote it and is never rewritten, so
    // it is a table rather than another key beside the world: a row per thing
    // that happened, kept for as long as the world lasts. `sql.exec` is
    // synchronous, so this needs no blockConcurrencyWhile to be ready in time.
    //
    // Never pruned, and that is affordable: world time runs 1440x real time, so
    // at four slides and a few fires a world-year the table gains about ten
    // thousand rows a real year — single-digit megabytes after a decade, against
    // gigabytes of room. The world is supposed to remember, so it does.
    //
    // This shape is frozen the moment it is deployed. `IF NOT EXISTS` is a no-op
    // against a table that already stands, whatever its columns, so a later
    // column added here alone would leave the live world with the old shape and
    // every INSERT throwing — which, since `record()` runs before `setAlarm()`,
    // is a world that stops ticking. A column added after this ships needs an
    // ALTER beside it, guarded on `pragma_table_info`.
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS chronicle" +
      " (tick INTEGER, rules INTEGER, kind TEXT, x INTEGER, y INTEGER, size INTEGER)");
    // Every read of this table is "the last few of one kind", and the table only
    // ever grows. Without this the tail queries scan all of it, which costs
    // nothing this year and more every year after; with it they read RECENT rows
    // and the table's size stops being a number anyone has to keep watching.
    // On (kind, tick) and not on rowid with them: SQLite will not index rowid,
    // and it does not need to — this narrows each tail to the right kind's last
    // few days, and the rowid tiebreak below sorts what is left of one day.
    sql.exec("CREATE INDEX IF NOT EXISTS chronicle_tail ON chronicle (kind, tick DESC)");
  }

  private get tickMs() {
    // A zero or unparseable override would make world time infinite, leave the
    // object permanently behind, and reschedule the alarm every 100ms forever.
    // A tiny one does the same thing more slowly, so the floor is below the
    // fastest rate worth tuning at and nowhere near zero.
    const ms = Number(this.env.TICK_MS ?? 60_000);
    return Number.isFinite(ms) && ms >= 10 ? ms : 60_000;
  }

  // The world is ~704KiB and this class is SQLite-backed, where a value may be
  // 2MB. It goes under one key. Chunk it again if a later layer outgrows that.
  // No world has ever been stored under any other layout, so there is nothing
  // to migrate from; a missing genesis means a missing world, not an old one.
  private async load(): Promise<World> {
    if (this.world) return this.world;
    const storage = this.ctx.storage;
    const genesis = await storage.get<number>("genesis");
    if (genesis === undefined) {
      this.genesis = Date.now();
      this.world = generate(SEED);
      await this.save();
      await storage.setAlarm(this.genesis + this.tickMs);
      return this.world;
    }
    const stored = await storage.get<ArrayBuffer>("world");
    if (!stored) throw new Error("the world has a genesis but no state");
    // A world that cannot be read stops the object until someone looks. It is
    // deliberately not regenerated: downtime is recoverable, the past is not.
    this.genesis = genesis;
    this.world = unpack(stored);
    return this.world;
  }

  private async save() {
    // one put, so the world and its genesis can never disagree
    await this.ctx.storage.put({ world: pack(this.world!), genesis: this.genesis });
  }

  // Everything the ticks just run wrote down, oldest first, handed over by the
  // days that made it.
  //
  // Held in a field until the rows are in, and still necessary now that the sim
  // hands events back rather than being drained of them. The reason moved, so
  // it is worth stating plainly: `save()` persists the advanced world before
  // this commits its rows. If the write fails after that, the throw rolls this
  // handler's storage back — but the world those events came from is already
  // durable and already past them, so replaying the ticks cannot produce them a
  // second time. The queue is what stands between a failed write and a hole in
  // the chronicle. Whatever did not land stays in it and goes in on the next
  // alarm; the rollback means it cannot go in twice.
  //
  // Do not read this as vestigial because the destructive drain it was first
  // written for is gone. The hazard it guards is the write order, not the drain.
  private record(told: Event[]): boolean {
    this.pending.push(...told);
    // A queue that only ever grows is a leak. It can only get here if the write
    // has been failing for hours, by which point the object is throwing on every
    // alarm and the world has stopped: the memory is the problem to bound, and
    // the lost tail is not, because a world that is not ticking is not making
    // any more history to lose. Oldest first, as the sim's own log sheds.
    if (this.pending.length > PENDING_CAP) this.pending.splice(0, this.pending.length - PENDING_CAP);
    const sql = this.ctx.storage.sql;
    for (const e of this.pending) {
      sql.exec("INSERT INTO chronicle VALUES (?, ?, ?, ?, ?, ?)",
        e.tick, e.rules, e.kind, e.x, e.y, e.size);
    }
    const wrote = this.pending.length > 0;
    this.pending = [];   // reached only once every row of it is in
    if (!wrote && this.recent) return false;
    // Read back rather than appended to in memory, so the tail a viewer sees is
    // the tail that is actually stored and there is one answer to what happened.
    // One query a kind: three small reads beat one window function that has to
    // be decoded before anyone can say what it returns.
    const tail: Event[] = [];
    for (const kind of EVENT_KINDS) {
      tail.push(...sql.exec<Event>(
        "SELECT tick, rules, kind, x, y, size FROM chronicle WHERE kind = ?" +
        " ORDER BY tick DESC, rowid DESC LIMIT ?", kind, RECENT).toArray());
    }
    // Newest first, which is the order the panel reads in.
    this.recent = tail.sort((a, b) => b.tick - a.tick);
    return wrote;
  }

  // What the world has made that is big enough to have a name. Swept on a
  // schedule rather than every tick: nothing here changes in a day, and each
  // sweep that finds nothing new still costs every spectator a message.
  private sweep(world: World): boolean {
    if (world.tick - this.foundAt < FEATURE_EVERY) return false;
    this.foundAt = world.tick;
    const before = JSON.stringify(this.found);
    this.found = features(world);
    return JSON.stringify(this.found) !== before;
  }

  async alarm() {
    let world = await this.load();
    const target = Math.floor((Date.now() - this.genesis) / this.tickMs);
    const run = Math.min(BURST, target - world.tick);
    // `step` hands back a new world rather than changing this one, so the burst
    // walks a chain of them and what the object keeps is the last. The events
    // come back the same way and are handed to `record` instead of being
    // collected from a global — which is what makes the drain-before-write
    // hazard structurally impossible rather than merely fixed.
    const told: Event[] = [];
    for (let i = 0; i < run; i++) {
      const day = step(world);
      world = day.world;
      told.push(...day.events);
    }
    this.world = world;
    await this.save();

    const wrote = this.record(told);
    const changed = this.sweep(world);
    const behind = world.tick < target;
    await this.ctx.storage.setAlarm(
      behind ? Date.now() + 100 : this.genesis + (world.tick + 1) * this.tickMs);
    if (!behind || run > 0) {
      this.broadcast(pack(world));
      // One frame, because the viewer reads whatever fields it finds and two
      // would be two wakeups for the same news.
      const news: Record<string, unknown> = {};
      if (changed) news.features = this.found;
      if (wrote) news.chronicle = this.recent;
      if (Object.keys(news).length > 0) this.broadcast(JSON.stringify(news));
    }
  }

  // ponytail: broadcasts the whole world (~704KiB) once a minute. Send deltas
  // when either the tick rate or the spectator count makes that hurt.
  private broadcast(buf: ArrayBuffer | string) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(buf); } catch { /* closing */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const world = await this.load();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100);

    // not used by the viewer, which lives on the socket. This is the one that
    // answers `curl` when you want to know whether the world is still turning.
    if (new URL(req.url).pathname === "/snapshot") {
      return new Response(pack(world), { headers: { "content-type": "application/octet-stream" } });
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("not found", { status: 404 });

    if (this.ctx.getWebSockets().length >= MAX_SPECTATORS) {
      return new Response("the world is full", { status: 503 });
    }
    // Sweep before this socket joins, and tell the room if anything turned up.
    // Whoever sweeps moves the window on for everybody, so an arrival that
    // swept and stayed quiet would leave the people already here a full window
    // behind on a world the object had already looked at.
    if (this.sweep(world)) this.broadcast(JSON.stringify({ features: this.found }));
    this.record([]);   // no ticks have run, so this only fills `recent` the first time

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(pack(world));
    // Where we are in the current day, so a viewer can count down to the next
    // one without waiting for it. Sent after the world and only on connect:
    // it lands last, so it wins, and it never costs a message per tick.
    // A duration rather than a timestamp, because the viewer's clock is its own.
    server.send(JSON.stringify({
      tickMs: this.tickMs,
      nextIn: Math.max(0, this.genesis + (world.tick + 1) * this.tickMs - Date.now()),
      features: this.found,
      chronicle: this.recent,
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() { /* spectators only, for now */ }

  // Finish the handshake so the socket leaves getWebSockets() and its slot
  // returns. Without this the cap could fill with ghosts and lock everyone out.
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  webSocketError(ws: WebSocket) {
    try { ws.close(); } catch { /* already gone */ }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/ws" || pathname === "/snapshot") {
      return env.WORLD.get(env.WORLD.idFromName("world")).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

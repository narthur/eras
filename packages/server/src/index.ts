import { DurableObject } from "cloudflare:workers";
import { generate, step, pack, unpack, type World } from "@eras/sim";

const BURST = 200;   // ticks per alarm, ~2s of CPU; catching up reschedules at once
const SEED = 20260910;

// One world-day per real minute. Override to run the world fast while tuning rules:
//   wrangler dev --var TICK_MS:50
type Env = { WORLD: DurableObjectNamespace<WorldDO>; TICK_MS?: string };

export class WorldDO extends DurableObject<Env> {
  private world?: World;
  private genesis = 0;
  private get tickMs() { return Number(this.env.TICK_MS ?? 60_000); }

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

  async alarm() {
    const world = await this.load();
    const target = Math.floor((Date.now() - this.genesis) / this.tickMs);
    const run = Math.min(BURST, target - world.tick);
    for (let i = 0; i < run; i++) step(world);
    await this.save();

    const behind = world.tick < target;
    await this.ctx.storage.setAlarm(
      behind ? Date.now() + 100 : this.genesis + (world.tick + 1) * this.tickMs);
    if (!behind || run > 0) this.broadcast(pack(world));
  }

  // ponytail: broadcasts the whole world (~704KiB) once a minute. Send deltas
  // when either the tick rate or the spectator count makes that hurt.
  private broadcast(buf: ArrayBuffer) {
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

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(pack(world));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() { /* spectators only, for now */ }
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

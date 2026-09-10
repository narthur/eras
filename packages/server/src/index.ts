import { DurableObject } from "cloudflare:workers";
import { generate, step, pack, unpack, type World } from "@eras/sim";

const BURST = 200;        // ticks per alarm, ~2s of CPU; catching up reschedules at once
const CHUNK = 96 * 1024;  // under the per-key storage limit
const SEED = 20260910;

// One world-day per real minute. Override to run the world fast while tuning rules:
//   wrangler dev --var TICK_MS:50
type Env = { WORLD: DurableObjectNamespace<WorldDO>; TICK_MS?: string };

export class WorldDO extends DurableObject<Env> {
  private world?: World;
  private genesis = 0;
  private get tickMs() { return Number(this.env.TICK_MS ?? 60_000); }

  private async load(): Promise<World> {
    if (this.world) return this.world;
    const st = this.ctx.storage;
    const meta = await st.get<{ genesis: number; chunks: number }>("meta");
    if (!meta) {
      this.genesis = Date.now();
      this.world = generate(SEED);
      await this.save();
      await st.setAlarm(this.genesis + this.tickMs);
      return this.world;
    }
    this.genesis = meta.genesis;
    const parts = await st.get<ArrayBuffer>(
      Array.from({ length: meta.chunks }, (_, i) => `w${i}`));
    const buf = new Uint8Array(meta.chunks * CHUNK);
    let n = 0;
    for (let i = 0; i < meta.chunks; i++) {
      const p = new Uint8Array(parts.get(`w${i}`)!);
      buf.set(p, n);
      n += p.length;
    }
    this.world = unpack(buf.buffer.slice(0, n));
    return this.world;
  }

  private async save() {
    const bytes = new Uint8Array(pack(this.world!));
    const entries: Record<string, ArrayBuffer> = {};
    let chunks = 0;
    for (let o = 0; o < bytes.length; o += CHUNK) {
      entries[`w${chunks++}`] = bytes.slice(o, o + CHUNK).buffer;
    }
    await this.ctx.storage.put(entries);
    await this.ctx.storage.put("meta", { genesis: this.genesis, chunks });
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

  // ponytail: broadcasts the whole world (~590KB) once a minute. Send deltas
  // when either the tick rate or the spectator count makes that hurt.
  private broadcast(buf: ArrayBuffer) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(buf); } catch { /* closing */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const world = await this.load();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100);

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

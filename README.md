# Eras

One world, running continuously, one world-day per real minute. See
`~/Obsidian/Main/Fieldnotes/Giant Map Simulator — Design.md` for the design.

This is the MVP: layer one only — hydrology and vegetation over a 256×256 grid,
ticked by a Durable Object alarm and pushed to spectators over a WebSocket.

## Packages

| | |
| --- | --- |
| `packages/sim` | The world. Deterministic state machine: worldgen, tick, biome classification, wire format. No I/O. |
| `packages/server` | Worker + `WorldDO`, the always-running daemon. Owns the clock, storage and sockets. |
| `packages/web` | Canvas viewer. Four colour functions over the same grid. |

```sh
pnpm install
pnpm dev        # worker on :8787, viewer on http://localhost:5173
pnpm test       # sim self-check: determinism, erosion balance, growth
pnpm deploy     # builds the viewer, wrangler deploy serves it alongside the DO
```

A Durable Object only exists once something asks for it, and there is no cron
trigger, so a freshly deployed world does not begin until the first visit. After
that the alarm chain carries it on its own, watched or not.

## Deploying

The world lives at `eras.nathanarthur.com` and deliberately nowhere else:
`workers_dev` is off. A request can only be turned away before it costs anything
at the zone, and a live `workers.dev` URL would be a way around that.

Workers Paid has no spending cap — the only hard stop Cloudflare sells is the
free plan's. So the zone carries one rate limiting rule, which is all the free
plan allows:

| | |
| --- | --- |
| If | `http.request.uri.path in {"/snapshot" "/ws"}` |
| Rate | 10 requests per 10 seconds, per IP |
| Then | Block for 10 seconds |

Generous for a person — a visit is one `/ws` request and the map arrives on the
socket — and it caps what any single address can draw. It does nothing about a
flood spread across many addresses; nothing on this plan does.

The world runs off wall-clock time, so tuning rules means waiting years. Run it
fast instead:

```sh
pnpm --filter @eras/server dev -- --var TICK_MS:20   # a world-day every 20ms
rm -rf packages/server/.wrangler                     # start over from genesis
```

## Not here yet

The event log and chronicle, feature detection and the naming loop, sprites and
zoom, and everything from `Deferred` in the design note. Vegetation is the only
thing that changes slowly enough to be worth watching; it takes ~16 world-years
to grow a mature forest, which is four real days.

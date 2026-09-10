# Eras

One world, running continuously, one world-day per real minute. See
`~/Obsidian/Main/Fieldnotes/Giant Map Simulator — Design.md` for the design.

This is the MVP: layer one only — hydrology and vegetation over a 256×256 grid,
ticked by a Durable Object alarm and pushed to spectators over a WebSocket.

## Packages

| | |
|---|---|
| `packages/sim` | The world. Pure integer state machine: worldgen, tick, biome classification, wire format. No I/O. |
| `packages/server` | Worker + `WorldDO`, the always-running daemon. Owns the clock, storage and sockets. |
| `packages/web` | Canvas viewer. Four colour functions over the same grid. |

```sh
pnpm install
pnpm dev        # worker on :8787, viewer on http://localhost:5173
pnpm test       # sim self-check: determinism, erosion balance, growth
pnpm deploy     # builds the viewer, wrangler deploy serves it alongside the DO
```

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

import { unpack, biome, Biome, SIZE, CELLS, VEG_MAX, type Feature, type World } from "@eras/sim";

const rgb = (r: number, g: number, b: number) => 0xff000000 | (b << 16) | (g << 8) | r;
const mix = (a: number[], b: number[], t: number) =>
  rgb(a[0] + (b[0] - a[0]) * t | 0, a[1] + (b[1] - a[1]) * t | 0, a[2] + (b[2] - a[2]) * t | 0);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const BIOME_COLOUR = [
  rgb(28, 52, 92),    // Ocean (shaded by depth below)
  rgb(48, 96, 150),   // Lake
  rgb(70, 124, 176),  // River
  rgb(120, 118, 112), // Rock
  rgb(160, 143, 108), // Barren
  rgb(118, 152, 78),  // Grass
  rgb(54, 96, 52),    // Forest
  rgb(232, 234, 238), // Peak
];

// Each view is just a different colour function over the same grid.
const VIEWS: Record<string, (w: World, i: number) => number> = {
  biome: (w, i) => {
    const b = biome(w, i);
    if (b === Biome.Ocean) return mix([12, 24, 48], [46, 78, 126], clamp01(1 + w.elev[i] / 500));
    return BIOME_COLOUR[b];
  },
  elevation: (w, i) => {
    const e = w.elev[i];
    if (e <= 0) return mix([10, 20, 44], [58, 96, 148], clamp01(1 + e / 500));
    return e < 900
      ? mix([64, 104, 62], [176, 150, 104], e / 900)
      : mix([176, 150, 104], [246, 248, 252], clamp01((e - 900) / 1600));
  },
  water: (w, i) => {
    if (w.elev[i] <= 0) return rgb(20, 32, 54);
    // moisture as the base, this tick's flow drawn over it
    const damp = mix([44, 42, 38], [86, 108, 130],
      clamp01(w.water[i] / Math.max(1, w.soil[i] >> 3)));
    const f = w.flow[i];
    return f > 60 ? mix([70, 120, 180], [190, 232, 255], clamp01(f / 3000)) : damp;
  },
  vegetation: (w, i) =>
    w.elev[i] <= 0 ? rgb(20, 26, 36) : mix([62, 54, 42], [92, 200, 96], clamp01(w.veg[i] / VEG_MAX)),
};

let view = "biome";
let world: World | undefined;
let tickMs = 60_000;
let due = 0;            // when the next world-day is expected, on this machine's clock
let connected = false;
let hover: number | undefined;   // the cell under the cursor, if any
let found: Feature[] = [];       // what the world has made, none of it named yet
let lit: Feature | undefined;    // the row the cursor is on, shown on the map
let shownText = "";              // what the panel last drew, to leave it alone

// A tap fires mouseenter and never mouseleave, so anything that lights up on
// hover would latch on with no way to put it out. Both the map and the list.
const canHover = matchMedia("(hover: hover)").matches;
let catchingUp = false; // days arriving in a rush, not on the wall clock

const canvas = document.getElementById("map") as HTMLCanvasElement;
canvas.width = canvas.height = SIZE;
const ctx = canvas.getContext("2d")!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);
const clock = document.getElementById("clock")!;
const cell = document.getElementById("cell")!;
const foundEl = document.getElementById("found")!;

// Nothing is named yet, so the list is what the world is waiting to be asked
// about. A few of each kind rather than simply the biggest: sorted by size
// alone, one continent and eight mountain ranges bury every lake and river,
// and the map would carry markers the list never mentions.
function paintFound() {
  const room: Record<string, number> = {};
  // Sorted here rather than trusted to arrive sorted: "the four biggest of
  // each kind" should not quietly become "the first four that showed up".
  const shown = [...found]
    .sort((a, b) => b.size - a.size)
    .filter((f) => (room[f.kind] = (room[f.kind] ?? 0) + 1) <= 4);
  const text = shown.map((f) => `${f.kind} ${f.size} ${f.x},${f.y}`).join("|");
  if (text === shownText) return;   // rebuilding would drop the row under the cursor
  shownText = text;
  foundEl.hidden = shown.length === 0;
  // Headed, because a bare 27486 beside a bare 125,160 says nothing about
  // being an area and a place. Cells rather than any real measure: a cell has
  // a height in metres but no agreed width, so there is no honest km² to give.
  // The list changes whenever any river flickers, so losing the pointed-at
  // feature on every sweep would make the highlight useless. Keep it if it is
  // still there; the browser re-applies :hover to the new row on its own.
  lit = lit && shown.find((f) => f.kind === lit!.kind && f.x === lit!.x && f.y === lit!.y);
  foundEl.textContent = "";
  foundEl.append(row(`${"unnamed".padEnd(8)}${"cells".padStart(6)}  at`));
  for (const f of shown) {
    // A coordinate pair is no way to find a place. Hovering the row says where
    // it is in the only language the map speaks: pointing at it.
    const el = row(`${f.kind.padEnd(8)}${String(f.size).padStart(6)}  ${f.x},${f.y}`);
    if (canHover) {
      el.dataset.at = `${f.x},${f.y}`;
      el.onmouseenter = () => { lit = f; draw(); };
      el.onmouseleave = () => { lit = undefined; draw(); };
    }
    foundEl.append(el);
  }
}

function row(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = text;
  return el;
}

// Indexed by each biome's own number rather than by the order the keys happen
// to be written in, so inserting one in the middle renames nothing by accident.
const BIOME_NAME: string[] = [];
for (const [name, value] of Object.entries(Biome)) BIOME_NAME[value] = name.toLowerCase();

// What is under the cursor. Repainted on every tick too, so a still cursor
// over a river watches the river change rather than going stale.
function paintCell() {
  if (!world || hover === undefined) { cell.hidden = true; return; }
  const i = hover;
  // Soil holds the first soil/8 of the water against gravity; only what is
  // above that stands on the surface. One number would have to mean both.
  const held = world.soil[i] >> 3;
  const standing = Math.max(0, world.water[i] - held);
  const rows: [string, string][] = [
    ["elev", `${Math.round(world.elev[i] / 10)}m`],
    ["soil", `${world.soil[i]}mm`],
    ["damp", held > 0 ? `${Math.min(100, Math.round((world.water[i] * 100) / held))}%` : "—"],
    ["standing", `${standing}mm`],
    ["flow", `${world.flow[i]}mm`],
    ["veg", `${Math.round((world.veg[i] * 100) / VEG_MAX)}%`],
  ];
  cell.textContent = [
    BIOME_NAME[biome(world, i)],
    ...rows.map(([k, v]) => k.padEnd(9) + v.padStart(8)),
  ].join("\n");
  cell.hidden = false;
}

// The canvas is letterboxed by object-fit, so the drawn map is centred inside
// the element and smaller than it in one direction. Undo that before asking
// which cell a pointer is over.
function cellAt(e: MouseEvent): number | undefined {
  const r = canvas.getBoundingClientRect();
  const scale = Math.min(r.width / SIZE, r.height / SIZE);
  // A canvas with no area yet divides by zero, and NaN would slip past the
  // bounds check below and be read as a cell.
  if (scale <= 0) return undefined;
  const x = Math.floor((e.clientX - r.left - (r.width - SIZE * scale) / 2) / scale);
  const y = Math.floor((e.clientY - r.top - (r.height - SIZE * scale) / 2) / scale);
  return x < 0 || y < 0 || x >= SIZE || y >= SIZE ? undefined : y * SIZE + x;
}

// Only where there is a pointer that can hover. A touch device fires a
// mousemove on tap but never a mouseleave, so the panel would latch open on
// whatever was tapped and keep refreshing there with no way to dismiss it.
// The readout holds a cell, not a position, so it points at the wrong cell
// between a window resize and the next movement. It corrects itself on the
// next mousemove, which is how every other hover on the web behaves.
if (canHover) {
  canvas.addEventListener("mousemove", (e) => { hover = cellAt(e); paintCell(); });
  canvas.addEventListener("mouseleave", () => { hover = undefined; paintCell(); });
}

// The countdown runs on the viewer's own clock between frames, so watching the
// world costs nothing beyond the tick it is waiting for. It owns this line
// outright: a countdown that keeps counting while the socket is dead would be
// claiming the world is turning when nobody can see whether it is.
function paintClock() {
  const left = Math.max(0, due - Date.now());
  const status =
    !connected ? (world ? "reconnecting…" : "connecting…")
    : catchingUp ? "catching up"
    : left > 0 ? `next in ${Math.ceil(left / 1000)}s`
    : "any moment";
  clock.textContent = world
    ? `year ${(world.tick / 365 | 0) + 1}, day ${(world.tick % 365) + 1} · ${status}`
    : status;
}
setInterval(paintClock, 250);

// Held clear of the border by its own width, so a ring on a coastal feature
// draws whole rather than as a clipped corner — and the wide rings that say
// "this one" need more room than the small ones that merely say "something".
function mark(f: Feature, side: number) {
  const r = side / 2, edge = Math.ceil(r);
  const mx = Math.min(Math.max(f.x, edge), SIZE - 1 - edge);
  const my = Math.min(Math.max(f.y, edge), SIZE - 1 - edge);
  ctx.strokeRect(mx + 0.5 - r, my + 0.5 - r, side, side);
}

function draw() {
  if (!world) return;
  const colour = VIEWS[view];
  for (let i = 0; i < CELLS; i++) pixels[i] = colour(world, i);
  ctx.putImageData(image, 0, 0);
  // Passive markers: a ring the eye can find and ignore. No labels — at this
  // scale a letter is four pixels and the panel does the naming of names.
  ctx.strokeStyle = "#e8ecf29a";
  ctx.lineWidth = 1;
  for (const f of found) mark(f, 4);
  if (lit) { ctx.strokeStyle = "#ffffff"; mark(lit, 10); mark(lit, 16); }
  paintClock();
  paintCell();
}

const nav = document.getElementById("views")!;
for (const name of Object.keys(VIEWS)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.ariaPressed = String(name === view);
  b.onclick = () => {
    view = name;
    for (const other of nav.children) (other as HTMLElement).ariaPressed = String(other === b);
    draw();
  };
  nav.append(b);
}

// ponytail: reconnect is a fixed 3s retry. Back off if it ever thrashes.
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { connected = true; };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {         // where we are in the current day
      // Sent once per connection, so a throw here would strand this viewer on
      // the default for as long as the socket lives. Keep the default instead.
      try {
        const m = JSON.parse(e.data) as
        Partial<{ tickMs: number; nextIn: number; features: Feature[] }>;
        if (m.tickMs !== undefined) tickMs = m.tickMs;
        if (m.nextIn !== undefined) due = Date.now() + m.nextIn;
        if (m.features !== undefined) { found = m.features; paintFound(); draw(); }
      } catch {
        console.warn("could not read the world clock", e.data);
      }
      paintClock();
      return;
    }
    const next = unpack(e.data as ArrayBuffer);
    // More than a day at once means the world is running down a backlog, and
    // the one after it is due in moments rather than at the usual cadence.
    catchingUp = !!world && next.tick - world.tick > 1;
    world = next;
    due = Date.now() + (catchingUp ? 100 : tickMs);
    draw();
  };
  ws.onclose = () => { connected = false; paintClock(); setTimeout(connect, 3000); };
}
connect();

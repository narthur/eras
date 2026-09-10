import { unpack, biome, Biome, SIZE, CELLS, VEG_MAX, type World } from "@eras/sim";

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
    w.elev[i] <= 0 ? rgb(20, 26, 36) : mix([62, 54, 42], [92, 200, 96], w.veg[i] / VEG_MAX),
};

let view = "biome";
let world: World | undefined;

const canvas = document.getElementById("map") as HTMLCanvasElement;
canvas.width = canvas.height = SIZE;
const ctx = canvas.getContext("2d")!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);
const clock = document.getElementById("clock")!;

function draw() {
  if (!world) return;
  const colour = VIEWS[view];
  for (let i = 0; i < CELLS; i++) pixels[i] = colour(world, i);
  ctx.putImageData(image, 0, 0);
  clock.textContent = `year ${(world.tick / 365 | 0) + 1}, day ${(world.tick % 365) + 1}`;
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
  ws.onmessage = (e) => { world = unpack(e.data as ArrayBuffer); draw(); };
  ws.onclose = () => { clock.textContent = "reconnecting…"; setTimeout(connect, 3000); };
}
connect();

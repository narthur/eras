import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/snapshot": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});

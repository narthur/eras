import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A world-year is 400 ticks at about 14ms each, so the cheapest fixture
    // here is six seconds and the default five-second timeout fails every file
    // that builds one. Raised rather than worked around: these are simulations,
    // not unit tests, and a run that takes a minute is a run that is working.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file owns its own worlds, so they parallelise: the wall clock is the
    // slowest file rather than the sum of them. That is the whole reason the
    // old single script was split up.
    fileParallelism: true,
    // So the tick rate world.test.ts prints actually reaches the terminal.
    // vitest buffers worker stdout by default and drops it when the run is
    // piped, which is most of the time here. Global, and there is no per-file
    // form of it: anything else that starts logging loses vitest's per-test
    // attribution and can interleave with the other five workers.
    disableConsoleIntercept: true,
  },
});

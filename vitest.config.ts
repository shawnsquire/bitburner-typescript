import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const src = resolve(__dirname, "src");

/**
 * Vitest config.
 *
 * Tests live in test/ (outside src/) so they are never compiled into dist/ or
 * pushed into the game. The alias table mirrors tsconfig `paths` + `baseUrl`:
 * game-style repo-absolute imports ("/lib/utils") and bare baseUrl imports
 * ("lib/utils", "views/dashboard/types") both resolve into src/.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@ns", replacement: resolve(__dirname, "NetscriptDefinitions.d.ts") },
      { find: "@react", replacement: resolve(src, "lib/react.ts") },
      { find: /^\/(lib|types|controllers|views|daemons|actions|scripts|tools|workers)\//, replacement: `${src}/$1/` },
      { find: /^(lib|types|controllers|views|daemons|actions|scripts|tools|workers)\//, replacement: `${src}/$1/` },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

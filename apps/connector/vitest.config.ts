import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: /^@zavi\/shared\/(.*)$/, replacement: fileURLToPath(new URL("../../packages/shared/src/$1", import.meta.url)) }],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    maxWorkers: 2,
    minWorkers: 1,
  },
});

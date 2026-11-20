import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

function workerCap(): { minWorkers?: number; maxWorkers?: number } {
  const raw = process.env.VITEST_MAX_WORKERS;
  let desired = 4;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(
        `VITEST_MAX_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
    desired = parsed;
  }
  const cores = availableParallelism();
  return cores > desired ? { minWorkers: 1, maxWorkers: desired } : {};
}

export default defineConfig({
  define: {
    __ZAVI_API_BASE__: JSON.stringify("https://api.test"),
    __ZAVI_WEB_BASE__: JSON.stringify("https://web.test"),
    __ZAVI_SUPABASE_URL__: JSON.stringify("https://supabase.test"),
    __ZAVI_SUPABASE_ANON_KEY__: JSON.stringify("anon-test"),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    ...workerCap(),
  },
});

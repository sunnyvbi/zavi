import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

function workerCap(): { minWorkers?: number; maxWorkers?: number } {
  const raw = process.env.VITEST_MAX_WORKERS;
  let desired = 4;
  if (raw !== undefined && raw.trim() !== '') {
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
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['src/app/(dashboard)/channels/page.lockFailure.test.tsx', 'jsdom'],
    ],
    ...workerCap(),
  },
});

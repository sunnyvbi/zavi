import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

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
  plugins: [tsconfigPaths()],
  resolve: {
    alias: [
      {
        find: "react-router-dom",
        replacement: fileURLToPath(
          new URL("./src/services/provisioning/templates/vite-react-zavi/__tests__/fixtures/react-router-dom.ts", import.meta.url),
        ),
      },
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
    ],
  },
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@supabase/supabase-js',
            'zod',
            'inngest',
            '@anthropic-ai/sdk',
            'openai',
            '@openai/agents',
            '@langchain/core',
            '@langchain/langgraph',
            '@langchain/anthropic',
            '@langchain/openai',
            'langchain',
            'stripe',
            'e2b',
            '@aws-sdk/client-secrets-manager',
            '@aws-sdk/client-dynamodb',
            '@aws-sdk/lib-dynamodb',
            '@sendgrid/mail',
            '@supabase/ssr',
            'express-rate-limit',
          ],
        },
      },
    },

    environment: "node",
    environmentMatchGlobs: [["src/services/provisioning/templates/vite-react-zavi/__tests__/login-page.test.ts", "jsdom"]],
    setupFiles: ["./vitest.setup.ts"],
    ...(process.env.CI ? { testTimeout: 20_000, hookTimeout: 60_000 } : {}),
    poolMatchGlobs: [
      ["**/src/services/code-index/__tests__/**", "forks"],
      ["**/src/services/memory/__tests__/extract-entities.test.ts", "forks"],
      ["**/src/services/tools/investor-discovery/__tests__/investor-discovery.test.ts", "forks"],
      ["**/src/agents/engineer/__tests__/wiring-check.test.ts", "forks"],
      ["**/src/services/mcp/internal/__tests__/code-index-norekick.test.ts", "forks"],
    ],
    poolOptions: {
      forks: {
        execArgv: ["--liftoff-only"],
      },
    },
    include: [
      "src/routes/agents/dashboards/*.test.ts",
      "src/services/connectors/tiktok-ads/*.test.ts",
      "src/services/connectors/reddit-ads/*.test.ts",
      "src/services/connectors/x-ads/*.test.ts",
      "src/services/growth/x-ad-*.test.ts",
      "src/services/tools/reddit-ads/*.test.ts",
      "src/services/mcp/*.test.ts",
      "src/services/connectors/composio/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      "workers/**/*.test.ts",
      "scripts/site-quality-bench/__tests__/**/*.test.mjs",
      "scripts/check-local-env/__tests__/**/*.test.mjs",
      "scripts/mirror/__tests__/**/*.test.mjs",
      "eval/live-replay/__tests__/**/*.test.mjs",
      "../../packages/launch-video/src/**/__tests__/**/*.test.ts",
    ],
    globals: false,
    ...workerCap(),
  },
});

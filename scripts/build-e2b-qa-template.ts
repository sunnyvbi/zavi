
import { join } from "node:path";
import { Template } from "e2b";

export const SEED_TEMPLATE_DIR = join(
  __dirname,
  "../apps/backend/src/services/provisioning/templates/nextjs-supabase-tailwind",
);

export const SEED_NPM_CACHE_DIRS: Record<string, string> = {
  files: "/home/user/seed-deps/base/",
  "variants/auth": "/home/user/seed-deps/auth/",
};

export function seedNpmCacheCommands(): string[] {
  return Object.values(SEED_NPM_CACHE_DIRS).map(
    (dir) =>
      `cd ${dir} && npm ci --ignore-scripts --no-audit --no-fund && rm -rf node_modules && npm ci --offline --ignore-scripts --no-audit --no-fund && rm -rf node_modules`,
  );
}

const PLAYWRIGHT_VERSION = "1.49.1";

export const template = Template({ fileContextPath: SEED_TEMPLATE_DIR })
  .fromBaseImage()
  .runCmd("mkdir -p /home/user/qa")
  .setWorkdir("/home/user/qa")
  .runCmd("npm init -y")
  .runCmd(`npm install playwright@${PLAYWRIGHT_VERSION}`)
  .runCmd(`npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium`, {
    user: "root",
  })
  .runCmd(`npx --yes playwright@${PLAYWRIGHT_VERSION} install chromium`)
  .setEnvs({ NODE_PATH: "/home/user/qa/node_modules" })
  .runCmd("node --version")
  .runCmd(
    "NODE_PATH=/home/user/qa/node_modules node -e \"require('playwright'); console.log('playwright resolves OK')\"",
  )
  .runCmd("/home/user/qa/node_modules/.bin/playwright --version")
  .runCmd(
    "NODE_PATH=/home/user/qa/node_modules node -e \"const p=require('playwright').chromium.executablePath(); require('fs').accessSync(p); console.log('chromium present:', p)\"",
  )
  .runCmd(`mkdir -p ${Object.values(SEED_NPM_CACHE_DIRS).join(" ")}`)
  .copyItems(
    Object.entries(SEED_NPM_CACHE_DIRS).flatMap(([src, dest]) =>
      ["package.json", "package-lock.json"].map((f) => ({ src: `${src}/${f}`, dest, user: "user" })),
    ),
  )
  .runCmd(seedNpmCacheCommands())
  .setWorkdir("/home/user");

const RESOURCE_TIERS: Record<string, { cpuCount: number; memoryMB: number }> = {
  "praxis-qa": { cpuCount: 2, memoryMB: 2048 },
  "praxis-large": { cpuCount: 4, memoryMB: 8192 },
  "praxis-xl": { cpuCount: 4, memoryMB: 8192 },
};

async function main() {
  if (!process.env.E2B_API_KEY && !process.env.E2B_KEY) {
    throw new Error(
      "E2B_API_KEY (or E2B_KEY) required. It's in apps/backend/.env / AWS Secrets Manager praxis-envprod-1.",
    );
  }
  if (process.env.E2B_KEY && !process.env.E2B_API_KEY) {
    process.env.E2B_API_KEY = process.env.E2B_KEY;
  }
  const requested = process.argv.slice(2);
  const aliases =
    requested.length > 0
      ? requested
      : Object.keys(RESOURCE_TIERS).filter((a) => a !== "praxis-xl");
  for (const alias of aliases) {
    const tier = RESOURCE_TIERS[alias];
    if (!tier) {
      throw new Error(
        `Unknown alias '${alias}'. Known: ${Object.keys(RESOURCE_TIERS).join(", ")}`,
      );
    }
    console.log(
      `\nBuilding ${alias} (${tier.cpuCount} vCPU, ${tier.memoryMB} MB RAM; disk = e2b org-tier default, NOT settable here)...`,
    );
    const info = await Template.build(template, alias, {
      cpuCount: tier.cpuCount,
      memoryMB: tier.memoryMB,
      onBuildLogs: (m: unknown) => {
        const s =
          typeof m === "string"
            ? m
            : typeof (m as { message?: unknown })?.message === "string"
              ? (m as { message: string }).message
              : JSON.stringify(m);
        process.stdout.write(s.endsWith("\n") ? s : s + "\n");
      },
    });
    console.log(`\nBUILD OK — ${alias}:`, JSON.stringify(info));
  }
  console.log("\nNext: set E2B_DEFAULT_TEMPLATE=praxis-qa in praxis-envprod-1 + .env");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("BUILD FAILED:", e);
    process.exit(1);
  });
}

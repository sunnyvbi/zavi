
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Template, waitForPort } from "e2b";
import {
  E2B_VITE_TEMPLATE_ALIAS,
  SITE_REPO_DIR,
  VITE_DEV_PORT,
} from "../apps/backend/src/services/sites/contract";
import { TEMPLATE_FILE_PATHS } from "../apps/backend/src/services/provisioning/templates/vite-react-supabase/template-files.generated";

export const VITE_TEMPLATE_FILES_DIR = join(
  __dirname,
  "../apps/backend/src/services/provisioning/templates/vite-react-supabase/files",
);
export const VITE_TEMPLATE_ALIAS = E2B_VITE_TEMPLATE_ALIAS;
export const NPM_CACHE_DIR = "/home/user/.cache/zavi-npm";
export const DEV_SERVER_CMD = `cd ${SITE_REPO_DIR} && npm run dev`;
const RESOURCES = { cpuCount: 2, memoryMB: 4096 };

export function assertLockfilePresent(dir: string = VITE_TEMPLATE_FILES_DIR): void {
  if (!existsSync(join(dir, "package-lock.json"))) {
    throw new Error(
      `${dir}/package-lock.json is missing. Run scripts/generate-vite-starter-lockfile.ts first (it resolves the lock in e2b).`,
    );
  }
}

const bin = (name: string) => `${SITE_REPO_DIR}/node_modules/.bin/${name}`;

const starterPaths = [
  ...TEMPLATE_FILE_PATHS,
  ...(existsSync(join(VITE_TEMPLATE_FILES_DIR, "package-lock.json")) && !TEMPLATE_FILE_PATHS.includes("package-lock.json")
    ? ["package-lock.json"]
    : []),
];

export const template = Template({ fileContextPath: VITE_TEMPLATE_FILES_DIR })
  .fromBaseImage()
  .runCmd(`mkdir -p ${SITE_REPO_DIR} ${NPM_CACHE_DIR}`)
  .copyItems(
    starterPaths.map((p) => {
      const dir = dirname(p);
      return { src: p, dest: dir === "." ? `${SITE_REPO_DIR}/` : `${SITE_REPO_DIR}/${dir}/`, user: "user" };
    }),
  )
  .setWorkdir(SITE_REPO_DIR)
  .runCmd(
    `cd ${SITE_REPO_DIR} && git init -q -b main && git add -A && git -c user.name=Zavi -c user.email=build@zaviagent.com commit -qm "starter"`,
  )
  .runCmd(`cd ${SITE_REPO_DIR} && npm ci --ignore-scripts --no-audit --no-fund --cache ${NPM_CACHE_DIR}`)
  .runCmd(`${bin("playwright")} install-deps chromium`, { user: "root" })
  .runCmd(`cd ${SITE_REPO_DIR} && ${bin("playwright")} install chromium`)
  .runCmd(`cd ${SITE_REPO_DIR} && npm run typecheck && npm run build && rm -rf dist`)
  .runCmd(
    `cd ${SITE_REPO_DIR} && node -e "const p=require('playwright').chromium.executablePath(); require('fs').accessSync(p); console.log('chromium present:', p)"`,
  )
  .runCmd(`cd ${SITE_REPO_DIR} && git status --porcelain && test -z "$(git status --porcelain)"`)
  .setStartCmd(DEV_SERVER_CMD, waitForPort(VITE_DEV_PORT));

async function main() {
  if (!process.env.E2B_API_KEY && process.env.E2B_KEY) process.env.E2B_API_KEY = process.env.E2B_KEY;
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY (or E2B_KEY) required. It is in apps/backend/.env / praxis-envprod-1.");
  }
  assertLockfilePresent();
  console.log(`Building ${VITE_TEMPLATE_ALIAS} (${RESOURCES.cpuCount} vCPU, ${RESOURCES.memoryMB} MB)...`);
  const info = await Template.build(template, VITE_TEMPLATE_ALIAS, {
    ...RESOURCES,
    onBuildLogs: (m: unknown) => {
      const s = typeof m === "string" ? m : typeof (m as { message?: unknown })?.message === "string" ? (m as { message: string }).message : JSON.stringify(m);
      process.stdout.write(s.endsWith("\n") ? s : s + "\n");
    },
  });
  console.log(`\nBUILD OK — ${VITE_TEMPLATE_ALIAS}:`, JSON.stringify(info));
}

if (require.main === module) {
  main().catch((e) => {
    console.error("BUILD FAILED:", e);
    process.exit(1);
  });
}

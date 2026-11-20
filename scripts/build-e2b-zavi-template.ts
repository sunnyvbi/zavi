
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Sandbox, Template, waitForPort } from "e2b";
import { E2B_ZAVI_TEMPLATE_ALIAS, SITE_REPO_DIR, VITE_DEV_PORT } from "../apps/backend/src/services/sites/contract";
import {
  FILES_DIR,
  collectTemplateFiles,
  writeGeneratedModule,
} from "../apps/backend/src/services/provisioning/templates/vite-react-zavi/generate-template-files";
import { TEMPLATE_FILES as SUPABASE_STARTER_FILES } from "../apps/backend/src/services/provisioning/templates/vite-react-supabase/template-files.generated";

export const NPM_CACHE_DIR = "/home/user/.cache/zavi-npm";
export const DEV_SERVER_CMD = `cd ${SITE_REPO_DIR} && npm run dev`;
const SANDBOX_DIR = "/home/user/starter";
const RESOURCES = { cpuCount: 2, memoryMB: 4096 };

export function lockfileCommands(dir: string = SANDBOX_DIR): string[] {
  return [
    `cd ${dir} && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`,
    `cd ${dir} && npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`,
    `cd ${dir} && npm run check`,
    `cd ${dir} && npm run typecheck`,
    `cd ${dir} && npm run build`,
  ];
}

export function assertLockfilePresent(dir: string = FILES_DIR): void {
  if (!existsSync(join(dir, "package-lock.json"))) {
    throw new Error(`${dir}/package-lock.json is missing. Run this script with "lockfile" first (it resolves the lock in e2b).`);
  }
}

const bin = (name: string) => `${SITE_REPO_DIR}/node_modules/.bin/${name}`;

export function buildTemplate() {
  const paths = collectTemplateFiles().map((f) => f.path);
  return Template({ fileContextPath: FILES_DIR })
    .fromBaseImage()
    .runCmd(`mkdir -p ${SITE_REPO_DIR} ${NPM_CACHE_DIR}`)
    .copyItems(
      paths.map((p) => {
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
    .runCmd(`cd ${SITE_REPO_DIR} && npm run check && npm run typecheck && npm run build && rm -rf dist`)
    .runCmd(`cd ${SITE_REPO_DIR} && git status --porcelain && test -z "$(git status --porcelain)"`)
    .setStartCmd(DEV_SERVER_CMD, waitForPort(VITE_DEV_PORT));
}

export function seedLock(): string {
  return SUPABASE_STARTER_FILES["package-lock.json"];
}

async function lockfile(): Promise<void> {
  const files = collectTemplateFiles().filter((f) => f.path !== "package-lock.json");
  files.push({ path: "package-lock.json", content: seedLock() });
  const sbx = await Sandbox.create({ timeoutMs: 15 * 60_000 });
  try {
    await sbx.files.write(files.map((f) => ({ path: `${SANDBOX_DIR}/${f.path}`, data: f.content })));
    for (const cmd of lockfileCommands()) {
      console.log(`$ ${cmd}`);
      const res = await sbx.commands.run(cmd, { timeoutMs: 10 * 60_000 });
      if (res.stdout) process.stdout.write(res.stdout.slice(-4000));
    }
    const lock = await sbx.files.read(`${SANDBOX_DIR}/package-lock.json`);
    JSON.parse(lock);
    writeFileSync(join(FILES_DIR, "package-lock.json"), lock, "utf-8");
    console.log(`OK: wrote the lockfile and regenerated the module (${writeGeneratedModule()} files).`);
  } finally {
    await sbx.kill();
  }
}

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY && process.env.E2B_KEY) process.env.E2B_API_KEY = process.env.E2B_KEY;
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY (or E2B_KEY) required.");
  const mode = process.argv[2];
  if (mode === "lockfile") return lockfile();
  if (mode !== "build") throw new Error('usage: build-e2b-zavi-template.ts lockfile|build');
  assertLockfilePresent();
  const info = await Template.build(buildTemplate(), E2B_ZAVI_TEMPLATE_ALIAS, { ...RESOURCES });
  console.log(`BUILD OK — ${E2B_ZAVI_TEMPLATE_ALIAS}:`, JSON.stringify(info));
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
}

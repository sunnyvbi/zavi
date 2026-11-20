
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "e2b";
import {
  FILES_DIR,
  collectTemplateFiles,
  writeGeneratedModule,
} from "../apps/backend/src/services/provisioning/templates/vite-react-supabase/generate-template-files";

const SANDBOX_DIR = "/home/user/starter";

export function lockfileCommands(dir: string = SANDBOX_DIR): string[] {
  return [
    `cd ${dir} && npm install --package-lock-only --ignore-scripts --no-audit --no-fund`,
    `cd ${dir} && npm ci --ignore-scripts --no-audit --no-fund`,
    `cd ${dir} && npm run typecheck`,
    `cd ${dir} && npm run build`,
  ];
}

async function main() {
  if (!process.env.E2B_API_KEY && process.env.E2B_KEY) process.env.E2B_API_KEY = process.env.E2B_KEY;
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY (or E2B_KEY) required.");

  const files = collectTemplateFiles().filter((f) => f.path !== "package-lock.json");
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
    const n = writeGeneratedModule();
    console.log(`\nOK: wrote ${join(FILES_DIR, "package-lock.json")} and regenerated the module (${n} files).`);
    console.log("Next: run the starter tests, commit, then scripts/build-e2b-vite-template.ts.");
  } finally {
    await sbx.kill();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("LOCKFILE GENERATION FAILED:", e);
    process.exit(1);
  });
}

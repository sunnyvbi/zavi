
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function repoPaths(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(relative(ROOT, abs) + "/");
      repoPaths(abs, out);
    } else out.push(relative(ROOT, abs));
  }
  return out;
}

async function main() {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: ROOT, configFile: false, logLevel: "silent", server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const m = await vite.ssrLoadModule("/src/zavi/manifest/index.ts");
    const problems = [];
    const res = m.validateManifest(readFileSync(join(ROOT, "zavi-site.json"), "utf-8"));
    if (!res.ok) for (const i of res.issues) problems.push(`zavi-site.json ${i.path || "(root)"}: ${i.message} [${i.code}]`);
    const paths = repoPaths();
    for (const p of m.forbiddenSitePaths(paths)) problems.push(`${p}: this site has no SQL database of its own; declare collections in zavi-site.json instead`);
    if (res.ok) for (const i of m.functionFileIssues(res.value.functions, paths)) problems.push(`${i.path}: ${i.message} [${i.code}]`);
    if (problems.length) {
      for (const p of problems) console.error(p);
      process.exitCode = 1;
    } else {
      console.log(`zavi-site.json is valid (hash ${res.hash.slice(0, 12)})`);
    }
  } finally {
    await vite.close();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});


import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const out = join(root, "zavi-extension.zip");

function fail(message) {
  console.error(`\n[package] REFUSED: ${message}\n`);
  process.exit(1);
}

if (process.env.ZAVI_BUILD_OUT) {
  fail("ZAVI_BUILD_OUT is set, so the build did not go to dist/. Unset it and run `npm run package` again.");
}

if (!existsSync(dist)) fail("no dist/ — run `npm run build` first.");

const manifestPath = join(dist, "manifest.json");
if (!existsSync(manifestPath)) fail("dist/manifest.json is missing; the build did not finish.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const panel = readFileSync(join(dist, "panel.js"), "utf8");
const devOrigin = [3000, 3001].find((port) => panel.includes(`http://localhost:${port}`));
if (devOrigin) {
  fail(
    `this build points at http://localhost:${devOrigin}. ` +
      "Rebuild without ZAVI_API_BASE / ZAVI_WEB_BASE.",
  );
}
if (!panel.includes("https://api.zaviagent.com")) {
  fail("this build does not point at the production API.");
}

if (!manifest.key) {
  console.warn(
    "[package] note: no `key` in the manifest. The published id is unaffected, " +
      "but an unpacked load of this build will get a DIFFERENT id and its " +
      "sign-in redirect will not match.",
  );
}

rmSync(out, { force: true });
execFileSync("zip", ["-r", "-q", out, "."], { cwd: dist });

console.log(`\n[package] ${out}`);
console.log(`[package] version ${manifest.version}\n`);

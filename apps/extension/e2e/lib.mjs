
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildExtension(tmp) {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: ROOT, stdio: "inherit" });
  const ext = join(tmp, "ext");
  cpSync(join(ROOT, "dist"), ext, { recursive: true });
  const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  mf.host_permissions = [...(mf.host_permissions ?? []), "<all_urls>"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf, null, 2));
  await build({
    entryPoints: [join(ROOT, "e2e/harness/harness.ts")],
    outfile: join(ext, "harness.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome116"],
    logLevel: "warning",
  });
  writeFileSync(
    join(ext, "harness.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>zavi e2e harness</title></head>` +
      `<body><script src="harness.js"></script></body></html>`,
  );
  return ext;
}

export async function launch(ext, userDataDir, headless, extraArgs = []) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless,
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--site-per-process", "--host-resolver-rules=MAP nested.test 127.0.0.1", ...extraArgs],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    return { context, extId: new URL(sw.url()).host };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}


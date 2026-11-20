import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES: RegExp[] = [
  /["'`]\/api\/workspace\/autopilot\/(build-product|refine-product|refine-undo|restore-checkpoint)["'`]/,
  /["'`]\/api\/workspace\/website\/chat["'`]/,
  /\/api\/workspace\/autopilot\/runs\/\$\{[^}]+\}\/continue`/,
  /sitePublishPath\(siteId\)/,
  /\/api\/channel-actions\/\$\{[^}]+\}\/redo`/,
  /\/api\/approvals\/\$\{[^}]+\}\/redo`/,
  /\/api\/agents\/\$\{[^}]+\}\/chat`/,
  /\/api\/agents\/\$\{[^}]+\}\/run`/,
  /\/api\/playbooks\/\$\{[^}]+\}\/launch`/,
  /\/api\/creators\/library\/\$\{[^}]+\}\/meta-ad`/,
  /["'`]\/api\/channels\/meta_ads\/boost["'`]/,
  /["'`]\/api\/channels\/tiktok_organic\/drafts["'`]/,
  /["'`]\/api\/social\/propose["'`]/,
  /\/api\/humans\/briefs\/\$\{[^}]+\}\/repost`/,
  /\/api\/workspace\/ad-budget\/\$\{[^}]+\}\/human-actions`/,
  /["'`]\/api\/workspace\/engineer\/preview-session["'`]/,
  /["'`]\/api\/website\/app-invites["'`]/,
  /["'`]\/api\/workspace\/export-github["'`]/,
  /["'`]\/api\/v1\/members\/invite["'`]/,
];

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...files(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function callText(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth <= 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

describe("callers of Idempotency-Key routes", () => {
  it("every mutating call sends idempotent: true", () => {
    const missing: string[] = [];
    let found = 0;
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      for (const re of ROUTES) {
        const g = new RegExp(re.source, "g");
        let m: RegExpExecArray | null;
        while ((m = g.exec(src))) {
          const lineStart = src.lastIndexOf("\n", m.index) + 1;
          const linePrefix = src.slice(lineStart, m.index);
          if (/^\s*(\/\/|\*)/.test(linePrefix)) continue;
          const open = src.lastIndexOf("apiFetch(", m.index) >= 0 && re.source.includes("sitePublishPath")
            ? src.indexOf("(", src.lastIndexOf("apiFetch(", m.index))
            : src.lastIndexOf("(", m.index);
          const call = callText(src, open);
          const mutating = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(call) || /\bbody:/.test(call);
          if (!mutating) continue;
          found++;
          if (!/idempotent:\s*true/.test(call)) {
            const line = src.slice(0, m.index).split("\n").length;
            missing.push(`${relative(SRC, f)}:${line}`);
          }
        }
      }
    }
    expect(found).toBeGreaterThan(10);
    expect(missing, `callers without idempotent: true:\n${missing.join("\n")}`).toEqual([]);
  });
});

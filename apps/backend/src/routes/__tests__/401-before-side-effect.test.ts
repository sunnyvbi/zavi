
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = join(__dirname, "..");
const WEB_FACING = [
  "workspace",
  "agents",
  "billing",
  "home",
  "onboarding",
  "members",
  "humans",
  "connectors",
  "memory",
  "approvals",
  "artifacts",
];

const MUTATION =
  /\.insert\(|\.upsert\(|\.update\(|\.delete\(|\.rpc\(|inngest\.send\(/;
const AUTH_CHECK = /verifyBearer\(|requireAuth\(/;
const FUNCTION_START = /^(export\s+)?(async\s+)?function\s|^export\s+const\s+\w+\s*=/;
const REJECT_401 = /status\(401\)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...walk(p));
    } else if (entry.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

export function mutationsBeforeRejection(
  source: string,
): { line: number; mutationLines: number[] }[] {
  const lines = source.split("\n");
  const findings: { line: number; mutationLines: number[] }[] = [];
  lines.forEach((line, i) => {
    if (!REJECT_401.test(line)) return;
    let start = 0;
    for (let j = i; j >= 0; j--) {
      if (FUNCTION_START.test(lines[j])) {
        start = j;
        break;
      }
    }
    let end = i;
    for (let k = start; k < i; k++) {
      if (AUTH_CHECK.test(lines[k])) {
        end = k;
        break;
      }
    }
    const mutationLines: number[] = [];
    for (let k = start; k < end; k++) {
      if (MUTATION.test(lines[k])) mutationLines.push(k + 1);
    }
    if (mutationLines.length > 0) findings.push({ line: i + 1, mutationLines });
  });
  return findings;
}

const files = WEB_FACING.flatMap((d) => walk(join(ROUTES, d)));
const with401 = files.filter((f) => REJECT_401.test(readFileSync(f, "utf8")));

describe("a 401 on a web-facing route happens before any side effect", () => {
  it("actually found routes to check", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(with401.length).toBeGreaterThanOrEqual(6);
  });

  it("flags an upsert before the check, not just an insert", () => {
    const bad = `
export async function postThing(req, res) {
  await sb.from("t").upsert({ a: 1 });
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated" } });
    return;
  }
}`;
    expect(mutationsBeforeRejection(bad)).toHaveLength(1);
  });

  it("does NOT flag a write that happens AFTER the handler's auth check", () => {
    const fine = `
export async function postThing(req, res) {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated" } });
    return;
  }
  await sb.from("t").insert({ a: 1 });
}`;
    expect(mutationsBeforeRejection(fine)).toHaveLength(0);
  });

  it("flags a handler that writes before it rejects", () => {
    const bad = `
export async function postThing(req, res) {
  await sb.from("t").insert({ a: 1 });
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated" } });
    return;
  }
}`;
    expect(mutationsBeforeRejection(bad)).toHaveLength(1);
  });

  it("does NOT flag a write in a different function earlier in the file", () => {
    const fine = `
export async function helper() {
  await sb.from("t").insert({ a: 1 });
}

export async function postThing(req, res) {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthenticated" } });
    return;
  }
  await sb.from("t").insert({ a: 2 });
}`;
    expect(mutationsBeforeRejection(fine)).toHaveLength(0);
  });

  it.each(with401.map((f) => [f.slice(ROUTES.length + 1), f]))(
    "%s rejects before it writes",
    (_label, file) => {
      const findings = mutationsBeforeRejection(readFileSync(file as string, "utf8"));
      expect(
        findings,
        findings.length
          ? `401 at line ${findings[0].line} runs AFTER a write at line ` +
              `${findings[0].mutationLines.join(", ")}. The web client replays a ` +
              `401'd request after refreshing the session, so that write would be ` +
              `applied twice. Move the auth check above the write, or stop ` +
              `replaying this method in apps/web/src/lib/api.ts.`
          : "",
      ).toHaveLength(0);
    },
  );
});

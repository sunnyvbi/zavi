import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DISPATCH_DECISION = join(
  __dirname,
  "../../../workers/functions/dispatch-decision.ts",
);
const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

const dispatchSrc = readFileSync(DISPATCH_DECISION, "utf-8");

function stripComments(src: string): string {
  const lines = src.split("\n");
  let inBlock = false;
  return lines
    .map((line) => {
      let out = "";
      let i = 0;
      while (i < line.length) {
        if (inBlock) {
          const close = line.indexOf("*/", i);
          if (close === -1) {
            i = line.length;
          } else {
            inBlock = false;
            i = close + 2;
          }
        } else if (line.startsWith("//", i)) {
          break;
        } else if (line.startsWith("/*", i)) {
          inBlock = true;
          i += 2;
        } else {
          out += line[i];
          i++;
        }
      }
      return out;
    })
    .join("\n");
}

function handlersBodyLines(): string[] {
  const lines = stripComments(dispatchSrc).split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("const HANDLERS"));
  expect(
    startIdx,
    "HANDLERS registry not found in dispatch-decision.ts",
  ).toBeGreaterThan(-1);
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^};\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  expect(
    endIdx,
    "HANDLERS registry close `};` not found after `const HANDLERS`",
  ).toBeGreaterThan(startIdx);
  return lines.slice(startIdx + 1, endIdx);
}

const handlersBody = handlersBodyLines();

function wiredHandlerKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of handlersBody) {
    const m = line.match(/^ {2}"([a-z0-9_.]+)":/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const STUB_PHRASES = [
  /not yet wired/i,
  /not implemented/i,
  /stub handler/i,
  /TODO:?\s*wire/i,
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

const SEEDED_HANDLER_RE =
  /'(?:auto|approval|forbidden)'\s*,\s*(?:'([a-z0-9_.]+)'|null)/gi;

function decisionClassInsertStatements(sql: string): string[] {
  const stmts: string[] = [];
  const re = /insert\s+into\s+decision_classes\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const start = m.index;
    const semi = sql.indexOf(";", start);
    stmts.push(sql.slice(start, semi === -1 ? sql.length : semi + 1));
  }
  return stmts;
}

function seededAndDeletedHandlers(): {
  seeded: Set<string>;
  deleted: Set<string>;
} {
  const seeded = new Set<string>();
  const deleted = new Set<string>();
  for (const f of migrationFiles()) {
    const raw = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
    const sql = raw
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    const lower = sql.toLowerCase();

    for (const stmt of decisionClassInsertStatements(sql)) {
      for (const m of stmt.matchAll(SEEDED_HANDLER_RE)) {
        if (m[1]) seeded.add(m[1]);
      }
    }
    if (lower.includes("update decision_classes")) {
      for (const m of sql.matchAll(
        /set\s+dispatch_handler\s*=\s*'([a-z0-9_.]+)'/gi,
      )) {
        seeded.add(m[1]);
      }
    }
    if (lower.includes("delete from decision_classes")) {
      for (const m of sql.matchAll(
        /dispatch_handler\s*=\s*'([a-z0-9_.]+)'/gi,
      )) {
        deleted.add(m[1]);
      }
    }
  }
  return { seeded, deleted };
}

describe("decision-class handler coverage — no stub / missing dispatch handler", () => {
  const wired = wiredHandlerKeys();

  it("the HANDLERS registry has a non-trivial number of wired keys (sanity)", () => {
    expect(wired.size).toBeGreaterThan(10);
    expect(wired).toContain("slack.post_message");
    expect(wired).toContain("email.send");
    expect(wired).toContain("github.open_pr");
  });

  it("no STUB handler is registered in the dispatcher (phantom-refund class)", () => {
    const body = handlersBody.join("\n");
    const offenders = STUB_PHRASES.filter((re) => re.test(body)).map(
      (re) => re.source,
    );
    expect(
      offenders,
      `STUB handler detected in dispatch-decision.ts HANDLERS registry. A handler ` +
        `that returns ok:false "not yet wired" lets an operator approve a decision ` +
        `that silently does nothing (phantom-refund class). Either WIRE the handler ` +
        `to a real connector call, or DELETE the decision_classes row(s) routing to ` +
        `it (and the handler entry) so the class is rejected at emit. Matched stub ` +
        `phrase(s): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("stripe.refund is fully removed (handler + no surviving seeded route)", () => {
    expect(wired.has("stripe.refund")).toBe(false);
    const { deleted } = seededAndDeletedHandlers();
    expect(
      deleted.has("stripe.refund"),
      "no migration DELETEs decision_classes WHERE dispatch_handler = 'stripe.refund' — " +
        "the phantom-refund route is still seeded and reachable.",
    ).toBe(true);
  });

  it("the seeded-handler parser actually SEES known handlers (catches a vacuous-green parser)", () => {
    const { seeded } = seededAndDeletedHandlers();
    expect(seeded.size).toBeGreaterThan(5);
    expect(seeded).toContain("slack.post_message");
    expect(seeded).toContain("gmail.send");
  });

  const GRANDFATHERED_ORPHANS = new Map<string, string>([
    [
      "tenant.ban_user",
      "ban_user is autonomy='forbidden' (un-approvable) — deliberate placeholder, no phantom-action risk",
    ],
    [
      "support.tag_ticket",
      "tag_ticket is a notification-only support stub, no money/PII path — out of B-9 scope, wire on first customer ask",
    ],
  ]);

  it("every surviving seeded dispatch_handler maps to a wired registry key", () => {
    const { seeded, deleted } = seededAndDeletedHandlers();
    const surviving = [...seeded].filter((h) => !deleted.has(h));
    const orphans = surviving.filter(
      (h) => !wired.has(h) && !GRANDFATHERED_ORPHANS.has(h),
    );
    expect(
      orphans,
      `Orphaned dispatch_handler(s) — seeded in a decision_classes INSERT, not ` +
        `deleted by a later migration, NOT registered in dispatch-decision.ts ` +
        `HANDLERS, and NOT grandfathered. An agent can emit a decision an operator ` +
        `approves that silently does nothing (operator gets a dispatch error, no ` +
        `side effect fires — the phantom-action / demo-trust-killer class). Either ` +
        `wire the handler in dispatch-decision.ts, or DELETE the seeding ` +
        `decision_classes row(s) in a new migration:\n` +
        orphans.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);
  });

  it("grandfathered orphans are still actually orphans (prune the list when they get wired)", () => {
    const { seeded, deleted } = seededAndDeletedHandlers();
    const surviving = new Set([...seeded].filter((h) => !deleted.has(h)));
    const stale = [...GRANDFATHERED_ORPHANS.keys()].filter(
      (h) => wired.has(h) || !surviving.has(h),
    );
    expect(
      stale,
      `Grandfathered orphan(s) no longer orphaned (now wired or row deleted) — ` +
        `remove them from GRANDFATHERED_ORPHANS:\n` +
        stale.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([]);
  });
});

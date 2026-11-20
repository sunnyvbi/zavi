
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { actionsStoreFor } from "@zavi/shared";

const CLASSES = ["channel.recipe_step"];

const TWO_STORE_MARKERS = [
  "channel_actions",
  "channel-actions",
  "channelIsSwitched",
  "actionsStoreFor",
  "readSwitchedChannelRows",
  "action_source",
];

const ROOT = resolve(process.cwd(), "..", "..");
const SCAN = [
  "apps/backend/src",
  "apps/backend/workers",
  "apps/web/src",
  "apps/mobile/src",
];

const SINGLE_STORE_BY_DESIGN: Array<{
  file: string;
  why: string;
  stillOnDecisions?: string[];
}> = [
  {
    file: "apps/backend/src/routes/approvals/redo.ts",
    why:
      "The decisions store's OWN redo route. Its sibling POST /api/channel-actions/:id/redo " +
      "owns the other store, and every caller picks between them by the card's action_source. " +
      "Reading channel_actions here would mean two routes writing one row.",
  },
  {
    file: "apps/backend/src/services/decisions/dispatch-interactive.ts",
    why:
      "Never sees a switched channel's id. It dispatches only ids emit_decision returned in " +
      "THIS run, and a switched channel's run returns from the dispatcher before emitting " +
      "(side-effect-dispatcher.ts). Its class allowlist is engineer.ship-pr alone, and it " +
      "names channel.recipe_step only to explain why that class must never be added.",
  },
  {
    file: "apps/backend/workers/functions/approval-slack-notify.ts",
    why:
      "It SUPPRESSES channel.recipe_step rather than reading them. A switched channel writes " +
      "no such row, so there is nothing to suppress and nothing to miss; the suppression stays " +
      "for the legacy rows a tenant still holds.",
  },
  {
    file: "apps/web/src/components/workspace/agent/legacyChannelActions.ts",
    why:
      "The explicitly-named fallback for a channel still on `store: \"decisions\"`. The panel " +
      "picks it by the store the server reported, so making it two-store would defeat its purpose.",
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e) || /\.(test|spec)\.tsx?$/.test(e) || e.endsWith(".d.ts")) continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

function readersOfMovedClasses(): Array<{ file: string; twoStore: boolean }> {
  const found: Array<{ file: string; twoStore: boolean }> = [];
  for (const dir of SCAN) {
    for (const p of sourceFiles(join(ROOT, dir))) {
      const src = readFileSync(p, "utf8");
      if (!CLASSES.some((c) => src.includes(c))) continue;
      if (!src.includes('"decisions"') && !src.includes("'decisions'")) continue;
      found.push({ file: rel(p), twoStore: TWO_STORE_MARKERS.some((m) => src.includes(m)) });
    }
  }
  return found;
}

describe("readers of a switched channel's actions", () => {
  it("finds the readers at all (the scan is not silently empty)", () => {
    expect(readersOfMovedClasses().length).toBeGreaterThan(4);
  });

  it("every reader of the moved class knows both stores, or says why not", () => {
    const exempt = new Set(SINGLE_STORE_BY_DESIGN.map((e) => e.file));
    const orphans = readersOfMovedClasses()
      .filter((r) => !r.twoStore && !exempt.has(r.file))
      .map((r) => r.file);
    expect(
      orphans,
      "These files query `decisions` for channel.recipe_step and never mention the " +
        "channel_actions store. For a switched channel that query matches nothing, so the " +
        "surface silently shows the founder an empty list. Read the other store (see " +
        "routes/agents/dashboards/_channel-action-rows.ts), or add the file to " +
        "SINGLE_STORE_BY_DESIGN with the reason it cannot serve a switched channel.",
    ).toEqual([]);
  });

  it("no exemption is stale: every exempt file still matches the scan", () => {
    const scanned = new Set(readersOfMovedClasses().map((r) => r.file));
    const gone = SINGLE_STORE_BY_DESIGN.map((e) => e.file).filter((f) => !scanned.has(f));
    expect(gone, "exemptions for files that no longer read the moved class").toEqual([]);
  });

  it("no exemption rests on a channel that has since switched", () => {
    const broken: string[] = [];
    for (const e of SINGLE_STORE_BY_DESIGN) {
      for (const slug of e.stillOnDecisions ?? []) {
        if (actionsStoreFor(slug) !== "decisions") broken.push(`${e.file} assumes ${slug}`);
      }
    }
    expect(
      broken,
      "An exemption above is only true while those channels write to `decisions`. One has " +
        "switched, so that reader is now an orphan and needs the second store.",
    ).toEqual([]);
  });
});

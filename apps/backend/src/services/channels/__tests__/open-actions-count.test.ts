
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  OPEN_CHANNEL_ACTIONS_VIEW,
  countOpenChannelActions,
  totalWaitingOnYou,
} from "../open-actions-count";

function client(result: { count?: number | null; error?: unknown } | Error) {
  const from = vi.fn(() => ({
    select: () => ({
      eq: async () => {
        if (result instanceof Error) throw result;
        return { count: result.count ?? null, error: result.error ?? null };
      },
    }),
  }));
  return { client: { from }, from };
}

describe("countOpenChannelActions", () => {
  it("reads the shared view, scoped to the tenant", async () => {
    const { client: sb, from } = client({ count: 3 });
    expect(await countOpenChannelActions(sb, "t-1")).toBe(3);
    expect(from).toHaveBeenCalledWith(OPEN_CHANNEL_ACTIONS_VIEW);
  });

  it("fails soft: an error or a throw costs the badge, not the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await countOpenChannelActions(client({ error: { message: "boom" } }).client, "t-1")).toBe(0);
    expect(await countOpenChannelActions(client(new Error("network")).client, "t-1")).toBe(0);
    expect(await countOpenChannelActions(client({ count: null }).client, "t-1")).toBe(0);
    warn.mockRestore();
  });
});

describe("totalWaitingOnYou", () => {
  it("adds the two stores, treating a missing count as zero", () => {
    expect(totalWaitingOnYou(4, 2)).toBe(6);
    expect(totalWaitingOnYou(null, 2)).toBe(2);
    expect(totalWaitingOnYou(4, 0)).toBe(4);
  });
});

describe("one predicate, every surface", () => {
  const SRC = path.join(process.cwd(), "src");
  const MIGRATION = path.join(
    process.cwd(),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260919183000_open_channel_actions_counts.sql",
  );

  it("the three TS counters go through the shared helper", () => {
    for (const f of [
      path.join(SRC, "routes", "workspace", "status-counters.ts"),
      path.join(SRC, "routes", "workspace", "bootstrap.ts"),
      path.join(SRC, "routes", "home", "summary.ts"),
    ]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${path.basename(f)} must count channel actions`).toContain("countOpenChannelActions");
      expect(src, `${path.basename(f)} must add the two halves in one place`).toContain("totalWaitingOnYou");
      expect(src.includes("snoozed_until")).toBe(false);
    }
  });

  it("the sidebar RPC reads the same view", () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(`create or replace view public.${OPEN_CHANNEL_ACTIONS_VIEW}`);
    expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("from customer_visible_pending_decisions d");
    expect(sql).toContain(`from ${OPEN_CHANNEL_ACTIONS_VIEW} a`);
    expect(sql).toContain("set search_path = public, pg_temp");
  });
});

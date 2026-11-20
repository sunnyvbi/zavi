import { decisionHome, type DecisionHomeKind } from "@zavi/shared";

type FixtureRow = { id?: string; decision_class: string; channel_slug?: string | null } & Record<string, unknown>;

export function homeResponseFor(url: string, approvals: { decisions?: FixtureRow[] } | null | undefined): Record<string, unknown> | null {
  if (!url.startsWith("/api/approvals?")) return null;
  const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  const raw = q.get("home");
  if (!raw) return null;
  const homes = raw.split(",") as DecisionHomeKind[];
  const totals: Record<DecisionHomeKind, number> = { channel: 0, growth: 0, needs_you: 0 };
  const rows = (approvals?.decisions ?? []).map((d, i) => {
    const h = decisionHome({ decision_class: d.decision_class, channel_slug: d.channel_slug ?? null });
    totals[h.kind] += 1;
    return {
      id: d.id ?? `fixture-${i}`,
      handler: null,
      body: {},
      status: "proposed",
      emitted_at: `2026-10-17T00:00:${String(59 - (i % 60)).padStart(2, "0")}.000Z`,
      needs_owner_admin: false,
      ...d,
      home: h.kind,
      home_channel: h.kind === "channel" ? h.slug : null,
    };
  });
  const limit = Number(q.get("limit") ?? 50);
  const picked = rows.filter((r) => homes.includes(r.home));
  return {
    decisions: picked.slice(0, limit),
    next_cursor: null,
    ...(q.get("count") === "1" ? { totals } : {}),
  };
}

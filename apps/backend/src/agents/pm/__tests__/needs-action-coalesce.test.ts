import { describe, it, expect } from "vitest";
import { decideCoalesceAction, buildCoalescedBody } from "../needs-action";

describe("decideCoalesceAction — dispatch_died fan-out coalescing", () => {
  it("dead themes + no open card → emit ONE", () => {
    expect(decideCoalesceAction(26, false)).toBe("emit");
  });
  it("dead themes + a card already open → refresh (never a second card)", () => {
    expect(decideCoalesceAction(26, true)).toBe("refresh");
  });
  it("no dead themes + a card open → auto-resolve (engineer recovered)", () => {
    expect(decideCoalesceAction(0, true)).toBe("resolve");
  });
  it("no dead themes + nothing open → noop", () => {
    expect(decideCoalesceAction(0, false)).toBe("noop");
  });
});

describe("buildCoalescedBody — one operator card for N infra deaths", () => {
  it("N deaths collapse to ONE card with the count", () => {
    const b = buildCoalescedBody(["theme a", "theme b", "theme c"]);
    expect(b.coalesced).toBe(true);
    expect(b.exception_kind).toBe("dispatch_died");
    expect(b.affected_count).toBe(3);
    expect(String(b.rendered_markdown)).toContain("3 work items");
  });
  it("is Approve-safe: roadmap_id / child_run_id / pr_url are null (nothing to redispatch/close)", () => {
    const b = buildCoalescedBody(["x", "y"]);
    expect(b.roadmap_id).toBeNull();
    expect(b.child_run_id).toBeNull();
    expect(b.pr_url).toBeNull();
  });
  it("no em-dash in outbound copy", () => {
    const b = buildCoalescedBody(["x"]);
    expect(String(b.rendered_markdown)).not.toContain("—");
    expect(String(b.rendered_markdown)).toContain("1 work item ");
  });
  it("caps the affected-themes list and notes the overflow", () => {
    const themes = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const b = buildCoalescedBody(themes);
    expect(b.affected_count).toBe(20);
    expect((b.affected_themes as string[]).length).toBe(8);
    expect(String(b.rendered_markdown)).toContain("and 12 more");
  });
});

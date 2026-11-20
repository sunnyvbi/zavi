
import { describe, expect, it } from "vitest";
import { X_TABLE_IDS, xTables } from "./xTables";

const sig = (key: string, status: "pass" | "fix" | "unknown", link: string | null = null) => ({
  key,
  label: `Label ${key}`,
  status,
  note: `Note ${key}`,
  link,
});

function checklist(signals: ReturnType<typeof sig>[]) {
  const t = xTables({ connected: true, checklist: { passed: 0, total: signals.length, signals } }).find(
    (x) => x.id === X_TABLE_IDS.checklist,
  )!;
  return t;
}

describe("X top posts", () => {
  it("leaves top posts to the Analytics tab", () => {
    const post = { id: "a", text: "a", views: 10, likes: 0, replies: 0, reposts: 0, bookmarks: 0, eng_rate: 1, posted_at: null, url: null };
    expect(xTables({ connected: true, top_posts: [post] }).find((x) => x.id === X_TABLE_IDS.posts)).toBeUndefined();
  });
});

describe("X profile checklist", () => {
  it("orders failing, then unknown, then passing in the tail", () => {
    const t = checklist([sig("avatar", "pass"), sig("verified", "unknown"), sig("pinned", "fix", "https://x.com/a"), sig("header", "fix", "https://x.com/b")]);
    expect(t.rows.map((r) => [r.id, !!r.tail])).toEqual([
      ["pinned", false],
      ["header", false],
      ["verified", false],
      ["avatar", true],
    ]);
    expect(t.tailToggle?.show(1)).toBe("Show more");
    expect(t.tailToggle?.hide).toBe("Show less");
    expect(t.detailInDrawer).toBe(true);
  });

  it("gives every failing row a fix: X's own page where it has one, else Zavi in chat", () => {
    const t = checklist([sig("pinned", "fix", "https://x.com/a"), sig("cadence", "fix", null), sig("verified", "unknown")]);
    const by = Object.fromEntries(t.rows.map((r) => [r.id, r]));
    expect(by.pinned!.actions).toEqual([expect.objectContaining({ label: "Fix on X", href: "https://x.com/a" })]);
    expect(by.cadence!.actions?.[0]).toMatchObject({ label: "Fix with Zavi" });
    expect(by.cadence!.actions?.[0]?.chatDraft).toContain("Post at least 3 times a week");
    expect(by.verified!.actions).toBeUndefined();
  });

  it("reads a failed rule as the to-do, and puts the note behind Why", () => {
    const t = checklist([sig("cadence", "fix", null), sig("avatar", "pass")]);
    const cadence = t.rows.find((r) => r.id === "cadence")!;
    expect(cadence.cells[0]).toEqual({ text: "Post at least 3 times a week" });
    expect(cadence.detail).toMatchObject({ openLabel: "Why", text: "Note cadence" });
    const avatar = t.rows.find((r) => r.id === "avatar")!;
    expect(avatar.cells[0]).toEqual({ text: "Label avatar", sub: "Note avatar" });
    expect(avatar.detail).toBeUndefined();
  });
});

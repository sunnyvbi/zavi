import { describe, expect, it, vi } from "vitest";
import { parseMetricsDeclaration, recordMetricsDeclaration } from "../metrics-declaration";

const file = (content: string, path = "zavi-metrics.json") => ({ path, content });

describe("parseMetricsDeclaration", () => {
  it("reads signups and the business event", () => {
    const d = parseMetricsDeclaration([
      file(JSON.stringify({
        signups: { table: "users", created_at: "created_at" },
        business_event: { table: "orders", created_at: "placed_at" },
      })),
    ]);
    expect(d).toEqual({
      signups: { table: "users", created_at: "created_at" },
      business_event: { table: "orders", created_at: "placed_at" },
    });
  });

  it("keeps an explicit null business event", () => {
    const d = parseMetricsDeclaration([file(JSON.stringify({ signups: { table: "users", created_at: "created_at" }, business_event: null }))]);
    expect(d?.business_event).toBeNull();
  });

  it("drops names that are not plain identifiers", () => {
    const d = parseMetricsDeclaration([
      file(JSON.stringify({ signups: { table: "users; drop table x", created_at: "created_at" }, business_event: { table: "orders", created_at: "a b" } })),
    ]);
    expect(d).toEqual({ signups: null, business_event: null });
  });

  it("ignores a push without the file, a nested copy, a deleted or bad file", () => {
    expect(parseMetricsDeclaration([])).toBeUndefined();
    expect(parseMetricsDeclaration([file("{}", "src/zavi-metrics.json")])).toBeUndefined();
    expect(parseMetricsDeclaration([{ path: "zavi-metrics.json", action: "delete", content: "{}" }])).toBeUndefined();
    expect(parseMetricsDeclaration([file("not json")])).toBeUndefined();
    expect(parseMetricsDeclaration([file("[1]")])).toBeUndefined();
    expect(parseMetricsDeclaration([null, { content: "{}" }] as never)).toBeUndefined();
  });
});

describe("recordMetricsDeclaration", () => {
  it("stores what the push declares, for the given tenant", async () => {
    const store = vi.fn(async () => undefined);
    await recordMetricsDeclaration("t1", [file(JSON.stringify({ signups: null, business_event: null }))], store);
    expect(store).toHaveBeenCalledWith("t1", { signups: null, business_event: null });
  });

  it("never throws when the store fails", async () => {
    const store = vi.fn(async () => { throw new Error("db down"); });
    await expect(recordMetricsDeclaration("t1", [file("{}")], store)).resolves.toBeUndefined();
  });

  it("does not store when the push has no declaration", async () => {
    const store = vi.fn(async () => undefined);
    await recordMetricsDeclaration("t1", [file("x", "README.md")], store);
    expect(store).not.toHaveBeenCalled();
  });
});

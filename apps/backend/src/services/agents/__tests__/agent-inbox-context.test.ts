import { describe, it, expect } from "vitest";
import { buildInboxAddressBlock } from "../agent-inbox-context";
import { buildStablePromptPrefix } from "../generic-dispatcher";

function stubClient(opts: {
  row?: { reply_to_address: string | null } | null;
  error?: { message: string } | null;
  captureEq?: Array<[string, unknown]>;
}) {
  const eqCalls = opts.captureEq ?? [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.eq = (k: string, v: unknown) => {
    eqCalls.push([k, v]);
    return builder;
  };
  builder.maybeSingle = async () => ({
    data: opts.row ?? null,
    error: opts.error ?? null,
  });
  return { from: () => builder } as never;
}

describe("buildInboxAddressBlock", () => {
  it("renders the active address when one exists", async () => {
    const block = await buildInboxAddressBlock(
      "t-1",
      stubClient({ row: { reply_to_address: "upcarai@inbox.zaviagent.com" } }),
    );
    expect(block).toBeDefined();
    expect(block).toContain("upcarai@inbox.zaviagent.com");
    expect(block).toContain("Your email inbox");
    expect(block!.toLowerCase()).toContain("do not say you don't have");
    expect(block!.toLowerCase()).toContain("untrusted");
  });

  it("returns undefined when the tenant has no active identity (silent absence)", async () => {
    const block = await buildInboxAddressBlock("t-1", stubClient({ row: null }));
    expect(block).toBeUndefined();
  });

  it("returns undefined (soft-fail) on a read error — never blocks the run", async () => {
    const block = await buildInboxAddressBlock(
      "t-1",
      stubClient({ row: null, error: { message: "boom" } }),
    );
    expect(block).toBeUndefined();
  });

  it("returns undefined on an empty/whitespace address", async () => {
    const block = await buildInboxAddressBlock(
      "t-1",
      stubClient({ row: { reply_to_address: "   " } }),
    );
    expect(block).toBeUndefined();
  });

  it("returns undefined for an empty tenant_id without touching the client", async () => {
    let touched = false;
    const spy = { from: () => ((touched = true), undefined) } as never;
    const block = await buildInboxAddressBlock("", spy);
    expect(block).toBeUndefined();
    expect(touched).toBe(false);
  });

  it("scopes the read to the tenant (C8) — filters on tenant_id + active", async () => {
    const captureEq: Array<[string, unknown]> = [];
    await buildInboxAddressBlock(
      "tenant-abc",
      stubClient({
        row: { reply_to_address: "x@inbox.zaviagent.com" },
        captureEq,
      }),
    );
    expect(captureEq).toContainEqual(["tenant_id", "tenant-abc"]);
    expect(captureEq).toContainEqual(["status", "active"]);
  });
});

describe("buildStablePromptPrefix — inbox address lands in the identity region", () => {
  it("appends the inbox block after the fact sheet, before instructions", () => {
    const out = buildStablePromptPrefix({
      body_markdown: "You are operator.",
      memory: {},
      companyFactSheet: "## Who you work for\nYou work for **UpcarAI**.",
      inboxAddressBlock:
        "## Your email inbox\nYou have a shared team email inbox: **upcarai@inbox.zaviagent.com**.",
    });
    expect(out).toContain("upcarai@inbox.zaviagent.com");
    expect(out.indexOf("Who you work for")).toBeLessThan(
      out.indexOf("Your email inbox"),
    );
  });

  it("renders nothing extra when no inbox block is supplied", () => {
    const out = buildStablePromptPrefix({
      body_markdown: "You are operator.",
      memory: {},
    });
    expect(out).not.toContain("Your email inbox");
  });
});

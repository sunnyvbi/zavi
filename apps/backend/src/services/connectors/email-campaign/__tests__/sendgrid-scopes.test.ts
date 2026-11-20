import { describe, it, expect, vi } from "vitest";
import { campaignReady, checkSendgridKey, groupsFromScopes, SENDGRID_GROUPS, SENDGRID_SCOPES_PATH, SENDGRID_VERIFIED_SENDERS_PATH } from "../sendgrid-scopes";

describe("sendgrid permission groups", () => {
  it("maps published scope strings to groups; senders comes from the live read", () => {
    const g = groupsFromScopes(["mail.send", "marketing.read", "stats.read", "asm.groups.read"], true);
    expect(campaignReady(g)).toBe(true);
    expect(groupsFromScopes(["mail.send", "marketing.read", "stats.read", "asm.groups.read"], false).senders_read).toBe(false);
  });

  it("legacy marketing_campaigns.* scopes do not count as Email Marketing", () => {
    const g = groupsFromScopes(["marketing_campaigns.read", "marketing_campaigns.create"], true);
    expect(g.marketing_lists_read).toBe(false);
    expect(g.single_sends_write).toBe(false);
  });

  it("a missing group is never campaign ready", () => {
    for (const missing of SENDGRID_GROUPS) {
      const all = Object.fromEntries(SENDGRID_GROUPS.map((x) => [x, x !== missing]));
      expect(campaignReady(all)).toBe(false);
    }
  });

  it("calls GET /v3/scopes and the verified senders read with a Bearer key, nothing else", async () => {
    const f = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.endsWith(SENDGRID_SCOPES_PATH) ? { scopes: ["mail.send"] } : { results: [] }), { status: 200 }),
    );
    const r = await checkSendgridKey("SG.a.b", f as unknown as typeof fetch);
    expect(r.status).toBe("ok");
    const urls = f.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([`https://api.sendgrid.com${SENDGRID_SCOPES_PATH}`, `https://api.sendgrid.com${SENDGRID_VERIFIED_SENDERS_PATH}?limit=1`]);
    for (const c of f.mock.calls) {
      const init = (c as unknown[])[1] as RequestInit;
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SG.a.b");
    }
  });

  it("403 on scopes reads as an invalid key; a 500 as unreachable", async () => {
    expect((await checkSendgridKey("SG.a.b", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch)).status).toBe("invalid");
    expect((await checkSendgridKey("SG.a.b", (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch)).status).toBe("unreachable");
  });
  it("a blip on the verified-senders read is unreachable, never a missing permission that overwrites a good key", async () => {
    for (const blip of [408, 409, 429, 500, 503, 0]) {
      const f = vi.fn(async (url: string) => {
        if (url.endsWith(SENDGRID_SCOPES_PATH)) return new Response(JSON.stringify({ scopes: ["mail.send", "marketing.read", "stats.read", "asm.groups.read"] }), { status: 200 });
        if (blip === 0) throw new TypeError("fetch failed");
        return new Response("{}", { status: blip });
      });
      expect((await checkSendgridKey("SG.a.b", f as unknown as typeof fetch)).status).toBe("unreachable");
    }
  });

  it("a real refusal on the senders read still reads as the missing Sender verification permission", async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith(SENDGRID_SCOPES_PATH)
        ? new Response(JSON.stringify({ scopes: ["mail.send", "marketing.read", "stats.read", "asm.groups.read"] }), { status: 200 })
        : new Response("{}", { status: 403 }),
    );
    const r = await checkSendgridKey("SG.a.b", f as unknown as typeof fetch);
    expect(r).toMatchObject({ status: "ok", campaign_ready: false, missing: ["senders_read"] });
  });
});

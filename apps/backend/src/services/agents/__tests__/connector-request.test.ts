
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConnectorRequest } from "@zavi/shared";
import {
  emitConnectorRequest,
  findConnectActionLink,
  isConnectorRequestToolName,
  promoteConnectActionLink,
  stripConnectActionLinks,
  replyTextWithConnectorRequest,
  selectBackstopConnector,
} from "../connector-request";
import {
  ExpectedToolError,
  connectorErrorFromContent,
  fillTraceFromToolResult,
  type ToolCallTrace,
} from "@/services/tools/types";

const base = { run_id: "11111111-1111-4111-8111-111111111111", reason: "to read your campaigns" };

describe("emitConnectorRequest — surface branch", () => {
  it("web chat: a schema-valid envelope + a one-line reply", () => {
    const r = emitConnectorRequest({ ...base, slug: "meta_ads", origin: "model", mode: "connect", trigger: "chat" });
    expect(r).not.toBeNull();
    expect(parseConnectorRequest(r!.request)).not.toBeNull();
    expect(r!.request).toMatchObject({
      kind: "connector_request",
      slug: "meta_ads",
      label: "Meta Ads",
      connect: "oauth",
      origin: "model",
      mode: "connect",
      run_id: base.run_id,
    });
    expect(r!.text).toBe("I need Meta Ads for this.");
  });

  it("slack / whatsapp: text line with the Settings link, NO envelope", () => {
    for (const trigger of ["slack", "whatsapp", "telegram"]) {
      const r = emitConnectorRequest({ ...base, slug: "github", origin: "model", mode: "connect", trigger });
      expect(r!.request).toBeNull();
      expect(r!.text).toBe(
        "I need GitHub for this. Connect it: https://www.zaviagent.com/workspace?tab=settings#connector-github",
      );
    }
  });

  it("scrubs and caps the model-written reason", () => {
    const r = emitConnectorRequest({
      ...base,
      reason: `email me at jane@example.com ${"x".repeat(400)}`,
      slug: "stripe",
      origin: "model",
      mode: "connect",
      trigger: "chat",
    });
    expect(r!.request!.reason).not.toContain("jane@example.com");
    expect(r!.request!.reason.length).toBeLessThanOrEqual(200);
  });

  it("returns null for a slug that names no connector", () => {
    expect(
      emitConnectorRequest({ ...base, slug: "ads", origin: "tool_error", mode: "connect", trigger: "chat" }),
    ).toBeNull();
  });

  it("uses the Pipedream catalog label for pipedream.<app>", () => {
    const r = emitConnectorRequest({
      ...base,
      slug: "pipedream.hubspot",
      label: "HubSpot",
      origin: "model",
      mode: "connect",
      trigger: "chat",
    });
    expect(r!.request).toMatchObject({ label: "HubSpot", connect: "pipedream" });
  });
});

describe("replyTextWithConnectorRequest", () => {
  const web = emitConnectorRequest({ ...base, slug: "github", origin: "model", mode: "connect", trigger: "chat" })!;
  const slack = emitConnectorRequest({ ...base, slug: "github", origin: "model", mode: "connect", trigger: "slack" })!;
  it("web keeps the model's own line, falls back to the helper line when empty", () => {
    expect(replyTextWithConnectorRequest("I need your repo to fix that.", web, "model")).toBe(
      "I need your repo to fix that.",
    );
    expect(replyTextWithConnectorRequest("  ", web, "model")).toBe("I need GitHub for this.");
  });
  it("non-web: link line replaces a model reply, is appended to a tool-error reply", () => {
    expect(replyTextWithConnectorRequest("sure", slack, "model")).toBe(slack.text);
    expect(replyTextWithConnectorRequest("Partial answer.", slack, "tool_error")).toBe(
      `Partial answer.\n\n${slack.text}`,
    );
  });
});

describe("backstop — connector_slug on the trace", () => {
  const trace = (over: Partial<ToolCallTrace>): ToolCallTrace => ({
    name: "mcp__server__meta_ads__list_campaigns",
    input_preview: "",
    output_preview: "",
    ms: 1,
    status: "tool_error",
    ...over,
  });

  it("SDK seam: a *_not_connected error result sets code + connector_slug → connect card", () => {
    const t = trace({});
    fillTraceFromToolResult(t, {
      is_error: true,
      content: [{ type: "text", text: JSON.stringify({ error: "meta_ads_not_connected", message: "m" }) }],
    });
    expect(t.connector_slug).toBe("meta_ads");
    expect(selectBackstopConnector([t])).toEqual({ slug: "meta_ads", mode: "connect" });
  });

  it("*_auth_expired → reconnect", () => {
    const t = trace({});
    fillTraceFromToolResult(t, { is_error: true, content: JSON.stringify({ error: "jira_auth_expired" }) });
    expect(selectBackstopConnector([t])).toEqual({ slug: "jira", mode: "reconnect" });
  });

  it("an error with no connector_slug never produces a card", () => {
    const codes = ["repo_not_connected", "cohort_not_connected", "ads_not_connected", "rate_limited"];
    const traces = codes.map((code) => {
      const t = trace({});
      fillTraceFromToolResult(t, { is_error: true, content: JSON.stringify({ error: code }) });
      return t;
    });
    expect(traces.every((t) => t.connector_slug === undefined)).toBe(true);
    expect(selectBackstopConnector(traces)).toBeNull();
    expect(selectBackstopConnector([trace({ status: "ok", connector_slug: "github", code: "github_not_connected" })])).toBeNull();
  });

  it("meta.connector_slug names the platform for an otherwise ambiguous code", () => {
    const e = new ExpectedToolError("ads_not_connected", "m", { connector_slug: "meta_ads" });
    const content = JSON.stringify({ error: e.code, message: e.message, meta: e.meta });
    expect(connectorErrorFromContent(content)).toEqual({ code: "ads_not_connected", connector_slug: "meta_ads" });
  });

  it("growth__read_ads_perf's ads_not_connected names no connector (no Meta card on a growth-plan ask) but steers a platform ask to connectors__request", () => {
    const src = readFileSync(join(__dirname, "../../tools/growth/read_ads_perf.ts"), "utf8");
    const throwSite = src.slice(src.indexOf('"ads_not_connected"'), src.indexOf('"ads_not_connected"') + 400);
    expect(throwSite).not.toMatch(/connector_slug/);
    expect(throwSite).toMatch(/call connectors__request with its slug \(meta_ads or google_ads\)/);
    const snap = readFileSync(join(__dirname, "../../tools/paid-acquisition/get_latest_snapshot.ts"), "utf8");
    const snapSite = snap.slice(snap.indexOf('"snapshot_missing"'), snap.indexOf('"snapshot_missing"') + 1500);
    expect(snapSite).toMatch(/call connectors__request with slug "\$\{provider\}"/);
    expect(snapSite).not.toMatch(/connector_slug/);
    const t = trace({});
    fillTraceFromToolResult(t, {
      is_error: true,
      content: JSON.stringify({ error: "ads_not_connected", message: "Neither Google Ads nor Meta Ads" }),
    });
    expect(selectBackstopConnector([t])).toBeNull();
  });

  it("instagram / youtube insight reads name their Composio connector (backstop fires)", () => {
    const ig = readFileSync(join(__dirname, "../../tools/instagram/read_insights.ts"), "utf8");
    const yt = readFileSync(join(__dirname, "../../tools/youtube-insights/read.ts"), "utf8");
    expect(ig).toMatch(/"instagram_not_connected",[\s\S]{0,300}connector_slug: "composio\.instagram"/);
    expect(yt).toMatch(/"youtube_analytics_not_connected",[\s\S]{0,300}connector_slug: "composio\.youtube"/);
    const t = trace({});
    fillTraceFromToolResult(t, {
      is_error: true,
      content: JSON.stringify({ error: "instagram_not_connected", meta: { connector_slug: "composio.instagram" } }),
    });
    expect(selectBackstopConnector([t])).toEqual({ slug: "composio.instagram", mode: "connect" });
  });

  it("meta.connector_mode=reconnect (github row present, install gone) → reconnect card", () => {
    const t = trace({});
    fillTraceFromToolResult(t, {
      is_error: true,
      content: JSON.stringify({
        error: "github_not_connected",
        meta: { connector_slug: "github", connector_mode: "reconnect" },
      }),
    });
    expect(selectBackstopConnector([t])).toEqual({ slug: "github", mode: "reconnect" });
  });
});

describe("action-link promotion (model wrote a connect link instead of calling the tool)", () => {
  const reply = "I can't read your Meta Ads yet.\n\n[Connect Meta Ads](/__praxis_action__/connect:meta_ads)\n\nThen ask me again.";
  const notConnected = async (slug: string) => ({ ok: true as const, slug, label: "Meta Ads" });
  const connected = async () => ({ ok: false as const, error: "already_connected" });
  const trace = (over: Partial<ToolCallTrace>): ToolCallTrace => ({
    name: "mcp__server__jira__search",
    input_preview: "",
    output_preview: "",
    ms: 1,
    status: "tool_error",
    ...over,
  });

  it("finds the first connect/reauth link whose slug is a connector", () => {
    expect(findConnectActionLink(reply)).toEqual({ slug: "meta_ads", verb: "connect" });
    expect(findConnectActionLink("[x](/__praxis_action__/connect:nope) [y](/__praxis_action__/reauth:jira)")).toEqual({
      slug: "jira",
      verb: "reauth",
    });
    expect(findConnectActionLink("plain chat, no link")).toBeNull();
  });

  it("web + tenant without meta: card emitted, link line stripped, validated with the given tenant fn", async () => {
    const seen: string[] = [];
    const r = await promoteConnectActionLink({
      text: reply,
      run_id: base.run_id,
      trigger: "chat",
      toolCalls: [],
      validate: async (slug) => {
        seen.push(slug);
        return notConnected(slug);
      },
    });
    expect(seen).toEqual(["meta_ads"]);
    expect(r!.emitted.request).toMatchObject({ slug: "meta_ads", origin: "model", mode: "connect", label: "Meta Ads" });
    expect(r!.text).toBe("I can't read your Meta Ads yet.\n\nThen ask me again.");
    expect(r!.text).not.toContain("__praxis_action__");
  });

  it("inline link: the sentence keeps the link's label; a link-only line is dropped", () => {
    expect(stripConnectActionLinks("Please [connect Meta Ads](/__praxis_action__/connect:meta_ads) to continue.", "meta_ads")).toBe(
      "Please connect Meta Ads to continue.",
    );
    expect(stripConnectActionLinks("Linear isn't connected. [Connect Linear](/__praxis_action__/connect:linear)", "linear")).toBe(
      "Linear isn't connected. Connect Linear",
    );
    expect(stripConnectActionLinks("Hi.\n- [Connect Linear](/__praxis_action__/connect:linear)\nBye.", "linear")).toBe("Hi.\nBye.");
  });

  it("already-connected slug on a connect link → no card", async () => {
    const r = await promoteConnectActionLink({ text: reply, run_id: base.run_id, trigger: "chat", toolCalls: [], validate: connected });
    expect(r).toBeNull();
  });

  it("reauth link → reconnect card only when this run hit a reconnect-class error on that slug", async () => {
    const text = "[Reconnect Jira](/__praxis_action__/reauth:jira)";
    const healthy = await promoteConnectActionLink({ text, run_id: base.run_id, trigger: "chat", toolCalls: [], validate: connected });
    expect(healthy).toBeNull();
    const connectErr = trace({ status: "tool_error", code: "jira_not_connected", connector_slug: "jira" });
    const otherSlug = trace({ status: "tool_error", code: "linear_auth_expired", connector_slug: "linear" });
    expect(
      await promoteConnectActionLink({ text, run_id: base.run_id, trigger: "chat", toolCalls: [connectErr, otherSlug], validate: connected }),
    ).toBeNull();
    const expired = trace({ status: "tool_error", code: "jira_auth_expired", connector_slug: "jira" });
    const r = await promoteConnectActionLink({ text, run_id: base.run_id, trigger: "chat", toolCalls: [expired], validate: connected });
    expect(r!.emitted.request).toMatchObject({ slug: "jira", mode: "reconnect" });
    expect(r!.text).toBe("");
    const off = await promoteConnectActionLink({
      text,
      run_id: base.run_id,
      trigger: "chat",
      toolCalls: [expired],
      validate: async () => ({ ok: false, error: "connector_request_disabled" }),
    });
    expect(off).toBeNull();
  });

  it("no link → no card and validation never runs (plain chat)", async () => {
    let called = false;
    const r = await promoteConnectActionLink({
      text: "Here is your weekly summary.",
      run_id: base.run_id,
      trigger: "chat",
      toolCalls: [],
      validate: async (slug) => {
        called = true;
        return notConnected(slug);
      },
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it("off web (slack) keeps today's behaviour: no promotion", async () => {
    const r = await promoteConnectActionLink({ text: reply, run_id: base.run_id, trigger: "slack", toolCalls: [], validate: notConnected });
    expect(r).toBeNull();
  });
});

describe("tool name matching", () => {
  it("matches the SDK-wrapped and bare forms only", () => {
    expect(isConnectorRequestToolName("mcp__server__connectors__request")).toBe(true);
    expect(isConnectorRequestToolName("connectors__request")).toBe(true);
    expect(isConnectorRequestToolName("mcp__server__connectors__search")).toBe(false);
  });
});

describe("wiring (source)", () => {
  const dispatcher = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");
  const chat = readFileSync(join(__dirname, "../chat-dispatcher.ts"), "utf8");

  it("canUseTool validates connectors__request server-side with the RUN tenant and denies with the card message", () => {
    expect(dispatcher).toMatch(
      /isConnectorRequestToolName\(toolName\)[\s\S]{0,900}validateConnectorRequest\(ctx\.tenant_id, slug, \{ repo_hint: repoHintOf\(payload\) \}\)[\s\S]{0,300}CONNECTOR_REQUEST_DENY_MESSAGE/,
    );
  });

  it("with no request and no backstop, the reply's action link is promoted with the RUN tenant", () => {
    expect(dispatcher).toMatch(
      /promoteConnectActionLink\(\{[\s\S]{0,200}validate: \(slug\) => validateConnectorRequest\(ctx\.tenant_id, slug, \{ repo_hint: repoHintOf\(payload\) \}\)/,
    );
  });

  it("promotion also takes the handler-recorded request (engines without canUseTool)", () => {
    expect(dispatcher).toMatch(/takeRecordedConnectorRequest\(ctx\.runId\)/);
  });

  it("the promotion runs for every agent and the result carries connector_request", () => {
    expect(dispatcher).toMatch(/selectBackstopConnector\(toolCalls\)/);
    expect(dispatcher).toMatch(/connector_request: connectorRequest,/);
  });

  it("chat-dispatcher writes meta.connector_request as a sibling key AFTER the clarify branch", () => {
    const clarify = chat.indexOf('meta.envelope_schema = "clarifying_questions"');
    const req = chat.indexOf("meta.connector_request = result.connector_request");
    expect(clarify).toBeGreaterThan(0);
    expect(req).toBeGreaterThan(clarify);
  });

  it("the degraded preface no longer tells the agent to offer connector setup", () => {
    expect(dispatcher).not.toMatch(/Offer to help set up the required connectors/);
  });
});

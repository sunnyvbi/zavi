import { describe, expect, it, vi } from "vitest";
import { parseConnectorRequest } from "@zavi/shared";
import { promoteMissingConnectorReply } from "../connector-request";

const run_id = "11111111-1111-4111-8111-111111111111";
const validate = () => vi.fn(async (slug: string) => ({ ok: true as const, slug, label: slug }));

describe("missing connection reply recovery", () => {
  it.each([
    ["Search Console isn’t connected, so I have no rankings to read.", "google_search_console"],
    ["Google Analytics isn’t connected (I checked), so there are no starting numbers.", "google_analytics"],
    ["I can’t access Slack.", "slack"],
    ["I cannot read your Google Analytics data.", "google_analytics"],
    ["**GA4** is not connected.", "google_analytics"],
    ["Your GitHub is not connected yet.", "github"],
    ["Slack is connected but Jira isn't.", "jira"],
    ["Slack works, but Jira is not connected.", "jira"],
    ["Slack isn't connected. Jira is not needed for this task.", "slack"],
    ["I can't see rankings or search volume, because Search Console isn't connected.", "google_search_console"],
    ["- **No ad channel fits $50 yet:** Reddit Ads isn't connected.", "reddit_ads"],
    ["- **Posting:** TikTok isn't connected here, and staging uploads is still waiting on TikTok's audit.", "tiktok"],
    ["Meta also isn't connected to Zavi.", "meta_ads"],
    ["Meta isn't connected, so I can't see what its ads cost.", "meta_ads"],
  ])("offers the named service for %s", async (text, slug) => {
    const check = validate();
    const result = await promoteMissingConnectorReply({ text, run_id, trigger: "chat", validate: check });
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(slug);
    expect(result?.emitted.request).toMatchObject({ slug, mode: "connect", origin: "model", run_id });
    expect(parseConnectorRequest(result?.emitted.request)).not.toBeNull();
    expect(result?.text).toBe(text);
  });

  it.each([
    "Meta isn't connected, so I can't publish to Instagram.",
    "If Slack isn't connected, you can connect it in Settings.",
    "When Slack is not connected, the button is shown.",
    'For example: "Slack is not connected".',
    '"Slack is not connected."',
    "'Slack isn't connected.'",
    "> Slack is not connected.",
    "```text\nSlack is not connected.\n```",
    "`Slack is not connected` is the example error.",
    "Slack is not connected?",
    "I can't say Slack isn't connected.",
    "Slack is connected. Jira has no permission to read the project.",
    "I can't access Slack because I lack the required scope.",
    "I can't access Slack because of a rate limit.",
    "I can’t access Slack. The API is rate limited.",
    "I cannot access Slack. The required permission was denied.",
    "I can't access Slack temporarily; try again later.",
    "I can't access Slack: HTTP 403.",
    "I can't access the database.",
    "Analytics isn't connected.",
    "X isn't connected.",
    "I can't access an unknown app.",
    "Slack is not disconnected.",
    "You can connect Google Analytics for deeper analysis.",
    "Slack isn't connected, but it isn't needed for this request.",
    "Slack isn't connected. We don't need it for this task.",
    "Slack isn't connected. Slack is not required for this analysis.",
    "Google Analytics isn't connected, but we don't need Google Analytics for this task.",
    "Slack still isn't connected, but Slack still isn't needed for this request.",
    "Meta also isn't connected. It currently is not required for this analysis.",
    "Search Console isn't connected. We still don't need it for this task.",
  ])("does not invent a connect step for %s", async text => {
    const check = validate();
    expect(await promoteMissingConnectorReply({ text, run_id, trigger: "chat", validate: check })).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps useful completed partial work and adds only one card", async () => {
    const text = "Your public page has a clear title. Slack isn't connected. Jira isn't connected.";
    const check = validate();
    const result = await promoteMissingConnectorReply({ text, run_id, trigger: "chat", validate: check });
    expect(result?.text).toBe(text);
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith("slack");
  });

  it.each(["already_connected", "connector_request_disabled", "connector_catalog_unavailable", "unknown_connector"])("leaves the reply alone when validation says %s", async error => {
    const check = vi.fn(async () => ({ ok: false as const, error }));
    expect(await promoteMissingConnectorReply({text:"Slack isn't connected. Jira isn't connected.", run_id, trigger:"chat", validate:check})).toBeNull();
    expect(check).toHaveBeenCalledOnce();
  });

  it("fails open on validation failure", async () => {
    expect(await promoteMissingConnectorReply({text:"Slack isn't connected.", run_id, trigger:"chat", validate:async()=>{throw Error("unavailable");}})).toBeNull();
  });

  it.each(["slack", "cron", "mcp", "manual"])("does not add web cards to %s", async trigger => {
    const check=validate();
    expect(await promoteMissingConnectorReply({text:"Slack isn't connected.", run_id, trigger, validate:check})).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});

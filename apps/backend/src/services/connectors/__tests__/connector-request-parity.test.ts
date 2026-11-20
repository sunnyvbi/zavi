
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CONNECTOR_CONNECT,
  CONNECTOR_DESCRIPTORS,
  descriptorsMissingConnectInfo,
  connectInfoFor,
  connectorSettingsPath,
  parseConnectorRequest,
  satisfyingSlugs,
  linkedWithAliases,
} from "@zavi/shared";
import { isKnownConnector } from "@/services/connectors/core/registry";

const ROUTES = readFileSync(path.join(__dirname, "../../../routes/index.ts"), "utf8");

describe("connector-request parity", () => {
  it("every descriptor has connect info", () => {
    expect(descriptorsMissingConnectInfo()).toEqual([]);
  });

  it("every connect-info key is a real descriptor", () => {
    const slugs = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.slug));
    expect(Object.keys(CONNECTOR_CONNECT).filter((s) => !slugs.has(s))).toEqual([]);
  });

  it("every oauth connector has a start route for its canonical slug", () => {
    const missing = Object.entries(CONNECTOR_CONNECT)
      .filter(([, i]) => i.connect === "oauth")
      .map(([slug]) => slug)
      .filter(
        (slug) =>
          !ROUTES.includes(`"/api/connectors/${slug}/start"`) && !isKnownConnector(slug),
      );
    expect(missing).toEqual([]);
  });

  it("any pipedream app is requestable; unknown slugs are not", () => {
    expect(connectInfoFor("pipedream.hubspot", "HubSpot")).toEqual({
      connect: "pipedream",
      label: "HubSpot",
      settingsAnchor: null,
    });
    expect(connectInfoFor("pipedream.Bad Slug")).toBeNull();
    expect(connectInfoFor("not_a_connector")).toBeNull();
  });

  it("any composio app is requestable with connect kind composio", () => {
    expect(connectInfoFor("composio.notion")).toEqual({ connect: "composio", label: "notion", settingsAnchor: null });
    expect(connectInfoFor("composio.hubspot", "HubSpot")).toEqual({ connect: "composio", label: "HubSpot", settingsAnchor: null });
    expect(connectInfoFor("composio.Bad Slug")).toBeNull();
    expect(connectInfoFor("composio.stripe")).toBeNull();
    expect(connectInfoFor("composio.linear")).toBeNull();
    expect(parseConnectorRequest({
      kind: "connector_request", v: 1, request_id: "r", slug: "composio.notion", label: "Notion",
      connect: "composio", reason: "", origin: "model", mode: "connect", run_id: "x", created_at: "2026-09-25",
    })?.connect).toBe("composio");
  });

  it("Instagram rows on the Composio rail satisfy the social slug; YouTube is Composio-only", () => {
    expect(satisfyingSlugs("instagram_social")).toEqual(["instagram_social", "composio.instagram"]);
    expect(satisfyingSlugs("composio.youtube")).toEqual(["composio.youtube"]);
    expect(linkedWithAliases(["composio.tiktok_ads"]).has("tiktok_ads")).toBe(true);
    expect(linkedWithAliases(["tiktok"]).has("tiktok_ads")).toBe(false);
  });

  it("settings links use the #connector- hash Settings recognises", () => {
    expect(connectorSettingsPath(CONNECTOR_CONNECT.stripe)).toBe(
      "/workspace?tab=settings#connector-stripe",
    );
    expect(connectorSettingsPath(CONNECTOR_CONNECT.apple_ads)).toBe(
      "/workspace?tab=settings#connector-apple_ads",
    );
    expect(connectorSettingsPath(CONNECTOR_CONNECT["composio.gmail"])).toBe(
      "/workspace?tab=settings#integration",
    );
  });

  it("every settings anchor is a descriptor slug with a Settings tile, so the link lands on that tile", () => {
    const tileSlugs = new Set(CONNECTOR_DESCRIPTORS.filter((d) => d.settingsTile).map((d) => d.slug));
    const strays = Object.entries(CONNECTOR_CONNECT)
      .filter(([, i]) => i.settingsAnchor !== null && !tileSlugs.has(i.settingsAnchor))
      .map(([slug, i]) => `${slug} -> #connector-${i.settingsAnchor}`);
    expect(strays).toEqual([]);
    expect(connectorSettingsPath(CONNECTOR_CONNECT.email)).toBe("/workspace?tab=settings#connector-email");
  });

  it("envelope parser rejects a malformed payload", () => {
    expect(parseConnectorRequest({ kind: "connector_request", v: 1 })).toBeNull();
  });
});

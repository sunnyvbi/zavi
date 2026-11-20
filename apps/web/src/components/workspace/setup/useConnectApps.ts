"use client";

import { useRef, useState } from "react";
import { connectInfoFor, sendgridCampaignReady } from "@zavi/shared";
import { findConnectorRow, launchConnect } from "@/app/connectors/connectStrategies";
import { useComposioApps } from "@/app/connectors/ComposioApps";
import { useWorkspace } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { showConnectorError } from "../settings/connectorErrorDialog";
import { connectAppChoices, CONNECT_CATALOG_PAGE, type SetupApp } from "./connectAppsModel";
import { connectedNames, filterConnectors, isConnected } from "./setupConnectors";
import { useSetupConnections } from "./useSetupConnections";
import { useSetupNavigation } from "./useSetupNavigation";
import type { AppAvailability } from "./ConnectAppRow";

export function useConnectApps() {
  const { role } = useWorkspace();
  const navigation = useSetupNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState(CONNECT_CATALOG_PAGE);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const connections = useSetupConnections(!!navigation.open || busy !== null);
  const catalog = useComposioApps();
  const choices = connectAppChoices(navigation.query, connections.rows, catalog.toolkits ?? [], limit);
  const names = connectedNames(connections.rows.filter((row) => row.slug !== "email" || sendgridCampaignReady(row.scopes ?? null)), catalog.toolkits ?? []);
  const selected = [...filterConnectors("All", ""), ...filterConnectors("Messaging", "")]
    .find((app) => app.slug === navigation.open && app.via !== "launch");
  const close = () => {
    navigation.setOpen(null);
    trigger.current?.focus();
    if (!trigger.current?.isConnected) document.getElementById("setup-app-search")?.focus();
    void connections.refresh();
  };
  const connect = async (app: SetupApp, button: HTMLButtonElement) => {
    if (busy || connections.loading || isMember(role ?? null)) return;
    navigation.beginConnect();
    if (app.via !== "launch") {
      trigger.current = button;
      if (navigation.open === app.slug) close();
      else navigation.setOpen(app.slug);
      return;
    }
    const info = connectInfoFor(app.slug, app.name);
    if (!info) return;
    setBusy(app.slug);
    try {
      await launchConnect(app.slug, info);
      await connections.refresh();
    } catch (error) {
      showConnectorError({ title: `Couldn't connect ${app.name}`, message: error instanceof Error ? error.message : "Try again." });
    } finally {
      setBusy(null);
    }
  };
  const availability = (app: SetupApp): AppAvailability => {
    if (!app.slug.startsWith("composio.")) return "ready";
    if (catalog.toolkits === null) return "loading";
    const slug = app.slug.slice("composio.".length);
    const entry = catalog.toolkits.find((toolkit) => toolkit.slug === slug);
    if (!entry) return catalog.failed ? "unchecked" : "unavailable";
    if (entry.connectable !== false) return "ready";
    return catalog.requested.has(slug) ? "requested" : "requestable";
  };
  const needsMore = (slug: string) => slug === "email" && isConnected(connections.rows, slug) && !sendgridCampaignReady(findConnectorRow(connections.rows, slug)?.scopes ?? null);
  return {
    ...choices, ...connections, ...navigation,
    selected,
    names,
    busy: busy ?? (catalog.busy ? `composio.${catalog.busy}` : null),
    readOnly: isMember(role ?? null),
    close,
    connect,
    availability,
    needsMore,
    isConnected: (slug: string) => isConnected(connections.rows, slug) && !needsMore(slug),
    showMore: () => setLimit((count) => count + CONNECT_CATALOG_PAGE),
    request: (app: SetupApp) => catalog.request(app.slug.slice("composio.".length)),
  };
}

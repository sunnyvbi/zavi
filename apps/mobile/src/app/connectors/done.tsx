import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { connectInfoFor } from "@zavi/shared";
import { useRefreshConnections } from "../../features/connectors/useConnections";
import { readConnectResult } from "../../features/connectors/connectResult";
import { ALL_SETUP_CONNECTORS } from "../../features/setup/connectors";
import { showDialog } from "../../components/DialogHost";
import { LoadingScreen } from "../../components/LoadingScreen";
import { track } from "../../lib/analytics";

function labelFor(slug: string): string {
  const tile = ALL_SETUP_CONNECTORS.find((c) => c.slug === slug);
  if (tile) return tile.name;
  const info = connectInfoFor(slug);
  if (info) return info.label;
  const bare = slug.replace(/^(composio|pipedream)\./, "").replace(/_/g, " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export default function ConnectDone() {
  const router = useRouter();
  const refresh = useRefreshConnections();
  const params = useLocalSearchParams<Record<string, string>>();

  useEffect(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === "string") q.set(k, v);
    const result = readConnectResult(q, labelFor);
    void refresh();
    if (router.canGoBack()) router.back();
    else router.replace("/");
    if (result.kind === "connected") {
      track("connector_connected", { slug: result.slug });
    }
    if (result.kind === "failed") {
      track("connector_connect_failed", { slug: result.slug });
      void showDialog({ icon: "alertCircle", title: "Couldn't connect", message: result.message, confirmLabel: "OK" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <LoadingScreen />;
}

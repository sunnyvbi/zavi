import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { connectInfoFor } from "@zavi/shared";
import { completeConnect } from "../../features/connectors/api";
import { finishConnect, readFinishRequest } from "../../features/connectors/finishConnect";
import { useRefreshConnections } from "../../features/connectors/useConnections";
import { showDialog } from "../../components/DialogHost";
import { LoadingScreen } from "../../components/LoadingScreen";
import { track } from "../../lib/analytics";

const labelFor = (slug: string) => connectInfoFor(slug)?.label ?? slug;

export default function ConnectFinish() {
  const router = useRouter();
  const refresh = useRefreshConnections();
  const params = useLocalSearchParams<Record<string, string>>();

  useEffect(() => {
    void (async () => {
      const request = readFinishRequest(params);
      const result = request
        ? await finishConnect(request, completeConnect, labelFor)
        : ({ kind: "failed", slug: null, message: "That connection link isn't complete. Tap Connect and try again." } as const);
      void refresh();
      if (router.canGoBack()) router.back();
      else router.replace("/");
      if (result.kind === "connected") track("connector_connected", { slug: result.slug });
      if (result.kind === "failed") {
        track("connector_connect_failed", { slug: result.slug });
        void showDialog({ icon: "alertCircle", title: "Couldn't connect", message: result.message, confirmLabel: "OK" });
      }
    })();
  }, []);

  return <LoadingScreen />;
}

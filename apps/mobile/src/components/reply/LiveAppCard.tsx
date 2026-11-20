import { useQuery } from "@tanstack/react-query";
import { StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useRunProgress } from "../../features/agents/hooks";
import { hostLabel, panelCheckedProductBuilds, readShippedAppUrl } from "../../features/agents/previews";
import { fetchBuildStatus } from "../../features/agents/replyApi";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { Card, CardButton, makeUi } from "./ui";

export function LiveAppCard({ runId }: { runId: string }) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const tenant = useActiveTenant();
  const { data: progress } = useRunProgress(runId);
  const checked = panelCheckedProductBuilds(progress);
  const { data: url } = useQuery({
    queryKey: ["live-app-url", tenant],
    queryFn: async () => readShippedAppUrl((await fetchBuildStatus())?.preview),
    enabled: checked,
    staleTime: 60_000,
    retry: false,
  });

  if (!checked || !url) return null;
  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.dot} />
        <View style={styles.text}>
          <Text style={ui.title} numberOfLines={1}>
            Your app is live
          </Text>
          <Text style={ui.small} numberOfLines={1}>
            {hostLabel(url)}
          </Text>
        </View>
      </View>
      <View style={ui.row}>
        <CardButton label="Open" onPress={() => void WebBrowser.openBrowserAsync(url).catch(() => {})} />
      </View>
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  text: { flex: 1, minWidth: 0 },
});

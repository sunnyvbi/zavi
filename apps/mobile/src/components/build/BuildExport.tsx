import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useQueryClient } from "@tanstack/react-query";
import { ZaviTextField } from "../ZaviTextField";
import { CardButton } from "../reply/ui";
import { ConnectControl } from "../connect/ConnectControl";
import { ErrorCard } from "../ErrorCard";
import { runExport } from "../../features/build/api";
import { buildKeys, useExportRecord } from "../../features/build/hooks";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { exportDoneLine, exportErrorView, type ExportErrorView } from "../../features/build/logic";
import { track } from "../../lib/analytics";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const REPO_NAME_MAX = 90;

export function BuildExport({ repoName, runId = null }: { repoName: string | null; runId?: string | null }) {
  const styles = useStyles(makeStyles);
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const recordQ = useExportRecord(true, runId);
  const [dest, setDest] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ExportErrorView | null>(null);
  const inFlight = useRef(false);

  const last = recordQ.data ?? null;

  async function onExport() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    setDone(null);
    try {
      const result = await runExport(dest, runId);
      track("build_exported");
      setDone(exportDoneLine(result));
      void qc.invalidateQueries({ queryKey: buildKeys.export(tenant) });
    } catch (e) {
      setError(exportErrorView(e));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.sub}>
        {last
          ? "You own a copy in your GitHub. Export again any time to send your latest changes."
          : "Copy this app into your own GitHub. You keep full ownership of the repo."}
      </Text>
      {last && !done ? (
        <Text
          style={styles.link}
          onPress={() => void WebBrowser.openBrowserAsync(last.url).catch(() => {})}
          accessibilityRole="link"
        >
          Exported to {last.full_name}
        </Text>
      ) : null}

      <ZaviTextField
        maxLines={1}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        value={dest}
        onChangeText={setDest}
        maxLength={REPO_NAME_MAX}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={repoName ?? "Leave blank to use your build's name"}
        editable={!running}
        accessibilityLabel="Repo name (optional)"
      />
      <View style={styles.row}>
        <CardButton
          label={running ? "Exporting" : last ? "Export again" : "Export to my GitHub"}
          busy={running}
          onPress={() => void onExport()}
        />
      </View>

      {done ? (
        <Text style={styles.ok} accessibilityLiveRegion="polite">
          {done}
        </Text>
      ) : null}
      {error ? (
        <View style={styles.errorWrap}>
          <ErrorCard message={error.text} style={styles.errorCard} />
          {error.needsGithub ? (
            <ConnectControl slug="github" label="GitHub" onAttempted={() => setError(null)} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const text = { includeFontPadding: false } as const;

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: space.md },
  sub: { ...text, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, color: colors.muted },
  link: { ...text, fontFamily: font.family.semi, fontSize: font.size.sm, color: colors.ink, textDecorationLine: "underline" },
  row: { flexDirection: "row" },
  ok: { ...text, fontFamily: font.family.medium, fontSize: font.size.sm, lineHeight: 18, color: colors.green },
  errorWrap: { gap: space.sm },
  errorCard: { marginTop: 0 },
});

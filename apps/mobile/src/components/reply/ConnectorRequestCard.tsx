import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ConnectorRequest } from "@zavi/shared";
import { ApiFetchError } from "../../lib/api";
import { useOpenBillingScreen } from "../../features/agents/billingLink";
import { continueConnectorRequest } from "../../features/connectors/api";
import { satisfactionKey } from "../../features/connectors/connectPlan";
import { useConnectorRows } from "../../features/connectors/useConnectorRows";
import { useCanManage } from "../../features/settings/api";
import { space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ConnectControl } from "../connect/ConnectControl";
import { Icon } from "../Icon";
import { Card, CardButton, ErrorLine, makeUi } from "./ui";

type Phase = "pending" | "connected" | "working";

export function ConnectorRequestCard({
  request,
  onRunStarted,
  busy = false,
  claimRun,
  releaseRun,
}: {
  request: ConnectorRequest;
  onRunStarted?: (runId: string) => void;
  busy?: boolean;
  claimRun?: () => boolean;
  releaseRun?: () => void;
}) {
  const ui = useStyles(makeUi);
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const verb = request.mode === "reconnect" ? "Reconnect" : "Connect";
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("pending");
  const [continuing, setContinuing] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const [outOfCredits, setOutOfCredits] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = useCanManage();
  const openBillingScreen = useOpenBillingScreen();
  const { rows, refresh } = useConnectorRows(!dismissed);

  const [heldKey, setHeldKey] = useState<string | null>(null);
  const key = rows ? satisfactionKey(rows, request) : null;
  useEffect(() => {
    if (key !== null && key !== heldKey) setPhase((p) => (p === "pending" ? "connected" : p));
  }, [key, heldKey]);

  async function continueRun() {
    if (continuing || busy) return;
    if (claimRun && !claimRun()) return;
    setContinuing(true);
    setError(null);
    setNotYet(false);
    setOutOfCredits(false);
    try {
      const res = await continueConnectorRequest(request.run_id);
      setPhase("working");
      if (res?.run_id) onRunStarted?.(res.run_id);
    } catch (e) {
      setContinuing(false);
      const status = e instanceof ApiFetchError ? e.status : 0;
      if (status === 409) {
        setHeldKey(key);
        setNotYet(true);
        setPhase("pending");
      } else if (status === 402) {
        setOutOfCredits(true);
      } else {
        setError("Something went wrong.");
      }
    } finally {
      releaseRun?.();
    }
  }

  if (dismissed) return null;

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={ui.title}>
            {verb} {request.label}
          </Text>
          {request.reason ? <Text style={ui.muted}>{request.reason}</Text> : null}
        </View>
        <Pressable
          onPress={() => setDismissed(true)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
        >
          <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
        </Pressable>
      </View>

      {phase === "pending" ? (
        <ConnectControl
          slug={request.slug}
          label={request.label}
          mode={request.mode}
          fallback={{ connect: request.connect, label: request.label, settingsAnchor: null }}
          onAttempted={refresh}
        />
      ) : null}
      {phase === "connected" ? (
        <View style={ui.row}>
          <Text style={ui.body}>Connected</Text>
          <CardButton label="Continue" busy={continuing} disabled={busy} onPress={() => void continueRun()} />
        </View>
      ) : null}
      {phase === "working" ? <Text style={ui.muted}>Working on it</Text> : null}
      {notYet ? <Text style={ui.muted}>Not connected yet</Text> : null}

      {outOfCredits ? (
        <View style={styles.credits}>
          <Text style={styles.alert} accessibilityRole="alert">
            {canManage
              ? "You're out of credits."
              : "You're out of credits. Ask your workspace owner to add credits."}
          </Text>
          {canManage && openBillingScreen ? (
            <View style={ui.row}>
              <CardButton label="Buy credits" variant="secondary" onPress={openBillingScreen} />
            </View>
          ) : null}
        </View>
      ) : null}

      <ErrorLine message={error} />
    </Card>
  );
}

const makeStyles = (colors: Colors) => {
  const ui = makeUi(colors);
  return StyleSheet.create({
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    headText: { flex: 1, gap: 4 },
    credits: { gap: space.sm },
    alert: { ...ui.error },
  });
};

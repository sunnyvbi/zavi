import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { startBuildConfirm } from "../../features/agents/api";
import { buildEstimateLine, buildStartOutcome, type BuildConfirm } from "../../features/agents/replyCards";
import { useOpenBillingScreen } from "../../features/agents/billingLink";
import { failureReason, track } from "../../lib/analytics";
import { font, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { UnderlinedText } from "../UnderlinedText";
import { Card, CardButton, ErrorLine, makeUi } from "./ui";

type Phase = "pending" | "starting" | "started" | "out_of_credits" | "expired" | "failed";

export function BuildConfirmCard({
  confirm,
  threadId,
  onRunStarted,
  busy = false,
  claimRun,
  releaseRun,
  onPrefill,
}: {
  confirm: BuildConfirm;
  threadId?: string;
  onRunStarted?: (runId: string) => void;
  busy?: boolean;
  claimRun?: () => boolean;
  releaseRun?: () => void;
  onPrefill?: (text: string, placeholderHint?: string) => void;
}) {
  const ui = useStyles(makeUi);
  const styles = useStyles(makeStyles);
  const openBillingScreen = useOpenBillingScreen();
  const [phase, setPhase] = useState<Phase>(() =>
    confirm.status === "started"
      ? "started"
      : Date.parse(confirm.expires_at) < Date.now()
        ? "expired"
        : "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const replaced = confirm.status === "replaced" && phase !== "started";

  useEffect(() => {
    if (confirm.status === "started") {
      setPhase("started");
      return;
    }
    if (Date.parse(confirm.expires_at) < Date.now()) {
      setPhase((p) => (p === "started" ? p : "expired"));
    }
  }, [confirm.status, confirm.expires_at]);

  async function start() {
    if (replaced || busy || !threadId) return;
    if (phase !== "pending" && phase !== "out_of_credits" && phase !== "failed") return;
    if (Date.parse(confirm.expires_at) < Date.now()) {
      setPhase("expired");
      return;
    }
    if (claimRun && !claimRun()) return;
    setPhase("starting");
    setError(null);
    try {
      const outcome = buildStartOutcome(await startBuildConfirm(threadId, confirm.nonce));
      if (outcome.phase === "failed") {
        track("build_start_failed", { source: "chat_card", reason: failureReason(null) });
        setError(outcome.error);
      }
      setPhase(outcome.phase);
      if (outcome.phase === "started" && outcome.runId) {
        track("build_started", { source: "chat_card" });
        onRunStarted?.(outcome.runId);
      }
    } catch (e) {
      track("build_start_failed", { source: "chat_card", reason: failureReason(e) });
      setError("Something went wrong starting the build.");
      setPhase("failed");
    } finally {
      releaseRun?.();
    }
  }

  const startable = !replaced && (phase === "pending" || phase === "out_of_credits" || phase === "failed");

  return (
    <Card>
      <Text style={ui.title}>Large build</Text>
      <Text style={ui.muted}>
        {buildEstimateLine(confirm)}{" "}
        {replaced ? "This build was not started." : "Nothing runs until you start it."}
      </Text>

      <View style={ui.row}>
        {replaced ? <Text style={ui.muted}>Replaced by your new request.</Text> : null}
        {startable ? (
          <>
            <CardButton
              label="Start build"
              disabled={busy || !threadId}
              onPress={() => void start()}
            />
            <CardButton label="Change scope" variant="secondary" onPress={() => onPrefill?.("")} />
          </>
        ) : null}
        {!replaced && phase === "starting" ? (
          <CardButton label="Starting…" busy onPress={() => {}} />
        ) : null}
        {phase === "started" ? (
          <Text style={styles.status}>Build started. Progress will show here.</Text>
        ) : null}
        {!replaced && phase === "expired" ? (
          <Text style={ui.muted}>This build request was replaced or expired. Ask me again to start it.</Text>
        ) : null}
      </View>

      {!replaced && phase === "out_of_credits" ? (
        <View style={styles.alertRow} accessibilityRole="alert">
          <Text style={styles.alert}>Not enough credits for this build.</Text>
          {openBillingScreen ? (
            <>
              <Text style={styles.alert}> </Text>
              <Pressable onPress={openBillingScreen} accessibilityRole="button" accessibilityLabel="Top up">
                <UnderlinedText style={styles.alertLink}>Top up</UnderlinedText>
              </Pressable>
              <Text style={styles.alert}>, then start it again.</Text>
            </>
          ) : null}
        </View>
      ) : null}

      {!replaced && phase === "failed" ? <ErrorLine message={error} /> : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  status: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.medium, color: colors.ink },
  alertRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", rowGap: 2 },
  alert: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.medium, color: colors.red },
  alertLink: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.semi, color: colors.ink },
});

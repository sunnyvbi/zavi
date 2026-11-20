import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { StatusSpinner } from "../channels/ChannelStates";
import { CardButton } from "../reply/ui";
import { CreditWallNotice } from "../CreditWallNotice";
import { ErrorCard } from "../ErrorCard";
import { isCreditFailure, type BuildStep, type BuildView } from "../../features/build/logic";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function BuildProgress({
  title,
  view,
  steps,
  stopping,
  continuing,
  onOpen,
  onStop,
  onContinue,
  onRetry,
  onNewBuild,
  actionError,
}: {
  title: string;
  view: BuildView;
  steps: BuildStep[];
  stopping: boolean;
  continuing: boolean;
  onOpen: () => void;
  onStop: () => void;
  onContinue: () => void;
  onRetry: () => void;
  onNewBuild: () => void;
  actionError: string | null;
}) {
  const styles = useStyles(makeStyles);
  const [wallDismissed, setWallDismissed] = useState(false);
  const creditFailure = isCreditFailure(view.failure);
  const outOfCredits = creditFailure && !wallDismissed;
  const canRetry = view.status === "stopped" && !view.superseded && !creditFailure;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.statusRow} accessibilityLiveRegion="polite">
        {view.status === "building" ? <StatusSpinner size={12} /> : <StatusDot status={view.status} />}
        <Text style={styles.status}>{view.statusLabel}</Text>
        {view.spend ? <Text style={styles.meta}>· {view.spend}</Text> : null}
      </View>

      <View style={styles.steps}>
        {steps.map((s) => (
          <View key={s.key} style={styles.step} accessibilityLabel={`${s.label}, ${stepWord(s.state)}`}>
            <StepGlyph state={s.state} />
            <Text style={[styles.stepText, s.state === "pending" && styles.stepPending]}>{s.label}</Text>
          </View>
        ))}
      </View>

      {view.superseded ? (
        <Text style={styles.note}>A newer build replaced this app. Open that build to make changes.</Text>
      ) : null}
      {view.status === "paused" && !view.superseded && !creditFailure ? (
        <Text style={styles.note}>Your build paused. Everything before it is saved. Continue to try this step again.</Text>
      ) : null}
      {outOfCredits ? (
        <View style={styles.wall}>
          <CreditWallNotice wall={{ kind: "credits", message: view.failure ?? "" }} onDismiss={() => setWallDismissed(true)} />
        </View>
      ) : view.failure ? (
        <ErrorCard message={view.failure} style={styles.errorCard} />
      ) : null}

      <View style={styles.actions}>
        {view.openUrl && view.openLabel ? <CardButton label={view.openLabel} onPress={onOpen} /> : null}
        {view.canContinue ? (
          <CardButton
            label={continuing ? "Continuing" : "Continue build"}
            busy={continuing}
            onPress={onContinue}
            variant={view.openUrl ? "secondary" : "primary"}
          />
        ) : null}
        {canRetry ? (
          <>
            <CardButton label="Try again with the same idea" onPress={onRetry} variant={view.openUrl ? "secondary" : "primary"} />
            <CardButton label="Start a new build" onPress={onNewBuild} variant="secondary" />
          </>
        ) : null}
        {view.canCancel ? (
          <CardButton label={stopping ? "Stopping" : "Stop build"} busy={stopping} onPress={onStop} variant="secondary" />
        ) : null}
      </View>
      {actionError ? <ErrorCard message={actionError} style={styles.errorCard} /> : null}
    </View>
  );
}

function stepWord(state: BuildStep["state"]): string {
  return state === "done" ? "done" : state === "active" ? "in progress" : state === "failed" ? "stopped" : "not started";
}

function StepGlyph({ state }: { state: BuildStep["state"] }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (state === "active") return <View style={styles.glyph}><StatusSpinner size={12} /></View>;
  if (state === "done") return <View style={styles.glyph}><Icon name="check" size={16} color={colors.green} /></View>;
  if (state === "failed") return <View style={styles.glyph}><Icon name="close" size={16} color={colors.red} /></View>;
  return (
    <View style={styles.glyph}>
      <View style={styles.pendingDot} />
    </View>
  );
}

function StatusDot({ status }: { status: BuildView["status"] }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const color = status === "ready" ? colors.green : status === "paused" ? colors.amber : colors.red;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    padding: space.lg,
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
  },
  title: {
    fontFamily: font.family.semi,
    fontSize: font.size.lg,
    lineHeight: 22,
    includeFontPadding: false,
    color: colors.ink,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  status: { fontFamily: font.family.semi, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  meta: { fontFamily: font.family.regular, fontSize: font.size.sm, includeFontPadding: false, color: colors.muted },
  dot: { width: 8, height: 8, borderRadius: 4 },
  steps: { gap: space.sm },
  step: { flexDirection: "row", alignItems: "center", gap: space.sm },
  glyph: { width: 18, alignItems: "center", justifyContent: "center" },
  pendingDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: colors.line },
  stepText: { fontFamily: font.family.regular, fontSize: font.size.base, includeFontPadding: false, color: colors.ink },
  stepPending: { color: colors.muted },
  note: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  errorCard: { marginTop: 0 },
  wall: { marginHorizontal: -space.md, marginTop: -space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});

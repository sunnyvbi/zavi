import { StyleSheet, Text, View } from "react-native";
import type { PausedModel } from "../../features/agents/replyCards";
import { useOpenBillingScreen } from "../../features/agents/billingLink";
import { useCanManage } from "../../features/settings/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { Card, CardButton, makeUi } from "./ui";

export function PausedCard({ model, fallbackName }: { model: PausedModel; fallbackName: string }) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors } = useTheme();
  const canManage = useCanManage();
  const openBillingScreen = useOpenBillingScreen();
  const who = model.agentName ?? fallbackName;

  return (
    <Card style={styles.card}>
      <View>
        <Text style={ui.title}>
          {model.pausedStep
            ? `Paused: out of credits at step ${model.pausedStep} of ${model.totalSteps}`
            : "Paused: out of credits"}
        </Text>
        <Text style={[ui.muted, styles.sub]}>
          Your work is saved. Add credits and {who} resumes from exactly here, without re-running the
          finished steps.
        </Text>
      </View>

      <View style={styles.steps}>
        {model.steps.map((s, i) => (
          <View key={`${i}-${s.label}`} style={styles.step}>
            <View
              style={[
                styles.badge,
                s.status === "done" && styles.badgeDone,
                s.status === "paused" && styles.badgePaused,
              ]}
            >
              {s.status === "done" ? <Icon name="check" size={14} color={colors.onAccent} strokeWidth={2.2} /> : null}
              {s.status === "paused" ? <Text style={styles.pauseGlyph}>II</Text> : null}
            </View>
            <Text
              style={[
                styles.stepLabel,
                s.status === "paused" && styles.stepPaused,
                s.status === "pending" && styles.stepPending,
              ]}
            >
              {s.label}
            </Text>
            {s.status === "paused" && typeof s.creditsNeeded === "number" ? (
              <Text style={styles.needs}>
                needs ~{Math.max(0, Math.floor(s.creditsNeeded)).toLocaleString("en-US")}
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      {canManage ? (
        openBillingScreen ? (
          <View style={ui.row}>
            <CardButton label="Buy credits" onPress={openBillingScreen} />
          </View>
        ) : null
      ) : (
        <Text style={ui.small}>Ask your workspace owner to add credits.</Text>
      )}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: space.sm },
  sub: { marginTop: 4 },
  steps: { gap: space.md },
  step: { flexDirection: "row", alignItems: "center", gap: space.md },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDone: { backgroundColor: colors.greenFill, borderColor: colors.greenFill },
  badgePaused: { backgroundColor: colors.amberFill, borderColor: colors.amberFill },
  pauseGlyph: { fontSize: 10, fontFamily: font.family.bold, color: colors.onAccent },
  stepLabel: { flex: 1, fontSize: font.size.base, fontFamily: font.family.medium, color: colors.ink },
  stepPaused: { fontFamily: font.family.semi },
  stepPending: { color: colors.textSecondary },
  needs: { fontSize: font.size.md, fontFamily: font.family.medium, color: colors.amber },
});

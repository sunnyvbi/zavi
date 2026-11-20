import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { UnderlinedText } from "./UnderlinedText";
import { friendlyError } from "./ErrorCard";
import { useOpenBillingScreen } from "../features/agents/billingLink";
import { creditWallFromError, creditWallView } from "../features/agents/creditWall";
import { useCanManage } from "../features/settings/api";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export function GoDeeperButton({
  busy,
  failure,
  onPress,
}: {
  busy: boolean;
  failure: unknown;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const canManageBilling = useCanManage();
  const openBillingScreen = useOpenBillingScreen();
  const wall = failure != null ? creditWallFromError(failure) : null;
  const view = wall ? creditWallView(wall, { canManageBilling }) : null;
  const errorText =
    failure == null ? null : view ? view.text : friendlyError(failure, "Couldn't start a deeper run.");

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        disabled={busy}
        style={({ pressed }) => [styles.chip, (pressed || busy) && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        accessibilityLabel="Quick answer. Go deeper with a stronger model"
      >
        {busy ? <ActivityIndicator size="small" color={colors.muted} /> : null}
        <Text style={styles.chipText}>
          {"Quick answer · "}
          <Text style={styles.chipAction}>{busy ? "Going deeper…" : "Go deeper"}</Text>
        </Text>
      </Pressable>
      <Text style={styles.note}>This came from the fast model. Going deeper takes longer and costs more credits.</Text>
      {errorText ? (
        <View style={styles.errorRow}>
          <Text style={styles.error} accessibilityRole="alert">
            {errorText}
          </Text>
          {view?.action && openBillingScreen ? (
            <Pressable onPress={openBillingScreen} hitSlop={8} accessibilityRole="button">
              <UnderlinedText style={styles.errorAction}>{view.action}</UnderlinedText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.sm, alignItems: "flex-start", gap: space.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm - 2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pressed: { opacity: 0.6 },
  chipText: { fontFamily: font.family.regular, fontSize: 12.5, includeFontPadding: false, color: colors.muted },
  chipAction: { fontFamily: font.family.semi, color: colors.ink },
  note: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 17, color: colors.muted },
  errorRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm, rowGap: 2 },
  error: { fontFamily: font.family.medium, fontSize: font.size.sm, lineHeight: 17, color: colors.red },
  errorAction: { fontFamily: font.family.semi, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
});

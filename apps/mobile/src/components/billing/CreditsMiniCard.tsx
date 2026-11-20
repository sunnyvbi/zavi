import { Pressable, StyleSheet, Text, View } from "react-native";
import { openBilling } from "../../features/agents/billingLink";
import { effectiveTier, type Credits } from "../../features/settings/api";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { Badge } from "../settings/SettingsUI";
import { n, planName, shortDate } from "./CurrentPlanCard";
import { ExternalIcon } from "./LowCreditsCard";

export function CreditsMiniCard({
  c,
  canBuy,
  onOpenBilling,
}: {
  c: Credits;
  canBuy: boolean;
  onOpenBilling?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tier = effectiveTier(c);
  const allowance = c.included_allowance + c.daily_allowance;
  const remaining = c.included_remaining + c.daily_remaining;
  const pct =
    allowance > 0 ? Math.min(100, Math.max(0, Math.round((remaining / allowance) * 100))) : 0;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.titleGroup}>
          <Icon name="wallet" size={17} color={colors.wire.mute} strokeWidth={1.8} />
          <Text style={styles.title}>Credits</Text>
          <Badge tone={c.soft_warn ? "amber" : "neutral"}>{c.soft_warn ? "Low" : planName(tier)}</Badge>
        </View>
        <Text style={styles.balance}>
          {c.unlimited ? "Unlimited" : `${n(c.effective_available_display)} left`}
        </Text>
      </View>

      {c.unlimited ? null : (
        <View style={styles.barWrap}>
          <View
            style={styles.track}
            accessibilityRole="progressbar"
            accessibilityLabel={`Credits left, ${n(remaining)} of ${n(allowance)}`}
            accessibilityValue={{ min: 0, max: 100, now: pct }}
          >
            <View style={[styles.fill, { width: `${pct}%`, backgroundColor: c.soft_warn ? colors.status.amberDot : colors.wire.ink }]} />
          </View>
        </View>
      )}

      <Text style={styles.caption}>
        {c.unlimited
          ? "This workspace is not limited by credits."
          : tier !== "free"
            ? `Resets ${shortDate(c.period_end) ?? "monthly"}`
            : "1,000 free credits reset every day"}
      </Text>

      {canBuy || onOpenBilling ? (
        <View style={styles.buttons}>
          {canBuy ? (
            <Pressable
              style={({ pressed }) => [styles.button, styles.buyButton, pressed && styles.pressed]}
              onPress={openBilling}
              accessibilityRole="button"
            >
              <Text style={styles.buyText}>Buy credits</Text>
              <ExternalIcon color={colors.onInk} strokeWidth={2} />
            </Pressable>
          ) : null}
          {onOpenBilling ? (
            <Pressable
              style={({ pressed }) => [styles.button, styles.usageButton, pressed && styles.pressed]}
              onPress={onOpenBilling}
              accessibilityRole="button"
            >
              <Text style={styles.usageText}>Plans and usage</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.wire.line, borderRadius: 16, padding: 16, backgroundColor: colors.surfaceRaised },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  titleGroup: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 1 },
  title: { fontFamily: font.family.semi, includeFontPadding: false, fontSize: 15, color: colors.wire.ink },
  balance: {
    flexShrink: 0,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 14,
    color: colors.wire.mute,
    fontVariant: ["tabular-nums"],
  },
  barWrap: { marginTop: 14 },
  track: { height: 8, borderRadius: 999, backgroundColor: colors.wire.tint, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  caption: {
    marginTop: 12,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: 13,
    color: colors.wire.mute,
  },
  buttons: { marginTop: 16, flexDirection: "row", gap: 8 },
  button: {
    flex: 1,
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
  },
  buyButton: { backgroundColor: colors.wire.ink },
  usageButton: { borderWidth: 1, borderColor: colors.wire.line, backgroundColor: "transparent" },
  buyText: { fontFamily: font.family.semi, includeFontPadding: false, fontSize: 14, color: colors.onInk },
  usageText: { fontFamily: font.family.semi, includeFontPadding: false, fontSize: 14, color: colors.wire.text },
  pressed: { opacity: 0.85 },
});

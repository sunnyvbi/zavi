import { Pressable, StyleSheet, Text, View } from "react-native";
import { planName, waitingLabel, type ListRow } from "../../features/channels/channelList";
import { font, radius, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ChannelIcon, ChannelLogo } from "./ChannelGlyph";
import { StatusSpinner } from "./ChannelStates";

export function ChannelRow({ row, divider, onPress }: { row: ListRow; divider: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const plan = planName(row.planTier);
  const lockText = row.comingSoon
    ? `Coming soon${row.waiting > 0 ? ` · ${waitingLabel(row.waiting)} waiting` : ""}`
    : plan
      ? `Needs ${plan} plan`
      : null;
  const label = [row.name, lockText, row.status?.text].filter(Boolean).join(", ");
  return (
    <Pressable
      style={({ pressed }) => [styles.row, divider && styles.divider, pressed && !row.comingSoon && styles.pressed]}
      onPress={onPress}
      disabled={row.comingSoon}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: row.comingSoon }}
    >
      <View style={row.comingSoon && styles.dim}>
        <ChannelLogo slug={row.slug} size={38} />
      </View>
      <View style={[styles.info, row.comingSoon && styles.dim]}>
        <View style={styles.nameLine}>
          <Text style={styles.name} numberOfLines={1}>
            {row.name}
          </Text>
          {row.unseen > 0 && !lockText ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{waitingLabel(row.unseen)}</Text>
            </View>
          ) : null}
          {lockText ? (
            <View style={styles.pill}>
              <ChannelIcon name="lock" size={10} color={colors.muted} />
              <Text style={styles.pillText} numberOfLines={1}>
                {lockText}
              </Text>
            </View>
          ) : null}
        </View>
        {row.status && !row.comingSoon ? (
          <View style={styles.statusLine}>
            {row.status.tone === "working" ? <StatusSpinner /> : null}
            {row.status.tone === "new" ? <View style={styles.dot} /> : null}
            <Text
              style={[styles.status, row.status.tone === "new" && styles.statusNew]}
              numberOfLines={1}
            >
              {row.status.text}
            </Text>
          </View>
        ) : null}
      </View>
      {row.comingSoon ? null : <ChannelIcon name="chevronRight" size={16} color={colors.muted} />}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    paddingVertical: 14,
    paddingHorizontal: 14,
    backgroundColor: colors.panel,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { backgroundColor: colors.soft },
  dim: { opacity: 0.5 },
  info: { flex: 1, minWidth: 0, gap: 2 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
  },
  badgeText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11, color: colors.onInk },
  pill: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.soft,
  },
  pillText: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.medium, fontSize: 10, color: colors.muted },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  status: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.regular, fontSize: 13, color: colors.textSecondary },
  statusNew: { fontFamily: font.family.semi, color: colors.green },
});

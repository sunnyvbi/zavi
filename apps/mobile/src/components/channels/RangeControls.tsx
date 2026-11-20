import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "../Icon";
import { SpinningIcon } from "../SpinningIcon";
import { OptionSheet } from "../OptionSheet";
import type { DashRange } from "../../features/channels/dashboardRanges";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function RangeControls({
  label,
  ranges,
  value,
  pickable,
  account,
  onPick,
  onRefresh,
}: {
  label: string;
  ranges: readonly DashRange[];
  value: string;
  pickable: boolean;
  account?: { name: string | null; sub: string } | null;
  onPick: (id: string) => void;
  onRefresh: () => Promise<unknown>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [picking, setPicking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
    } finally {
      setRefreshing(false);
    }
  };

  const pill = (
    <>
      <Icon name="calendarList" size={16} color={colors.muted} />
      <Text style={styles.pillText} numberOfLines={1}>
        {label}
      </Text>
      {pickable ? <Icon name="chevronDown" size={14} color={colors.muted} /> : null}
    </>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {pickable ? (
          <Pressable
            style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
            onPress={() => setPicking(true)}
            accessibilityRole="button"
            accessibilityLabel={`Date range: ${label}`}
          >
            {pill}
          </Pressable>
        ) : (
          <View style={styles.pill} accessibilityLabel={`Date range: ${label}`}>
            {pill}
          </View>
        )}
        <Pressable
          style={({ pressed }) => [styles.refresh, pressed && styles.pressed, refreshing && styles.dim]}
          onPress={() => void refresh()}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? "Reading" : "Refresh"}
        >
          <SpinningIcon name="refresh" size={17} color={colors.ink} spinning={refreshing} />
        </Pressable>
      </View>
      {account ? (
        <Text style={styles.accountLine} numberOfLines={1}>
          {[account.name, account.sub].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
      <OptionSheet
        open={picking}
        title="Date range"
        options={ranges.map((r) => ({ value: r.id, label: r.label }))}
        value={value}
        onPick={onPick}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { marginTop: space.md, gap: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: space.sm },
    accountLine: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    pill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 40,
      paddingHorizontal: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    pillText: { flex: 1, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    refresh: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm },
    pressed: { opacity: 0.6 },
    dim: { opacity: 0.5 },
  });

import { StyleSheet, Text, View } from "react-native";
import { statusText, type Connection } from "../../features/connectors/health";
import { font, type Colors } from "../../theme/tokens";
import { useTheme } from "../../theme/theme";

export function connectionColors(colors: Colors) {
  return {
    healthy: colors.status.greenDot,
    amber: colors.status.amberDot,
    broken: colors.status.redDot,
    off: colors.status.offDot,
  };
}

function tones(colors: Colors) {
  const dots = connectionColors(colors);
  const s = colors.status;
  return {
    connected: { dot: dots.healthy, bg: s.greenBg, text: s.greenText },
    stale: { dot: dots.amber, bg: s.amberBg, text: s.amberText },
    expiring: { dot: dots.amber, bg: s.amberBg, text: s.amberText },
    reconnect: { dot: dots.broken, bg: s.redBg, text: s.redText },
    off: { dot: colors.wire.faint, bg: colors.wire.tint, text: colors.wire.sub },
  };
}

export function StatusBadge({ c }: { c: Pick<Connection, "health" | "expiresInDays" | "comingSoon" | "managed"> }) {
  const { colors } = useTheme();
  const tone = tones(colors)[c.managed ? "off" : c.health];
  return (
    <View style={[styles.pill, { backgroundColor: tone.bg }]}>
      <View style={[styles.dot, { backgroundColor: tone.dot }]} />
      <Text style={[styles.text, { color: tone.text }]} numberOfLines={1}>
        {statusText(c)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 2,
    borderRadius: 999,
    flexShrink: 0,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 18, includeFontPadding: false },
});

import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName } from "../Icon";
import { useReduceMotion } from "../../lib/motion";
import type { KpiDelta } from "../../features/analytics/model";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export { SpinningIcon } from "../SpinningIcon";

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Delta({ delta }: { delta: KpiDelta | null }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (!delta) return null;
  return (
    <Text style={[styles.delta, { color: delta.good ? colors.status.greenStrong : colors.status.redStrong }]} accessibilityLabel={`${delta.text}, second half of the range vs first half`}>
      {delta.text}
    </Text>
  );
}

export function StatTile({
  label,
  value,
  delta,
  empty,
  sub,
}: {
  label: string;
  value: string;
  delta?: KpiDelta | null;
  empty?: boolean;
  sub?: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, empty && styles.tileEmpty]} accessible accessibilityLabel={`${label}: ${empty ? sub ?? "no numbers yet" : value}`}>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.tileValue, empty && { color: colors.wire.faint }]} numberOfLines={1} adjustsFontSizeToFit>
        {empty ? "-" : value}
      </Text>
      <View style={styles.tileFoot}>
        {empty ? (
          <Text style={styles.tileSub}>{sub ?? "No numbers yet"}</Text>
        ) : delta ? (
          <Delta delta={delta} />
        ) : sub ? (
          <Text style={styles.tileSubMuted}>{sub}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function TileGrid({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.grid}>{children}</View>;
}

type PillTone = "green" | "grey" | "amber";

function pillColors(colors: Colors, tone: PillTone) {
  const s = colors.status;
  if (tone === "green") return { bg: s.greenBg, fg: s.greenText, dot: s.greenDot };
  if (tone === "amber") return { bg: s.amberBg, fg: s.amberText, dot: s.amberBright };
  return { bg: colors.wire.tint, fg: colors.wire.sub, dot: colors.wire.faint };
}

export function LivePill({ label = "Live", tone = "green" }: { label?: string; tone?: PillTone }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const t = pillColors(colors, tone);
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <View style={[styles.pillDot, { backgroundColor: t.dot }]} />
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function PillTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.tabs} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            style={[styles.tab, on && styles.tabOn]}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.tabText, on && styles.tabTextOn]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SmallButton({
  label,
  onPress,
  primary,
  full,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  full?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.btn,
        primary ? styles.btnPrimary : styles.btnPlain,
        full ? styles.btnFull : styles.btnFit,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={[styles.btnText, { color: primary ? colors.onInk : colors.wire.ink }]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyAnalytics({ body, actionLabel, onAction }: { body: string; actionLabel?: string; onAction?: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.empty} accessible accessibilityLabel={`No numbers yet. ${body}`}>
      <View style={styles.emptyIcon}>
        <Icon name="chartColumn" size={22} color={colors.wire.sub} />
      </View>
      <Text style={styles.emptyTitle}>No numbers yet</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {actionLabel && onAction ? (
        <View style={styles.emptyAction}>
          <SmallButton primary full label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

export function Bars({ lines = 2, label }: { lines?: number; label: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label}>
      {Array.from({ length: lines }, (_, i) => (
        <View key={i} style={[styles.bar, { width: i === lines - 1 ? "55%" : "92%" }]} />
      ))}
    </View>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  const styles = useStyles(makeStyles);
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function H3({ children, style }: { children: ReactNode; style?: object }) {
  const styles = useStyles(makeStyles);
  return <Text style={[styles.h3, style]}>{children}</Text>;
}

export function ProgressRow({ label, right, fraction, done }: { label: string; right: string; fraction: number; done: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View>
      <View style={styles.progressHead}>
        <Text style={styles.progressLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.progressRight}>{right}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, backgroundColor: done ? colors.status.greenDot : colors.chart.violet },
          ]}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, borderColor: colors.wire.line, backgroundColor: colors.surfaceRaised, padding: 16 },
  delta: { fontFamily: font.family.medium, fontSize: 12, fontVariant: ["tabular-nums"] },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.wire.line,
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  tileEmpty: { borderStyle: "dashed" },
  tileLabel: { fontFamily: font.family.regular, fontSize: 12.5, color: colors.wire.mute },
  tileValue: { marginTop: 2, fontFamily: font.family.semi, fontSize: 19, lineHeight: 26, color: colors.wire.text, fontVariant: ["tabular-nums"] },
  tileFoot: { marginTop: 2, minHeight: 16, justifyContent: "center" },
  tileSub: { fontFamily: font.family.regular, fontSize: 12, color: colors.wire.faint },
  tileSubMuted: { fontFamily: font.family.regular, fontSize: 12, color: colors.wire.mute },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontFamily: font.family.medium, fontSize: 12 },
  tabs: { flexDirection: "row", gap: 4, borderRadius: 999, padding: 4, backgroundColor: colors.wire.tabTrack },
  tab: { flex: 1, minHeight: 32, borderRadius: 999, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  tabOn: {
    backgroundColor: colors.wire.tabOn,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tabText: { fontFamily: font.family.medium, fontSize: 13.5, color: colors.wire.sub },
  tabTextOn: { fontFamily: font.family.semi, color: colors.wire.text },
  btn: { height: 36, borderRadius: 999, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  btnPrimary: { backgroundColor: colors.wire.ink, borderColor: colors.wire.ink },
  btnPlain: { backgroundColor: colors.surfaceRaised, borderColor: colors.wire.line },
  btnFull: { alignSelf: "stretch" },
  btnFit: { alignSelf: "flex-start" },
  btnText: { fontFamily: font.family.semi, fontSize: 13 },
  empty: { alignItems: "center", paddingVertical: 8 },
  emptyIcon: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.wire.tint },
  emptyTitle: { marginTop: 12, fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.wire.text },
  emptyBody: { marginTop: 6, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.wire.mute, textAlign: "center", maxWidth: 280 },
  emptyAction: { marginTop: 16, alignSelf: "stretch" },
  bar: { marginVertical: 5, height: 10, borderRadius: 999, backgroundColor: colors.wire.tint },
  muted: { fontFamily: font.family.regular, fontSize: 12.5, lineHeight: 18, color: colors.wire.mute },
  h3: { fontFamily: font.family.semi, fontSize: 15, color: colors.wire.text },
  progressHead: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  progressLabel: { flex: 1, fontFamily: font.family.regular, fontSize: 13, color: colors.wire.body },
  progressRight: { fontFamily: font.family.regular, fontSize: 13, color: colors.wire.mute, fontVariant: ["tabular-nums"] },
  progressTrack: { marginTop: 4, height: 8, borderRadius: 999, overflow: "hidden", backgroundColor: colors.wire.line },
  progressFill: { height: "100%", borderRadius: 999 },
});

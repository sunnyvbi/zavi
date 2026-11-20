import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { SeoHealth } from "../../features/channels/seoKpis";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const RING = 76;
const STROKE = 8;

export function SeoHealthCard({ health }: { health: SeoHealth }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const toneColor = (t: "good" | "warn" | "bad") => (t === "good" ? colors.status.greenDot : t === "warn" ? colors.status.amberBright : colors.status.redDot);
  const r = (RING - STROKE) / 2;
  const circ = 2 * Math.PI * r;
  const score = health.score;
  const total = (health.segments ?? []).reduce((n, s) => n + s.value, 0);

  return (
    <View style={styles.card}>
      <Text style={styles.caps}>Site health</Text>
      <View style={styles.top}>
        <View style={styles.ring} accessibilityLabel={score === null ? "Site health not measured" : `Site health ${score} percent`}>
          <Svg width={RING} height={RING}>
            <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={colors.soft} strokeWidth={STROKE} fill="none" />
            {score !== null ? (
              <Circle
                cx={RING / 2}
                cy={RING / 2}
                r={r}
                stroke={toneColor(health.tone ?? "bad")}
                strokeWidth={STROKE}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${(circ * score) / 100} ${circ}`}
                transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
              />
            ) : null}
          </Svg>
          <Text style={styles.ringText}>{score === null ? "—" : `${score}%`}</Text>
        </View>
        <View style={styles.headText}>
          <Text style={styles.headline}>{health.headline}</Text>
          <Text style={styles.note}>{health.note}</Text>
        </View>
      </View>

      <View style={styles.counts}>
        {health.counts.map((c) => (
          <View key={c.kind} style={[styles.count, c.kind === "error" ? styles.countBad : c.kind === "warning" ? styles.countWarn : styles.countNotice]}>
            <Text style={[styles.countLabel, c.kind === "error" ? styles.bad : c.kind === "warning" ? styles.warn : styles.notice]}>{c.label}</Text>
            <Text style={styles.countValue}>{c.value === null ? "—" : c.value}</Text>
            <Text style={styles.countSub} numberOfLines={2}>
              {c.sub}
            </Text>
          </View>
        ))}
      </View>

      {health.segments && total > 0 ? (
        <View style={styles.segments}>
          <Text style={styles.caps}>{health.segmentsLabel}</Text>
          <View style={styles.bar}>
            {health.segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <View key={s.label} style={{ flex: s.value, backgroundColor: toneColor(s.tone) }} />
              ))}
          </View>
          <View style={styles.legend}>
            {health.segments.map((s) => (
              <View key={s.label} style={styles.legendItem}>
                <View style={[styles.dot, { backgroundColor: toneColor(s.tone) }]} />
                <Text style={styles.legendText}>
                  {s.label} <Text style={styles.legendValue}>{s.value}</Text>
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.md, padding: space.lg, gap: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    caps: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.66, textTransform: "uppercase", color: colors.muted },
    top: { flexDirection: "row", alignItems: "center", gap: space.md },
    ring: { width: RING, height: RING, alignItems: "center", justifyContent: "center" },
    ringText: { position: "absolute", fontFamily: font.family.semi, fontSize: 18, color: colors.ink },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    headline: { fontFamily: font.family.semi, fontSize: 15, lineHeight: 20, color: colors.ink },
    note: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    counts: { flexDirection: "row", gap: 6 },
    count: { flex: 1, gap: 1, padding: 10, borderRadius: radius.md },
    countBad: { backgroundColor: colors.status.redBg },
    countWarn: { backgroundColor: colors.status.amberBg },
    countNotice: { backgroundColor: colors.soft },
    countLabel: { fontFamily: font.family.semi, fontSize: 12 },
    bad: { color: colors.status.redText },
    warn: { color: colors.status.amberText },
    notice: { color: colors.textSecondary },
    countValue: { fontFamily: font.family.semi, fontSize: 22, lineHeight: 26, color: colors.ink },
    countSub: { fontFamily: font.family.regular, fontSize: 11, lineHeight: 15, color: colors.muted },
    segments: { gap: 6 },
    bar: { flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: colors.soft },
    legend: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: 4 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { fontFamily: font.family.regular, fontSize: 12, color: colors.textSecondary },
    legendValue: { fontFamily: font.family.semi, color: colors.ink },
  });

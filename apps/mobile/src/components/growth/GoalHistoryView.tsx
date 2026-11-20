import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useGoalHistory } from "../../features/growth/hooks";
import { SPARK_H, SPARK_W, historyStats, historyVerdict, isBehind, receiptLine, sparkPaths, targetLine } from "../../features/growth/goalHistory";
import { formatGoalNumber, type GrowthGoal } from "../../features/growth/plan";
import { historyPace } from "../../features/growth/story";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ActionButton, Bars } from "./StoryKit";

export function GoalHistoryView({ goal, onAsk }: { goal: GrowthGoal; onAsk: (text: string) => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const q = useGoalHistory(goal);
  const format = (v: number) => formatGoalNumber(goal.target_metric, v);
  const body = q.data ?? null;
  const points = body?.points ?? [];
  const has = points.length > 0;
  const pace = has ? historyPace(points, goal, Date.now(), goal.current_value) : null;
  const behind = isBehind(pace, format);
  const verdict = historyVerdict({ failed: q.isError, points, pace, behind, measurementMode: goal.measurement_mode, format });
  const target = has ? targetLine(points, goal) : null;
  const stroke = behind ? colors.red : colors.ink;

  if (q.isPending) return <Bars label="Loading history" lines={3} height={18} />;

  return (
    <View style={styles.wrap} accessibilityLabel="Goal history">
      <View style={[styles.verdict, verdict.tone === "good" && styles.verdictGood, verdict.tone === "bad" && styles.verdictBad]}>
        <Text style={[styles.verdictTitle, verdict.tone === "good" && styles.goodText, verdict.tone === "bad" && styles.badText]}>{verdict.title}</Text>
        <Text style={[styles.verdictDetail, verdict.tone === "bad" && styles.verdictDetailBad]}>{verdict.detail}</Text>
      </View>
      <View style={styles.stats}>
        {historyStats(pace, format).map((s) => (
          <View key={s.label} style={styles.stat}>
            <Text style={styles.statLabel}>{s.label}</Text>
            <Text style={[styles.statValue, s.value === null && styles.statNone]}>{s.value ?? "No data"}</Text>
          </View>
        ))}
      </View>
      <View style={styles.chart}>
        <Text style={styles.chartTitle}>History</Text>
        <Svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width="100%" height={SPARK_H} preserveAspectRatio="none" accessibilityLabel="Measured history against the goal line">
          {has ? <Chart values={points.map((p) => p.value)} target={target} stroke={stroke} muted={colors.muted} /> : <Path d={`M2 ${SPARK_H - 10} L${SPARK_W - 2} ${SPARK_H - 10}`} stroke={colors.line} strokeWidth={1.25} strokeDasharray="4 4" />}
        </Svg>
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: stroke }]} />
            <Text style={styles.legendText}>Actual</Text>
          </View>
          <View style={styles.legendItem}>
            <Svg width={16} height={4}>
              <Path d="M0 2 H16" stroke={colors.muted} strokeWidth={1.5} strokeDasharray="2 3" />
            </Svg>
            <Text style={styles.legendText}>Goal line</Text>
          </View>
        </View>
        <Text style={styles.legendText}>{body && has ? receiptLine(body) : "The source appears once there is a reading."}</Text>
        {pace && pace.daysLeft > 0 ? (
          <ActionButton
            label={behind ? "Ask Zavi how to close the gap" : "Ask Zavi what is driving it"}
            onPress={() => onAsk(behind ? `How do I close the gap on "${goal.objective}"?` : `What is driving "${goal.objective}"?`)}
          />
        ) : null}
      </View>
    </View>
  );
}

function Chart({ values, target, stroke, muted }: { values: number[]; target: number[] | null; stroke: string; muted: string }) {
  const p = sparkPaths(values, target);
  return (
    <>
      {p.goal ? <Path d={p.goal} fill="none" stroke={muted} strokeWidth={1.25} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" /> : null}
      {p.actual ? <Path d={p.actual} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
      <Circle cx={p.last.x} cy={p.last.y} r={2.75} fill={stroke} />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.md, marginBottom: space.lg },
    verdict: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.soft, padding: space.md, gap: 2 },
    verdictGood: { backgroundColor: colors.status.greenBg, borderColor: colors.status.greenBg },
    verdictBad: { backgroundColor: colors.ink, borderColor: colors.ink },
    verdictTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    goodText: { color: colors.status.greenText },
    badText: { color: colors.onInk },
    verdictDetail: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.textSecondary },
    verdictDetailBad: { color: colors.onInk },
    stats: { flexDirection: "row", gap: space.sm },
    stat: { flex: 1, borderRadius: radius.md, backgroundColor: colors.soft, padding: 10, gap: 2, justifyContent: "space-between" },
    statLabel: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
    statValue: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    statNone: { color: colors.muted },
    chart: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: space.md, gap: space.sm },
    chartTitle: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    legend: { flexDirection: "row", gap: space.md },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    swatch: { width: 16, height: 2, borderRadius: 1 },
    legendText: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
  });

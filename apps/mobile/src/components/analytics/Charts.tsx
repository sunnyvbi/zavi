import { useId, useState } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from "react-native-svg";
import { axisLabel, labelEvery, monotonePath, niceScale, round2, tipValue, type Pt, type Unit } from "../../features/analytics/chart";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const LEFT = 34;
const AXIS_FONT = 10.5;

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  return [w || 320, (e) => setW(Math.round(e.nativeEvent.layout.width))];
}

function useTap(count: number, indexAt: (x: number) => number) {
  const [tap, setTap] = useState<number | null>(null);
  const clamp = (x: number) => Math.min(count - 1, Math.max(0, indexAt(x)));
  const handlers = {
    onStartShouldSetResponder: () => count > 0,
    onResponderTerminationRequest: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      const i = clamp(e.nativeEvent.locationX);
      setTap((prev) => (prev === i ? null : i));
    },
    onResponderMove: (e: GestureResponderEvent) => setTap(clamp(e.nativeEvent.locationX)),
  };
  return { tap, handlers };
}

function Tooltip({ leftPct, title, lines }: { leftPct: number; title: string; lines: string[] }) {
  const styles = useStyles(makeStyles);
  const shift: `${number}%` = leftPct < 22 ? "0%" : leftPct > 78 ? "-100%" : "-50%";
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.tip, { left: `${leftPct}%`, transform: [{ translateX: shift }] }]}
    >
      <Text style={styles.tipTitle}>{title}</Text>
      {lines.map((l) => (
        <Text key={l} style={styles.tipLine}>
          {l}
        </Text>
      ))}
    </View>
  );
}

export type AreaSeries = { id: string; label: string; color: string; unit?: Unit; values: (number | null)[] };

export function AreaChart({
  series,
  labels,
  height = 180,
  dualAxis = false,
  title,
  lineOnly = false,
}: {
  series: AreaSeries[];
  labels: string[];
  height?: number;
  dualAxis?: boolean;
  title: string;
  lineOnly?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const dual = dualAxis && series.length > 1;
  const plotW = Math.max(1, width - LEFT - (dual ? 34 : 6));
  const plotH = height - 10 - 22;
  const n = labels.length;
  const xAt = (i: number) => LEFT + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const vals = (s: AreaSeries) => s.values.filter((v): v is number => v !== null);
  const shared = niceScale(series.flatMap(vals));
  const leftScale = dual ? niceScale(vals(series[0])) : shared;
  const rightScale = dual && series[1] ? niceScale(vals(series[1])) : leftScale;
  const leftSpan = Math.max(1, leftScale.top - leftScale.bottom);
  const rightSpan = Math.max(1, rightScale.top - rightScale.bottom);
  const every = labelEvery(n, plotW, 62);
  const { tap, handlers } = useTap(n, (x) => Math.round(((x - LEFT) / plotW) * (n - 1)));
  const yFor = (v: number, scale: typeof leftScale, span: number) => round2(10 + ((scale.top - v) / span) * plotH);
  const gridY = (k: number, scale: typeof leftScale, span: number) => yFor(scale.bottom + k * scale.step, scale, span);

  const drawn = series.map((s, si) => {
    const scale = dual && si === 1 ? rightScale : leftScale;
    const span = dual && si === 1 ? rightSpan : leftSpan;
    const zeroY = yFor(0, scale, span);
    const pts: (Pt | null)[] = s.values.map((v, i) =>
      v === null ? null : { x: round2(xAt(i)), y: yFor(v, scale, span) },
    );
    const present = pts.filter((p): p is Pt => p !== null);
    const line = monotonePath(present);
    const area = present.length
      ? `${line} L ${present[present.length - 1].x} ${zeroY} L ${present[0].x} ${zeroY} Z`
      : "";
    return { line, area, pts };
  });

  return (
    <View>
      {series.length > 1 ? (
        <View style={styles.legend}>
          {series.map((s) => (
            <View key={s.id} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: s.color }]} />
              <Text style={styles.legendText}>{s.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View
        onLayout={onLayout}
        {...handlers}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${title}: ${series.map((s) => s.label).join(" and ")} over ${n} points. Tap for values.`}
      >
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            {series.map((s, i) => (
              <LinearGradient key={s.id} id={`${gid}-${i}`} x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0%" stopColor={i === 0 ? colors.wire.mute : colors.wire.faint} stopOpacity={i === 0 ? 0.4 : 0.2} />
                <Stop offset="100%" stopColor={colors.surfaceRaised} stopOpacity={0} />
              </LinearGradient>
            ))}
          </Defs>
          {[0, 1, 2, 3, 4].map((k) => (
            <Line key={k} x1={LEFT} x2={LEFT + plotW} y1={gridY(k, leftScale, leftSpan)} y2={gridY(k, leftScale, leftSpan)} stroke={colors.chart.grid} />
          ))}
          {labels.map((_, i) =>
            i % every === 0 ? (
              <Line key={`v${i}`} x1={round2(xAt(i))} x2={round2(xAt(i))} y1={10} y2={10 + plotH} stroke={colors.chart.gridSoft} />
            ) : null,
          )}
          {series[0]
            ? [0, 1, 2, 3, 4].map((k) => (
                <SvgText key={`l${k}`} x={28} y={gridY(k, leftScale, leftSpan) + 3.5} textAnchor="end" fontSize={AXIS_FONT} fill={colors.chart.axis}>
                  {axisLabel(leftScale.bottom + k * leftScale.step, series[0].unit)}
                </SvgText>
              ))
            : null}
          {dual && series[1]
            ? [0, 1, 2, 3, 4].map((k) => (
                <SvgText key={`r${k}`} x={LEFT + plotW + 6} y={gridY(k, rightScale, rightSpan) + 3.5} textAnchor="start" fontSize={AXIS_FONT} fill={colors.chart.axis}>
                  {axisLabel(rightScale.bottom + k * rightScale.step, series[1].unit)}
                </SvgText>
              ))
            : null}
          {leftScale.bottom < 0 ? (
            <Line x1={LEFT} x2={LEFT + plotW} y1={yFor(0, leftScale, leftSpan)} y2={yFor(0, leftScale, leftSpan)} stroke={colors.chart.axis} />
          ) : null}
          {lineOnly
            ? null
            : drawn
                .map((d, i) => (
                  <Path key={`a${series[i].id}`} d={d.area} fill={`url(#${gid}-${i})`} />
                ))
                .reverse()}
          {drawn
            .map((d, i) => (
              <Path
                key={`p${series[i].id}`}
                d={d.line}
                fill="none"
                stroke={series[i].color}
                strokeWidth={i === 0 ? 2 : 1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))
            .reverse()}
          {labels.map((label, i) =>
            i % every === 0 ? (
              <SvgText
                key={`x${i}`}
                x={round2(xAt(i))}
                y={height - 6}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={AXIS_FONT}
                fill={colors.chart.axis}
              >
                {label}
              </SvgText>
            ) : null,
          )}
          {tap !== null ? (
            <>
              <Line x1={round2(xAt(tap))} x2={round2(xAt(tap))} y1={10} y2={10 + plotH} stroke={colors.wire.faint} strokeDasharray="3 3" />
              {drawn.map((d, i) => {
                const p = d.pts[tap];
                return p ? (
                  <Circle key={`c${series[i].id}`} cx={p.x} cy={p.y} r={3.5} fill={colors.surfaceRaised} stroke={series[i].color} strokeWidth={2} />
                ) : null;
              })}
            </>
          ) : null}
        </Svg>
        {tap !== null && labels[tap] ? (
          <Tooltip
            leftPct={(xAt(tap) / width) * 100}
            title={labels[tap]}
            lines={series.map((s) => `${s.label}: ${tipValue(s.values[tap] ?? null, s.unit)}`)}
          />
        ) : null}
      </View>
    </View>
  );
}

export function BarChart({
  bars,
  height = 150,
  color: colorProp,
  unit,
  label,
}: {
  bars: { label: string; value: number }[];
  height?: number;
  color?: string;
  unit?: Unit;
  label: string;
}) {
  const { colors } = useTheme();
  const color = colorProp ?? colors.chart.bar;
  const [width, onLayout] = useWidth();
  const values = bars.map((b) => b.value);
  const plotW = Math.max(1, width - LEFT - 4);
  const plotH = Math.max(1, height - 8 - 22);
  const { step, top, bottom } = niceScale(values);
  const span = Math.max(1, top - bottom);
  const slot = plotW / Math.max(1, values.length);
  const barW = Math.max(3, Math.min(26, 0.62 * slot));
  const cx = (i: number) => LEFT + slot * i + slot / 2;
  const yAt = (v: number) => 8 + ((top - v) / span) * plotH;
  const zeroY = yAt(0);
  const every = labelEvery(bars.length, plotW, 56);
  const { tap, handlers } = useTap(values.length, (x) => Math.floor((x - LEFT) / slot));
  const last = values[values.length - 1] ?? 0;

  return (
    <View
      onLayout={onLayout}
      {...handlers}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${label}, ${values.length} bars, last ${tipValue(last, unit)}. Tap a bar for its value.`}
    >
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {[0, 1, 2, 3, 4].map((k) => {
          const y = round2(yAt(bottom + k * step));
          return (
            <Line key={k} x1={LEFT} x2={LEFT + plotW} y1={y} y2={y} stroke={colors.chart.grid} />
          );
        })}
        {bottom < 0 ? <Line x1={LEFT} x2={LEFT + plotW} y1={round2(zeroY)} y2={round2(zeroY)} stroke={colors.chart.axis} /> : null}
        {[0, 1, 2, 3, 4].map((k) => (
          <SvgText
            key={`t${k}`}
            x={28}
            y={round2(yAt(bottom + k * step)) + 3.5}
            textAnchor="end"
            fontSize={AXIS_FONT}
            fill={colors.chart.axis}
          >
            {axisLabel(bottom + k * step, unit)}
          </SvgText>
        ))}
        {values.map((v, i) => (
          <Rect
            key={`b${i}`}
            x={round2(cx(i) - barW / 2)}
            y={round2(Math.min(yAt(v), zeroY))}
            width={round2(barW)}
            height={round2(Math.max(1, Math.abs(zeroY - yAt(v))))}
            rx={Math.min(3, barW / 3)}
            fill={color}
            opacity={tap === null || tap === i ? 1 : 0.4}
          />
        ))}
        {bars.map((b, i) =>
          i % every === 0 ? (
            <SvgText key={`x${i}`} x={round2(cx(i))} y={8 + plotH + 15} textAnchor="middle" fontSize={AXIS_FONT} fill={colors.chart.axis}>
              {b.label}
            </SvgText>
          ) : null,
        )}
      </Svg>
      {tap !== null && bars[tap] ? (
        <Tooltip leftPct={(cx(tap) / width) * 100} title={bars[tap].label} lines={[`${label}: ${tipValue(values[tap], unit)}`]} />
      ) : null}
    </View>
  );
}

const SKELETON = [40, 62, 48, 75, 58, 82, 66];

export function ChartSkeleton({ height = 150 }: { height?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.frame, { height }]} accessibilityRole="progressbar" accessibilityLabel="Loading chart">
      <View style={styles.skeletonRow}>
        {SKELETON.map((h, i) => (
          <View key={i} style={[styles.skeletonBar, { height: `${h}%` }]} />
        ))}
      </View>
    </View>
  );
}

export function EmptyChart({ height = 150, text }: { height?: number; text: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={[styles.frame, { height }]}>
      <View style={styles.emptyLines} pointerEvents="none">
        {[0, 1, 2, 3, 4].map((k) => (
          <View
            key={k}
            style={[styles.emptyLine, k === 4 ? { borderColor: colors.chart.grid } : { borderStyle: "dashed" }]}
          />
        ))}
      </View>
      <View style={styles.emptyCenter}>
        <Text style={styles.emptyText}>{text}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  legend: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 12, marginBottom: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: font.family.regular, fontSize: 12, color: colors.chart.axis },
  tip: {
    position: "absolute",
    top: 0,
    zIndex: 10,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.chart.tooltip,
  },
  tipTitle: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, color: colors.chart.tooltipText },
  tipLine: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 16, color: colors.chart.tooltipText },
  frame: { position: "relative" },
  skeletonRow: {
    position: "absolute",
    left: LEFT,
    right: 0,
    top: 8,
    bottom: 24,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  skeletonBar: { flex: 1, borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: colors.wire.tint },
  emptyLines: { position: "absolute", left: LEFT, right: 0, top: 8, bottom: 24, justifyContent: "space-between" },
  emptyLine: { borderTopWidth: 1, borderColor: colors.chart.gridSoft },
  emptyCenter: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  emptyText: {
    fontFamily: font.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.wire.mute,
    textAlign: "center",
    backgroundColor: colors.chart.labelBg,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
});

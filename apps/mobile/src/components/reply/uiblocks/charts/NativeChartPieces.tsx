import { useId, useState } from "react";
import { StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Polygon, Rect, Stop, Text as SvgText } from "react-native-svg";
import type { ChartBlock as ChartBlockModel } from "@zavi/shared";
import { axisLabel, labelEvery, monotonePath, niceScale, round2, tipValue, type Pt } from "../../../../features/analytics/chart";
import { font, type Colors } from "../../../../theme/tokens";
import { useStyles, useTheme } from "../../../../theme/theme";

const LEFT = 40;
const TOP = 14;
const BOTTOM = 28;
const RIGHT = 10;
const AXIS_FONT = 10;

type ChartPoint = { label: string; value: number };

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
  return { tap, setTap, handlers };
}

function Tooltip({ leftPct, title, lines }: { leftPct: number; title: string; lines: string[] }) {
  const styles = useStyles(makeStyles);
  const shift: `${number}%` = leftPct < 22 ? "0%" : leftPct > 78 ? "-100%" : "-50%";
  return (
    <View pointerEvents="none" accessibilityLiveRegion="polite" style={[styles.tip, { left: `${leftPct}%`, transform: [{ translateX: shift }] }]}>
      <Text style={styles.tipTitle}>{title}</Text>
      {lines.map((l) => (
        <Text key={l} style={styles.tipLine}>
          {l}
        </Text>
      ))}
    </View>
  );
}

function shortLabel(label: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const d = new Date(`${label}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
  }
  return label.length > 10 ? `${label.slice(0, 9)}...` : label;
}

function formatValue(value: number, unit: string | undefined): string {
  return tipValue(value, unit);
}

function seriesColor(value: number, hasNegative: boolean, colors: Colors, modelColors?: ChartBlockModel["colors"]): string {
  const bySign = hasNegative || !!(modelColors?.positive || modelColors?.negative);
  if (!bySign) return modelColors?.series ?? colors.chart.blue;
  return value < 0 ? (modelColors?.negative ?? colors.status.redDot) : (modelColors?.positive ?? colors.status.greenDot);
}

export function CartesianChart({
  block,
  height = 220,
}: {
  block: ChartBlockModel;
  height?: number;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const series = block.series;
  const compare = block.compare ?? [];
  const hasCompare = compare.length > 0;
  const hasGoal = typeof block.goal === "number";
  const values = [
    ...series.map((p) => p.value),
    ...compare.map((p) => p.value),
    ...(hasGoal ? [block.goal as number] : []),
  ];
  const scale = niceScale(values);
  const span = Math.max(1, scale.top - scale.bottom);
  const plotW = Math.max(1, width - LEFT - RIGHT);
  const plotH = Math.max(1, height - TOP - BOTTOM);
  const n = series.length;
  const slot = plotW / Math.max(1, n);
  const xAt = (i: number) => (n > 1 ? LEFT + (i / (n - 1)) * plotW : LEFT + plotW / 2);
  const barCx = (i: number) => LEFT + slot * i + slot / 2;
  const yAt = (v: number) => TOP + ((scale.top - v) / span) * plotH;
  const zeroY = yAt(0);
  const every = labelEvery(n, plotW, 58);
  const { tap, handlers } = useTap(n, (x) => (block.variant === "bar" ? Math.floor((x - LEFT) / slot) : Math.round(((x - LEFT) / plotW) * (n - 1))));
  const hasNegative = values.some((v) => v < 0);
  const stroke = block.colors?.series ?? colors.chart.blue;
  const compareStroke = colors.chart.seriesOther;
  const mainPts: Pt[] = series.map((p, i) => ({ x: round2(xAt(i)), y: round2(yAt(p.value)) }));
  const comparePts: Pt[] = compare.slice(0, n).map((p, i) => ({ x: round2(xAt(i)), y: round2(yAt(p.value)) }));
  const mainPath = monotonePath(mainPts);
  const comparePath = monotonePath(comparePts);
  const areaPath = mainPts.length
    ? `${mainPath} L ${mainPts[mainPts.length - 1].x} ${round2(zeroY)} L ${mainPts[0].x} ${round2(zeroY)} Z`
    : "";
  const barW = Math.max(3, Math.min(26, slot * (hasCompare ? 0.34 : 0.58)));
  const mainOffset = hasCompare ? -barW * 0.58 : 0;
  const compareOffset = hasCompare ? barW * 0.58 : 0;

  return (
    <View>
      <View
        onLayout={onLayout}
        {...handlers}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${block.variant} chart: ${block.title}. Tap the chart to read a bar or point.`}
      >
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          <Defs>
            <LinearGradient id={`${gid}-area`} x1="0" x2="0" y1="0" y2="1">
              <Stop offset="0%" stopColor={stroke} stopOpacity={0.24} />
              <Stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </LinearGradient>
          </Defs>
          {[0, 1, 2, 3, 4].map((k) => {
            const value = scale.bottom + k * scale.step;
            const y = round2(yAt(value));
            return (
              <G key={k}>
                <Line x1={LEFT} x2={LEFT + plotW} y1={y} y2={y} stroke={colors.chart.grid} />
                <SvgText x={LEFT - 8} y={y + 3.5} textAnchor="end" fontSize={AXIS_FONT} fontFamily={font.family.regular} fill={colors.chart.axis}>
                  {axisLabel(value, block.unit)}
                </SvgText>
              </G>
            );
          })}
          {scale.bottom < 0 ? <Line x1={LEFT} x2={LEFT + plotW} y1={round2(zeroY)} y2={round2(zeroY)} stroke={colors.chart.axis} /> : null}
          {hasGoal ? (
            <Line
              x1={LEFT}
              x2={LEFT + plotW}
              y1={round2(yAt(block.goal as number))}
              y2={round2(yAt(block.goal as number))}
              stroke={colors.status.greenDot}
              strokeWidth={1.5}
              strokeDasharray="2 4"
            />
          ) : null}
          {block.variant === "bar"
            ? series.map((p, i) => {
                const x = barCx(i);
                const y = yAt(p.value);
                return (
                  <G key={p.label}>
                    {hasCompare && compare[i] ? (
                      <Rect
                        x={round2(x + compareOffset - barW / 2)}
                        y={round2(Math.min(yAt(compare[i].value), zeroY))}
                        width={round2(barW)}
                        height={round2(Math.max(1, Math.abs(zeroY - yAt(compare[i].value))))}
                        rx={Math.min(3, barW / 3)}
                        fill={compareStroke}
                        opacity={0.5}
                      />
                    ) : null}
                    <Rect
                      x={round2(x + mainOffset - barW / 2)}
                      y={round2(Math.min(y, zeroY))}
                      width={round2(barW)}
                      height={round2(Math.max(1, Math.abs(zeroY - y)))}
                      rx={Math.min(3, barW / 3)}
                      fill={seriesColor(p.value, hasNegative, colors, block.colors)}
                      opacity={tap === null || tap === i ? 1 : 0.45}
                    />
                  </G>
                );
              })
            : null}
          {block.variant === "area" ? <Path d={areaPath} fill={`url(#${gid}-area)`} /> : null}
          {block.variant !== "bar" && hasCompare && comparePath ? (
            <Path d={comparePath} fill="none" stroke={compareStroke} strokeWidth={1.6} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {block.variant !== "bar" ? (
            <>
              <Path d={mainPath} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {mainPts.map((p, i) => (
                <Circle key={`pt${i}`} cx={p.x} cy={p.y} r={tap === i ? 4 : 2.5} fill={tap === i ? colors.surfaceRaised : stroke} stroke={stroke} strokeWidth={tap === i ? 2 : 0} />
              ))}
            </>
          ) : null}
          {series.map((p, i) =>
            i % every === 0 ? (
              <SvgText
                key={`x${p.label}`}
                x={round2(block.variant === "bar" ? barCx(i) : xAt(i))}
                y={height - 7}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={AXIS_FONT}
                fontFamily={font.family.regular}
                fill={colors.chart.axis}
              >
                {shortLabel(p.label)}
              </SvgText>
            ) : null,
          )}
          {tap !== null ? (
            <Line
              x1={round2(block.variant === "bar" ? barCx(tap) : xAt(tap))}
              x2={round2(block.variant === "bar" ? barCx(tap) : xAt(tap))}
              y1={TOP}
              y2={TOP + plotH}
              stroke={colors.chart.axis}
              strokeDasharray="3 3"
            />
          ) : null}
        </Svg>
        {tap !== null && series[tap] ? (
          <Tooltip
            leftPct={((block.variant === "bar" ? barCx(tap) : xAt(tap)) / width) * 100}
            title={series[tap].label}
            lines={[
              `This period: ${formatValue(series[tap].value, block.unit)}`,
              ...(hasCompare && compare[tap] ? [`Prior period: ${formatValue(compare[tap].value, block.unit)}`] : []),
              ...(hasGoal ? [`Goal: ${formatValue(block.goal as number, block.unit)}`] : []),
            ]}
          />
        ) : null}
      </View>
      <Text style={styles.hint}>Tap the chart to read a bar/point.</Text>
    </View>
  );
}

function polar(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function slicePath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const safeEnd = end - start >= Math.PI * 2 ? start + Math.PI * 2 - 0.001 : end;
  const so = polar(cx, cy, outer, start);
  const eo = polar(cx, cy, outer, safeEnd);
  const large = safeEnd - start > Math.PI ? 1 : 0;
  if (inner <= 0) return `M ${cx} ${cy} L ${so.x} ${so.y} A ${outer} ${outer} 0 ${large} 1 ${eo.x} ${eo.y} Z`;
  const si = polar(cx, cy, inner, start);
  const ei = polar(cx, cy, inner, safeEnd);
  return `M ${so.x} ${so.y} A ${outer} ${outer} 0 ${large} 1 ${eo.x} ${eo.y} L ${ei.x} ${ei.y} A ${inner} ${inner} 0 ${large} 0 ${si.x} ${si.y} Z`;
}

export function RadialChart({ block, height = 210 }: { block: ChartBlockModel; height?: number }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [selected, setSelected] = useState<number | null>(null);
  const [width, onLayout] = useWidth();
  const palette = chartPalette(colors);
  const size = Math.min(width, height - 12);
  const cx = width / 2;
  const cy = size / 2 + 4;
  const outer = Math.max(48, size * 0.38);
  const inner = block.variant === "donut" ? outer * 0.58 : 0;
  const positive = block.series.map((p) => Math.max(0, p.value));
  const total = positive.reduce((sum, v) => sum + v, 0);
  let angle = -Math.PI / 2;

  return (
    <View>
      <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`${block.variant} chart: ${block.title}. Tap a slice to read its value.`}>
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          {total > 0
            ? block.series.map((p, i) => {
                const value = positive[i];
                const start = angle;
                const end = angle + (value / total) * Math.PI * 2;
                angle = end;
                const mid = (start + end) / 2;
                const labelAt = polar(cx, cy, outer + 15, mid);
                const pct = value / total;
                return (
                  <G key={p.label} onPress={() => setSelected((prev) => (prev === i ? null : i))}>
                    <Path d={slicePath(cx, cy, outer, inner, start, end)} fill={palette[i % palette.length]} stroke={colors.panel} strokeWidth={2} opacity={selected === null || selected === i ? 1 : 0.45} />
                    {pct >= 0.08 ? (
                      <SvgText x={labelAt.x} y={labelAt.y} textAnchor={labelAt.x < cx ? "end" : "start"} fontSize={AXIS_FONT} fontFamily={font.family.medium} fill={colors.chart.axis}>
                        {shortLabel(p.label)}
                      </SvgText>
                    ) : null}
                  </G>
                );
              })
            : null}
        </Svg>
        {selected !== null && block.series[selected] ? (
          <Tooltip
            leftPct={50}
            title={block.series[selected].label}
            lines={[formatValue(block.series[selected].value, block.unit)]}
          />
        ) : null}
      </View>
      <Legend points={block.series} unit={block.unit} />
      <Text style={styles.hint}>Tap a slice to read its value.</Text>
    </View>
  );
}

export function FunnelChart({ block, height = 230 }: { block: ChartBlockModel; height?: number }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [selected, setSelected] = useState<number | null>(null);
  const [width, onLayout] = useWidth();
  const palette = chartPalette(colors);
  const values = block.series.map((p) => Math.max(0, p.value));
  const max = Math.max(1, ...values);
  const stageH = (height - 16) / Math.max(1, block.series.length);
  const center = width / 2;
  const maxW = Math.max(80, width - 56);

  return (
    <View>
      <View onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={`funnel chart: ${block.title}. Tap a stage to read its value.`}>
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          {block.series.map((p, i) => {
            const topW = maxW * (values[i] / max);
            const bottomValue = values[i + 1] ?? values[i] * 0.72;
            const bottomW = maxW * (bottomValue / max);
            const y = 8 + i * stageH;
            const gap = 2;
            const points = [
              `${center - topW / 2},${y}`,
              `${center + topW / 2},${y}`,
              `${center + bottomW / 2},${y + stageH - gap}`,
              `${center - bottomW / 2},${y + stageH - gap}`,
            ].join(" ");
            return (
              <G key={p.label} onPress={() => setSelected((prev) => (prev === i ? null : i))}>
                <Polygon points={points} fill={palette[i % palette.length]} opacity={selected === null || selected === i ? 1 : 0.45} />
                <SvgText x={center} y={y + stageH / 2 + 4} textAnchor="middle" fontSize={12} fontFamily={font.family.semi} fill={colors.onAccent}>
                  {shortLabel(p.label)}
                </SvgText>
              </G>
            );
          })}
        </Svg>
        {selected !== null && block.series[selected] ? (
          <Tooltip leftPct={50} title={block.series[selected].label} lines={[formatValue(block.series[selected].value, block.unit)]} />
        ) : null}
      </View>
      <Legend points={block.series} unit={block.unit} />
      <Text style={styles.hint}>Tap a stage to read its value.</Text>
    </View>
  );
}

function Legend({ points, unit }: { points: ChartPoint[]; unit?: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const palette = chartPalette(colors);
  return (
    <View style={styles.legend}>
      {points.map((p, i) => (
        <View key={p.label} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: palette[i % palette.length] }]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {p.label}
          </Text>
          <Text style={styles.legendValue}>{formatValue(p.value, unit)}</Text>
        </View>
      ))}
    </View>
  );
}

function chartPalette(colors: Colors): string[] {
  return [
    colors.chart.blue,
    colors.status.amberBright,
    colors.status.greenDot,
    colors.status.redDot,
    colors.chart.violet,
    colors.accent.sky,
    colors.accent.fuchsia,
    colors.accent.green,
    colors.accent.orange,
    colors.wire.faint,
  ];
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  hint: { marginTop: 6, fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted, textAlign: "center" },
  tip: {
    position: "absolute",
    top: 4,
    zIndex: 10,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.chart.tooltip,
  },
  tipTitle: { fontSize: 12, lineHeight: 16, fontFamily: font.family.semi, color: colors.chart.tooltipText },
  tipLine: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.chart.tooltipText },
  legend: { marginTop: 8, gap: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16, fontFamily: font.family.medium, color: colors.ink },
  legendValue: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted, fontVariant: ["tabular-nums"] },
});

import { StyleSheet, Text, View } from "react-native";
import type { ChartBlock as ChartBlockModel } from "@zavi/shared";
import { EmptyChart } from "../../analytics/Charts";
import { tipValue } from "../../../features/analytics/chart";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";
import { Card } from "../ui";
import { CartesianChart, FunnelChart, RadialChart } from "./charts/NativeChartPieces";
import { Provenance, ProvenanceFooter, seriesWindow } from "./charts/provenance";

function formatValue(value: number, unit: string | undefined): string {
  return tipValue(value, unit);
}

export function ChartBlock({ block }: { block: ChartBlockModel }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const isCartesian = block.variant === "bar" || block.variant === "line" || block.variant === "area";
  const hasCompare = isCartesian && (block.compare?.length ?? 0) > 0;
  const hasGoal = isCartesian && typeof block.goal === "number";
  const mainName = seriesWindow(block.series) ?? "This period";
  const compareWindow = seriesWindow(block.compare);

  return (
    <Card>
      <View style={styles.header}>
        <Text style={styles.title}>{block.title}</Text>
      </View>
      <Provenance block={block} />
      {hasCompare || hasGoal ? (
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendLine, { backgroundColor: block.colors?.series ?? colors.chart.blue }]} />
            <Text style={styles.legendText}>{mainName}</Text>
          </View>
          {hasCompare ? (
            <View style={styles.legendItem}>
              <View style={[styles.legendLine, { backgroundColor: colors.chart.seriesOther }]} />
              <Text style={styles.legendText}>{compareWindow ? `Compared with ${compareWindow}` : "Previous period"}</Text>
            </View>
          ) : null}
          {hasGoal && typeof block.goal === "number" ? (
            <View style={styles.legendItem}>
              <View style={[styles.legendLine, styles.goalLine]} />
              <Text style={styles.legendText}>{`Goal ${formatValue(block.goal, block.unit)}`}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {block.series.length === 0 ? (
        <EmptyChart height={160} text="No chart data yet." />
      ) : block.variant === "pie" || block.variant === "donut" ? (
        <RadialChart block={block} />
      ) : block.variant === "funnel" ? (
        <FunnelChart block={block} />
      ) : (
        <CartesianChart block={block} />
      )}
      <ProvenanceFooter verified={block.verified} receipt={block.receipt} />
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  header: { gap: 4 },
  title: { fontSize: 14, lineHeight: 18, fontFamily: font.family.semi, color: colors.ink },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendLine: { width: 18, height: 3, borderRadius: 2 },
  goalLine: { backgroundColor: colors.status.greenDot },
  legendText: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted },
});

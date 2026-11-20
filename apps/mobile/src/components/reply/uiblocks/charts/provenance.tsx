import { StyleSheet, Text, View } from "react-native";
import type { BlockReceipt, ChartBlock as ChartBlockModel } from "@zavi/shared";
import { agoText, formatStamp, formatWindow, sourceName } from "../../../../features/agents/receiptFormat";
import { font, space, type Colors } from "../../../../theme/tokens";
import { useStyles } from "../../../../theme/theme";

export function seriesWindow(points: ReadonlyArray<{ label: string }> | undefined): string | null {
  if (!points || points.length === 0) return null;
  const a = points[0].label;
  const b = points[points.length - 1].label;
  return /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) ? formatWindow({ since: a, until: b }) : null;
}

export function Provenance({ block }: { block: ChartBlockModel }) {
  const styles = useStyles(makeStyles);
  const receipt = block.receipt;
  const asOf = block.as_of ?? receipt?.fetched_at;
  const windowText = formatWindow(block.window ?? receipt?.window) ?? seriesWindow(block.series);
  const stamp = formatStamp(asOf);
  const ago = agoText(asOf);
  const source = sourceName(receipt?.source);

  if (!receipt && !asOf && !block.window) return null;

  return (
    <View style={styles.provenance} testID="chart-provenance">
      {receipt && source ? <ProvenanceItem label="Source" value={source} /> : null}
      {stamp ? <ProvenanceItem label="As of" value={`${stamp}${ago ? ` (${ago})` : ""}`} /> : null}
      {windowText ? <ProvenanceItem label="Window" value={`${windowText}${receipt?.tz ? `, ${receipt.tz}` : ""}`} /> : null}
    </View>
  );
}

export function ProvenanceFooter({ verified, receipt }: { verified?: boolean; receipt?: BlockReceipt }) {
  const styles = useStyles(makeStyles);
  if (verified === true && receipt) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerText}>{`Source: ${sourceName(receipt.source) ?? "Zavi"}`}</Text>
      </View>
    );
  }
  if (verified === false) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerText}>Zavi typed these numbers; no source returned them.</Text>
      </View>
    );
  }
  return null;
}

function ProvenanceItem({ label, value }: { label: string; value: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.item}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  provenance: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md, rowGap: 4 },
  item: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  label: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted },
  value: { fontSize: 12, lineHeight: 16, fontFamily: font.family.medium, color: colors.ink },
  footer: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.sm },
  footerText: { fontSize: 12, lineHeight: 16, fontFamily: font.family.regular, color: colors.muted },
});

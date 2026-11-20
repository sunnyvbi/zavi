import { StyleSheet, Text, View } from "react-native";
import type { KpiBlock as KpiBlockModel } from "@zavi/shared";
import { deltaTone, kpiChip, type KpiChip } from "../../../features/agents/kpiReceipt";
import { TileGrid } from "../../analytics/kit";
import { font, space, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";
import { Card } from "../ui";

function shown(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString() : value;
}

export function KpiBlock({ block }: { block: KpiBlockModel }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  return (
    <Card>
      <Text style={styles.title}>{block.title}</Text>
      <TileGrid>
        {block.items.map((item) => {
          const tone = deltaTone(item);
          const toneStyle =
            tone === "up"
              ? { color: colors.status.greenStrong }
              : tone === "down"
                ? { color: colors.status.redStrong }
                : null;
          const chip = kpiChip(item);
          return (
            <View key={item.label} style={styles.tile}>
              <Text style={styles.label} numberOfLines={1}>
                {item.label}
              </Text>
              <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
                {shown(item.value)}
              </Text>
              {item.delta ? (
                <Text style={[styles.delta, toneStyle]} numberOfLines={2}>
                  {item.delta}
                </Text>
              ) : null}
              {chip ? <ReceiptChip chip={chip} /> : null}
            </View>
          );
        })}
      </TileGrid>
    </Card>
  );
}

function ReceiptChip({ chip }: { chip: KpiChip }) {
  const styles = useStyles(makeStyles);
  const unverified = chip.kind === "unverified";
  return (
    <View
      style={[styles.chip, unverified && styles.chipUnverified]}
      accessibilityLabel={unverified ? "Unverified number: no source returned it" : `Source: ${chip.label}`}
    >
      <Text style={[styles.chipText, unverified && styles.chipTextUnverified]} numberOfLines={2}>
        {chip.label}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.soft,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.medium,
    color: colors.muted,
    textTransform: "uppercase",
  },
  value: {
    marginTop: 2,
    fontSize: 20,
    lineHeight: 26,
    fontFamily: font.family.semi,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  delta: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    color: colors.muted,
  },
  chip: {
    alignSelf: "flex-start",
    marginTop: space.xs,
    maxWidth: "100%",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    backgroundColor: colors.panel,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipUnverified: {
    borderColor: colors.status.amberLine,
    backgroundColor: colors.status.amberBg,
  },
  chipText: { fontSize: 12, lineHeight: 16, fontFamily: font.family.medium, color: colors.muted },
  chipTextUnverified: { fontFamily: font.family.semi, color: colors.status.amberText },
});

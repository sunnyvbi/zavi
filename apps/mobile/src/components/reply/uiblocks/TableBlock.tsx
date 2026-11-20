import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { TableBlock as TableBlockModel } from "@zavi/shared";
import { font, radius, space, type Colors } from "../../../theme/tokens";
import { useStyles } from "../../../theme/theme";
import { UnderlinedText } from "../../UnderlinedText";
import { Card } from "../ui";

const HTTPS_URL = /^https:\/\/\S+$/;

function isNumericCell(value: unknown): boolean {
  if (typeof value === "number") return true;
  return typeof value === "string" && /^[-+]?\$?\s?\d[\d,]*(\.\d+)?\s?%?$/.test(value.trim());
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && HTTPS_URL.test(value);
}

function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value);
}

export function TableBlock({ block }: { block: TableBlockModel }) {
  const styles = useStyles(makeStyles);
  const numericColumns = block.columns.map((_, index) =>
    block.rows.every((row) => row[index] == null || isNumericCell(row[index])) &&
    block.rows.some((row) => row[index] != null),
  );

  return (
    <Card>
      <Text style={styles.title}>{block.title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View style={styles.table}>
          <View style={[styles.row, styles.headerRow]}>
            {block.columns.map((column, index) => (
              <Text
                key={`${column}-${index}`}
                style={[styles.headerCell, numericColumns[index] && styles.numeric]}
                numberOfLines={2}
              >
                {column}
              </Text>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.row}>
              {block.columns.map((_, columnIndex) => {
                const value = row[columnIndex];
                if (isHttpsUrl(value)) {
                  return (
                    <Pressable
                      key={columnIndex}
                      style={({ pressed }) => [
                        styles.linkCell,
                        pressed && styles.linkCellPressed,
                      ]}
                      onPress={() => void WebBrowser.openBrowserAsync(value).catch(() => {})}
                      accessibilityRole="link"
                      accessibilityLabel="Open link"
                    >
                      <UnderlinedText style={styles.linkText}>open ↗</UnderlinedText>
                    </Pressable>
                  );
                }
                return (
                  <Text
                    key={columnIndex}
                    style={[styles.cell, numericColumns[columnIndex] && styles.numeric]}
                    numberOfLines={3}
                  >
                    {cellText(value)}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      {block.note ? <Text style={styles.note}>{block.note}</Text> : null}
    </Card>
  );
}

const CELL_WIDTH = 116;

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  table: {
    minWidth: "100%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
  },
  row: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.panel,
  },
  headerRow: {
    borderTopWidth: 0,
    backgroundColor: colors.soft,
  },
  headerCell: {
    width: CELL_WIDTH,
    paddingHorizontal: space.sm,
    paddingVertical: 7,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.medium,
    color: colors.muted,
    textTransform: "uppercase",
  },
  cell: {
    width: CELL_WIDTH,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    color: colors.ink,
  },
  numeric: {
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  linkCell: {
    width: CELL_WIDTH,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
    alignItems: "flex-start",
  },
  linkCellPressed: {
    opacity: 0.7,
  },
  linkText: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: font.family.semi,
    color: colors.ink,
  },
  note: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    color: colors.muted,
  },
});

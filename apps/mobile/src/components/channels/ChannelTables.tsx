import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../Icon";
import { TextLink } from "../growth/StoryKit";
import type { ChannelTable, RowAction, TableCell, TableRow } from "../../features/channels/channelTables";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const open = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));

export type RunAction = (action: RowAction) => Promise<string | null>;

function Cell({ cell, right }: { cell: TableCell; right: boolean }) {
  const styles = useStyles(makeStyles);
  const text = cell.chip ? (
    <Text numberOfLines={1} style={[styles.chip, cell.chip === "good" ? styles.chipGood : cell.chip === "warn" ? styles.chipWarn : cell.chip === "bad" ? styles.chipBad : styles.chipMuted]}>{cell.text}</Text>
  ) : cell.href ? (
    <Pressable onPress={() => open(cell.href as string)} accessibilityRole="link" hitSlop={4}>
      <Text style={styles.link} numberOfLines={2}>
        {cell.text}
      </Text>
    </Pressable>
  ) : (
    <Text style={[styles.text, cell.strong && styles.strong, cell.dim && styles.dim, cell.bad && styles.badText, right && styles.right]}>{cell.text}</Text>
  );
  return (
    <>
      {text}
      {cell.meter ? (
        <View style={styles.meterTrack}>
          <View style={[styles.meterFill, { width: `${Math.max(0, Math.min(100, (cell.meter.value / cell.meter.max) * 100))}%` }]} />
        </View>
      ) : null}
      {cell.sub ? <Text style={[styles.sub, right && styles.right]}>{cell.sub}</Text> : null}
    </>
  );
}

function RowExtras({ row, onRun }: { row: TableRow; onRun?: RunAction }) {
  const styles = useStyles(makeStyles);
  const [openDetail, setOpenDetail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!row.detail && !(row.actions?.length && onRun)) return null;
  const run = async (a: RowAction) => {
    if (!onRun || busy) return;
    setBusy(a.id);
    setError(null);
    const err = await onRun(a);
    setBusy(null);
    if (err) setError(err);
  };
  return (
    <View style={styles.extras}>
      <View style={styles.extraRow}>
        {row.detail ? <TextLink label={openDetail ? row.detail.closeLabel : row.detail.openLabel} expanded={openDetail} onPress={() => setOpenDetail((v) => !v)} /> : null}
        {onRun
          ? row.actions?.map((a) => <TextLink key={a.id} label={busy === a.id ? a.busyLabel : error ? "Try again" : a.label} disabled={!!busy} onPress={() => void run(a)} accessibilityLabel={a.label} />)
          : null}
      </View>
      {openDetail && row.detail ? (
        <View style={styles.detail}>
          {row.detail.title ? <Text style={styles.strong}>{row.detail.title}</Text> : null}
          <Text style={styles.detailText}>{row.detail.text}</Text>
        </View>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const MIN_FIRST = 90;

function FirstCell({ cell }: { cell: TableCell }) {
  const styles = useStyles(makeStyles);
  const [more, setMore] = useState(false);
  const long = (cell.sub?.length ?? 0) > 170;
  return (
    <Pressable disabled={!long} onPress={() => setMore((v) => !v)} accessibilityRole={long ? "button" : undefined} accessibilityState={long ? { expanded: more } : undefined}>
      <Cell cell={{ ...cell, sub: undefined }} right={false} />
      {cell.sub ? (
        <Text style={styles.sub} numberOfLines={long && !more ? 5 : undefined}>
          {cell.sub}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function ChannelTableCard({ table, onRun }: { table: ChannelTable; onRun?: RunAction }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [boxWidth, setBoxWidth] = useState(0);
  const rest = table.columns.slice(1).reduce((n, c) => n + c.width, 0);
  const first = Math.max(MIN_FIRST, table.columns[0]?.width ?? 0, boxWidth - rest);
  const widthOf = (i: number) => (i === 0 ? first : table.columns[i]?.width ?? 80);
  const withExtras = table.rows.filter((r) => r.detail || r.actions?.length);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name={table.icon} size={16} color={colors.ink} />
        <Text style={styles.title}>{table.title}</Text>
      </View>
      {table.rows.length === 0 ? (
        <Text style={styles.empty}>{table.empty}</Text>
      ) : (
        <View onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false} style={styles.bleed} contentContainerStyle={styles.bleedInner}>
            <View style={styles.grid}>
              <View style={[styles.gridRow, styles.gridHead]}>
                {table.columns.map((c, i) => (
                  <View key={c.label} style={[styles.cell, i === 0 && styles.cellFirst, { width: widthOf(i) }]}>
                    <Text style={[styles.headText, c.right && styles.right]}>{c.label}</Text>
                  </View>
                ))}
              </View>
              {table.rows.map((r) => (
                <View key={r.id} style={[styles.gridRow, styles.rowDivider]}>
                  {r.cells.map((c, i) => (
                    <View key={i} style={[styles.cell, i === 0 && styles.cellFirst, { width: widthOf(i) }]}>
                      {i === 0 ? <FirstCell cell={c} /> : <Cell cell={c} right={!!table.columns[i]?.right} />}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}
      {withExtras.map((r) => (
        <View key={r.id} style={styles.rowExtras}>
          <Text style={styles.extrasFor} numberOfLines={1}>
            {r.cells[0]?.text}
          </Text>
          <RowExtras row={r} onRun={onRun} />
        </View>
      ))}
      {table.caption ? <Text style={styles.sub}>{table.caption}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.md, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    head: { flexDirection: "row", alignItems: "center", gap: space.sm },
    title: { flex: 1, fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    empty: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted },
    bleed: { marginHorizontal: -space.lg },
    bleedInner: { paddingHorizontal: space.lg },
    grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden", alignSelf: "flex-start" },
    gridRow: { flexDirection: "row" },
    gridHead: { backgroundColor: colors.soft },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    cell: { paddingHorizontal: 6, paddingVertical: 9, gap: 3 },
    cellFirst: { paddingLeft: 10 },
    headText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    right: { textAlign: "right" },
    text: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    strong: { fontFamily: font.family.semi },
    dim: { color: colors.muted },
    badText: { color: colors.status.redText },
    link: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    chip: { alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden", fontFamily: font.family.semi, fontSize: 11 },
    chipGood: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    chipWarn: { backgroundColor: colors.status.amberBg, color: colors.status.amberText },
    chipBad: { backgroundColor: colors.status.redBg, color: colors.status.redText },
    chipMuted: { backgroundColor: colors.soft, color: colors.textSecondary },
    meterTrack: { height: 5, borderRadius: 3, backgroundColor: colors.soft, overflow: "hidden" },
    meterFill: { height: 5, borderRadius: 3, backgroundColor: colors.status.greenDot },
    rowExtras: { gap: 2, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    extrasFor: { fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    extras: { gap: 4 },
    extraRow: { flexDirection: "row", flexWrap: "wrap", gap: space.lg },
    detail: { gap: 2, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    detailText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    error: { fontFamily: font.family.medium, fontSize: 12, lineHeight: 17, color: colors.red },
  });

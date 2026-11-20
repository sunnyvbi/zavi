import { createContext, Fragment, useContext } from "react";
import { Alert, Clipboard, ScrollView, StyleSheet, Text, View } from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { splitLinks } from "../lib/inlineLinks";
import { columnWidth, parseMarkdown } from "../lib/markdownBlocks";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

function open(href: string) {
  WebBrowser.openBrowserAsync(href).catch(() =>
    Alert.alert("Couldn't open link", "Try again in a moment."),
  );
}

export const LinkCopiedContext = createContext<((message: string) => void) | null>(null);

function Linked({ text }: { text: string }) {
  const styles = useStyles(makeStyles);
  const showToast = useContext(LinkCopiedContext);
  function copy(href: string) {
    Clipboard.setString(href);
    showToast?.("Link copied");
  }
  return (
    <>
      {splitLinks(text).map((seg, i) =>
        seg.href ? (
          <Text
            key={i}
            style={styles.link}
            onPress={() => open(seg.href as string)}
            onLongPress={() => copy(seg.href as string)}
            accessibilityRole="link"
          >
            {seg.text}
          </Text>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

function Inline({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const styles = useStyles(makeStyles);
  const parts = text.split("**");
  if (parts.length % 2 === 0) {
    return (
      <Text style={style}>
        <Linked text={text} />
      </Text>
    );
  }
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.bold}>
            <Linked text={p} />
          </Text>
        ) : (
          <Linked key={i} text={p} />
        ),
      )}
    </Text>
  );
}

export function Markdown({ body, tableBleed = 0 }: { body: string; tableBleed?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View>
      {parseMarkdown(body).map((b, i) => {
        if (b.kind === "rule") return <View key={i} style={styles.rule} />;
        if (b.kind === "table") return <Table key={i} header={b.header} rows={b.rows} bleed={tableBleed} />;
        if (b.kind === "heading") {
          const size = b.level === 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3;
          return <Inline key={i} text={b.text} style={[styles.heading, size]} />;
        }
        if (b.kind === "bullet") {
          return (
            <View key={i} style={styles.bulletRow}>
              <Text style={styles.dot}>{"•"}</Text>
              <Inline text={b.text} style={styles.bulletText} />
            </View>
          );
        }
        return <Inline key={i} text={b.text} style={styles.paragraph} />;
      })}
    </View>
  );
}

function Table({ header, rows, bleed }: { header: string[]; rows: string[][]; bleed: number }) {
  const styles = useStyles(makeStyles);
  const widths = header.map((h, c) => columnWidth([h, ...rows.map((r) => r[c] ?? "")]));
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.tableScroll, { marginHorizontal: -bleed }]}
      contentContainerStyle={{ paddingHorizontal: bleed }}
    >
      <View style={styles.table}>
        {[header, ...rows].map((row, r) => (
          <View key={r} style={[styles.tableRow, r === 0 && styles.tableHead, r > 0 && styles.tableDivider]}>
            {row.map((cell, c) => (
              <View key={c} style={[styles.tableCell, { width: widths[c] }, c > 0 && styles.tableCellDivider]}>
                <Inline text={cell} style={r === 0 ? styles.tableHeadText : styles.tableText} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) => {
  const bodyText = {
    fontSize: 16,
    lineHeight: 24,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.ink,
  } as const;

  return StyleSheet.create({
    paragraph: { ...bodyText, marginTop: space.md },
    bold: { fontFamily: font.family.semi, includeFontPadding: false },
    link: { color: colors.blue, textDecorationLine: "underline" },
    heading: { fontFamily: font.family.semi, includeFontPadding: false, color: colors.ink, marginTop: space.lg },
    h1: { fontSize: 20, lineHeight: 26 },
    h2: { fontSize: 18, lineHeight: 24 },
    h3: { fontSize: 16, lineHeight: 22 },
    bulletRow: { flexDirection: "row", marginTop: space.sm },
    dot: { ...bodyText, width: 16, color: colors.muted },
    bulletText: { ...bodyText, flex: 1 },
    rule: { height: 1, backgroundColor: colors.line, marginVertical: space.lg },
    tableScroll: { marginTop: space.md },
    table: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
    tableRow: { flexDirection: "row" },
    tableHead: { backgroundColor: colors.soft },
    tableDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    tableCell: { paddingHorizontal: 10, paddingVertical: 8 },
    tableCellDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    tableText: { fontSize: 14, lineHeight: 20, fontFamily: font.family.regular, includeFontPadding: false, color: colors.ink },
    tableHeadText: { fontSize: 14, lineHeight: 20, fontFamily: font.family.semi, includeFontPadding: false, color: colors.ink },
  });
};

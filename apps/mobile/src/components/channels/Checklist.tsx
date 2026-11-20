import { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../Icon";
import { TextLink } from "../growth/StoryKit";
import type { ChecklistRow, XChecklist } from "../../features/channels/xChecklist";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const open = (url: string) => void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));

function CheckRow({ row }: { row: ChecklistRow }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const [why, setWhy] = useState(false);
  const fix = row.fix;
  return (
    <View style={styles.row}>
      <View style={styles.main}>
        <Text style={styles.label}>{row.label}</Text>
        {row.status === "pass" && row.note ? <Text style={styles.note}>{row.note}</Text> : null}
        {why && row.status !== "pass" ? (
          <View style={styles.why}>
            <Text style={styles.strong}>{row.status === "fix" ? "Why this is on your list" : "Why there is no answer yet"}</Text>
            <Text style={styles.note}>{row.note}</Text>
          </View>
        ) : null}
        {row.status !== "pass" || fix ? (
          <View style={styles.actions}>
            {row.status !== "pass" ? <TextLink label={why ? "Hide" : "Why"} expanded={why} onPress={() => setWhy((v) => !v)} accessibilityLabel={`${why ? "Hide" : "Why"}: ${row.label}`} /> : null}
            {fix ? (
              <TextLink
                label={fix.label}
                accessibilityLabel={fix.kind === "link" ? `Open X to fix: ${row.label}` : `Ask Zavi to help fix: ${row.label}`}
                onPress={() => (fix.kind === "link" ? open(fix.url) : router.push({ pathname: "/chat", params: { prefill: fix.draft, back: "1" } }))}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <Text style={[styles.badge, row.status === "pass" ? styles.good : row.status === "fix" ? styles.warn : styles.muted]}>{row.statusLabel}</Text>
    </View>
  );
}

export function ChecklistCard({ title, checklist }: { title: string; checklist: XChecklist }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [showPassing, setShowPassing] = useState(false);
  const passing = checklist.rows.filter((r) => r.status === "pass");
  const shown = showPassing ? checklist.rows : checklist.rows.filter((r) => r.status !== "pass");
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="check" size={16} color={colors.ink} />
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      {checklist.rows.length === 0 ? <Text style={styles.note}>{checklist.empty}</Text> : null}
      {checklist.rows.length > 0 && shown.length === 0 ? <Text style={styles.note}>Every check passes.</Text> : null}
      {shown.map((r) => (
        <CheckRow key={r.key} row={r} />
      ))}
      {passing.length > 0 ? (
        <TextLink label={showPassing ? "Hide passing" : `Show ${passing.length} passing`} expanded={showPassing} onPress={() => setShowPassing((v) => !v)} />
      ) : null}
      {checklist.caption ? <Text style={styles.small}>{checklist.caption}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.md, padding: space.lg, gap: 6, borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel },
    cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    cardTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 8, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    main: { flex: 1, minWidth: 0, gap: 2 },
    badge: { marginTop: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: "hidden", fontFamily: font.family.semi, fontSize: 11 },
    good: { backgroundColor: colors.status.greenBg, color: colors.status.greenText },
    warn: { backgroundColor: colors.status.amberBg, color: colors.status.amberText },
    muted: { backgroundColor: colors.panel, color: colors.textSecondary },
    label: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 19, color: colors.ink },
    note: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    strong: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    why: { gap: 2, marginTop: 2 },
    actions: { flexDirection: "row", gap: space.lg },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
  });

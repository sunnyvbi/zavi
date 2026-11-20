import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { RunTone } from "../../features/agentBuilder/logic";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function StatusPill({ paused }: { paused: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tint = paused ? colors.muted : colors.green;
  return (
    <View style={[styles.pill, { backgroundColor: paused ? colors.soft : colors.green + "1F" }]}>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text style={[styles.pillText, { color: tint }]}>{paused ? "Paused" : "Active"}</Text>
    </View>
  );
}

export function useToneColor(): (tone: RunTone) => string {
  const { colors } = useTheme();
  return (tone) => (tone === "done" ? colors.green : tone === "failed" ? colors.red : tone === "muted" ? colors.muted : colors.ink);
}

export function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {aside ? <Text style={styles.small}>{aside}</Text> : null}
      {children}
    </View>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {typeof children === "string" ? <Text style={styles.body}>{children}</Text> : children}
    </View>
  );
}

export function Notice({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.notice}>{children}</Text>;
}

export const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      paddingHorizontal: space.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
    },
    dot: { width: 6, height: 6, borderRadius: 3 },
    pillText: { fontSize: font.size.sm, fontFamily: font.family.semi },
    section: {
      marginTop: space.lg,
      padding: space.lg,
      gap: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.panel,
    },
    sectionTitle: { fontSize: 16, fontFamily: font.family.semi, color: colors.ink },
    field: { gap: 2, paddingVertical: space.xs },
    fieldLabel: { fontSize: font.size.md, fontFamily: font.family.regular, color: colors.muted },
    body: { fontSize: font.size.base, lineHeight: 21, fontFamily: font.family.regular, color: colors.ink },
    small: { fontSize: font.size.md, lineHeight: 18, fontFamily: font.family.regular, color: colors.muted },
    notice: {
      marginTop: space.md,
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
      fontSize: font.size.md,
      lineHeight: 19,
      fontFamily: font.family.regular,
      color: colors.ink,
    },
  });

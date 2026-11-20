import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoider } from "../KeyboardAvoider";
import { useKeyboardOpen } from "../useKeyboardReveal";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function SetupFrame({ header, footer, children }: { header: ReactNode; footer: ReactNode; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  return (
    <KeyboardAvoider style={styles.flex}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {header}
        {children}
      </ScrollView>
      <View
        style={[styles.footer, { paddingBottom: keyboardOpen ? 20 : space.md + insets.bottom }]}
        accessibilityLabel="Step actions"
      >
        {footer}
      </View>
    </KeyboardAvoider>
  );
}

export function FooterRow({ note, children }: { note?: string | null; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.footerInner}>
      {note ? (
        <Text style={styles.note} numberOfLines={2}>
          {note}
        </Text>
      ) : null}
      <View style={styles.row}>{children}</View>
    </View>
  );
}

export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.pill, tone === "ok" ? styles.pillOk : tone === "warn" ? styles.pillWarn : styles.pillNeutral]}>
      <Text
        style={[styles.pillText, tone === "ok" ? styles.pillTextOk : tone === "warn" ? styles.pillTextWarn : styles.pillTextNeutral]}
        numberOfLines={2}
      >
        {label}
      </Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.section} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function FieldLabel({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.label}>{children}</Text>;
}

export function Hint({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.hint}>{children}</Text>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    body: { paddingHorizontal: space.lg, paddingVertical: 20 },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      backgroundColor: colors.bg,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
    },
    footerInner: { gap: space.sm },
    note: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.muted },
    row: { flexDirection: "row", gap: space.sm },
    chip: {
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.line,
      paddingHorizontal: space.md,
      paddingVertical: 7,
    },
    chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    chipText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    chipTextOn: { color: colors.onInk },
    pressed: { opacity: 0.8 },
    pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, maxWidth: 170 },
    pillOk: { backgroundColor: colors.status.greenBg },
    pillWarn: { backgroundColor: colors.status.amberBg },
    pillNeutral: { backgroundColor: colors.soft },
    pillText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16 },
    pillTextOk: { color: colors.status.greenText },
    pillTextWarn: { color: colors.status.amberText },
    pillTextNeutral: { color: colors.textSecondary },
    section: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    label: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.textSecondary, marginBottom: space.sm },
    hint: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary, marginTop: 6 },
  });

import type { ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { BackIcon, Icon } from "../Icon";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const WEB_UGC = "https://www.zaviagent.com/workspace?tab=channels&channel=ugc";

export function openOnWeb(): void {
  void Linking.openURL(WEB_UGC).catch(() => {});
}

export function UgcScreen({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topBar}>
        <Pressable
          style={styles.headerButton}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/channels"))}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <BackIcon color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.headerButton}>{right}</View>
      </View>
      {children}
    </SafeAreaView>
  );
}

export function CreatorAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

export function Chip({ label, tone = "soft" }: { label: string; tone?: "soft" | "alert" }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.chip, tone === "alert" && styles.chipAlert]}>
      <Text style={[styles.chipText, tone === "alert" && styles.chipAlertText]}>{label}</Text>
    </View>
  );
}

export function StateLine({
  loading,
  error,
  empty,
  onRetry,
}: {
  loading?: boolean;
  error?: boolean;
  empty?: string;
  onRetry?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (loading) {
    return (
      <View style={styles.state} accessibilityState={{ busy: true }}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.state} accessibilityRole="alert">
        <Text style={styles.stateText}>Couldn't load this.</Text>
        {onRetry ? (
          <Pressable style={styles.stateButton} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.stateButtonText}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return empty ? (
    <View style={styles.state}>
      <Text style={styles.stateText}>{empty}</Text>
    </View>
  ) : null;
}

export function CardFooter({
  primary,
  secondary = [],
  dismiss,
  askAbout,
  disabled = false,
}: {
  primary?: { label: string; onPress: () => void };
  secondary?: Array<{ label: string; onPress: () => void }>;
  dismiss?: { label: string; onPress: () => void };
  askAbout: string;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  return (
    <View style={styles.footer}>
      {primary ? (
        <Pressable
          style={[styles.footPrimary, disabled && styles.footDisabled]}
          onPress={primary.onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={primary.label}
        >
          <Text style={styles.footPrimaryText}>{primary.label}</Text>
        </Pressable>
      ) : null}
      {secondary.map((b) => (
        <Pressable
          key={b.label}
          style={[styles.footSecondary, disabled && styles.footDisabled]}
          onPress={b.onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={b.label}
        >
          <Text style={styles.footSecondaryText}>{b.label}</Text>
        </Pressable>
      ))}
      {dismiss ? (
        <Pressable style={styles.footText} onPress={dismiss.onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={dismiss.label}>
          <Text style={styles.footTextLabel}>{dismiss.label}</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={styles.footText}
        onPress={() => router.push({ pathname: "/chat", params: { prefill: `About "${askAbout}": `, back: "1" } })}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Ask Zavi"
      >
        <Text style={styles.footTextLabel}>Ask Zavi</Text>
      </Pressable>
    </View>
  );
}

export function WebHandoff({ label }: { label: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.handoff} onPress={openOnWeb} accessibilityRole="link" accessibilityLabel={label}>
      <Text style={styles.handoffText}>{label}</Text>
      <Text style={styles.handoffArrow}>↗</Text>
    </Pressable>
  );
}

export function UgcButton({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  busy = false,
  busyLabel,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  accessibilityLabel?: string;
}) {
  const styles = useStyles(makeStyles);
  const off = disabled || busy;
  return (
    <Pressable
      style={({ pressed }) => [variant === "primary" ? styles.btnPrimary : styles.btnSecondary, off && styles.footDisabled, pressed && !off && styles.btnPressed]}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy }}
    >
      <Text style={variant === "primary" ? styles.btnPrimaryText : styles.btnSecondaryText}>{busy && busyLabel ? busyLabel : label}</Text>
    </Pressable>
  );
}

export function Note({ tone = "plain", title, children }: { tone?: "plain" | "warn" | "bad" | "ok"; title?: string; children?: ReactNode }) {
  const styles = useStyles(makeStyles);
  const box = tone === "warn" ? styles.noteWarn : tone === "bad" ? styles.noteBad : tone === "ok" ? styles.noteOk : styles.notePlain;
  const text = tone === "warn" ? styles.noteWarnText : tone === "bad" ? styles.noteBadText : tone === "ok" ? styles.noteOkText : styles.notePlainText;
  return (
    <View style={[styles.note, box]} accessibilityRole={tone === "bad" ? "alert" : undefined}>
      {title ? <Text style={[styles.noteTitle, text]}>{title}</Text> : null}
      {typeof children === "string" ? <Text style={[styles.noteBody, text]}>{children}</Text> : children}
    </View>
  );
}

export function ErrorText({ children }: { children: string | null | undefined }) {
  const styles = useStyles(makeStyles);
  if (!children) return null;
  return (
    <Text style={styles.errorText} accessibilityRole="alert">
      {children}
    </Text>
  );
}

export function KeyValue({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.kv}>
      <Text style={strong ? styles.kvLabelStrong : styles.kvLabel}>{label}</Text>
      <Text style={strong ? styles.kvValueStrong : styles.kvValue}>{value}</Text>
    </View>
  );
}

export function ReadOnlyNote() {
  return <Note>Your role is read-only. Ask a workspace admin to make you a member.</Note>;
}

export type ChipTone = "neutral" | "ok" | "warn" | "bad" | "info" | "zinc" | "green" | "amber" | "red" | "blue";
const CHIP_TONE: Record<ChipTone, "neutral" | "ok" | "warn" | "bad" | "info"> = {
  neutral: "neutral",
  zinc: "neutral",
  ok: "ok",
  green: "ok",
  warn: "warn",
  amber: "warn",
  bad: "bad",
  red: "bad",
  info: "info",
  blue: "info",
};

export function ToneChip({ label, tone }: { label: string; tone: ChipTone }) {
  const styles = useStyles(makeStyles);
  const t = CHIP_TONE[tone] ?? "neutral";
  const [box, text] =
    t === "ok"
      ? [styles.toneOk, styles.toneOkText]
      : t === "warn"
        ? [styles.toneWarn, styles.toneWarnText]
        : t === "bad"
          ? [styles.toneBad, styles.toneBadText]
          : t === "info"
            ? [styles.toneInfo, styles.toneInfoText]
            : [styles.toneNeutral, styles.toneNeutralText];
  return (
    <View style={[styles.tone, box]}>
      <Text style={[styles.toneText, text]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Caps({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.caps}>{children}</Text>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    topBar: {
      height: 64,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
    headerTitle: {
      flex: 1,
      marginHorizontal: space.xs,
      includeFontPadding: false,
      fontFamily: font.family.semi,
      fontSize: 18,
      lineHeight: 24,
      textAlign: "center",
      color: colors.ink,
    },
    avatar: { alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
    avatarText: { fontFamily: font.family.semi, color: colors.ink },
    chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.soft },
    chipText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 11, color: colors.muted },
    chipAlert: { backgroundColor: colors.ink },
    chipAlertText: { fontFamily: font.family.semi, color: colors.onInk },
    state: { alignItems: "center", paddingHorizontal: space.lg, paddingTop: 40, gap: 14 },
    stateText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted, textAlign: "center" },
    stateButton: {
      minHeight: 36,
      paddingHorizontal: 12,
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 8,
    },
    stateButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    footer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.line, alignSelf: "stretch" },
    footPrimary: { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 8, backgroundColor: colors.ink },
    footPrimaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.onInk },
    footSecondary: { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: colors.line },
    footSecondaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    footText: { minHeight: 36, paddingHorizontal: 6, justifyContent: "center" },
    footTextLabel: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    footDisabled: { opacity: 0.4 },
    handoff: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
    },
    handoffText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    handoffArrow: { fontFamily: font.family.regular, fontSize: 14, color: colors.muted },
    btnPrimary: { minHeight: 44, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.ink },
    btnSecondary: { minHeight: 44, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    btnPrimaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.onInk, textAlign: "center" },
    btnSecondaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink, textAlign: "center" },
    btnPressed: { opacity: 0.8 },
    note: { alignSelf: "stretch", gap: 4, padding: space.md, borderRadius: radius.sm, borderWidth: 1 },
    notePlain: { backgroundColor: colors.soft, borderColor: colors.soft },
    noteWarn: { backgroundColor: colors.status.amberBg, borderColor: colors.status.amberLine },
    noteBad: { backgroundColor: colors.status.redBg, borderColor: colors.status.redLine },
    noteOk: { backgroundColor: colors.status.greenBg, borderColor: colors.status.greenBg },
    noteTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18 },
    noteBody: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18 },
    notePlainText: { color: colors.textSecondary },
    noteWarnText: { color: colors.status.amberText },
    noteBadText: { color: colors.status.redText },
    noteOkText: { color: colors.status.greenText },
    errorText: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.red },
    kv: { alignSelf: "stretch", flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
    kvLabel: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    kvValue: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
    kvLabelStrong: { flex: 1, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
    kvValueStrong: { fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
    tone: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
    toneText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, lineHeight: 16 },
    toneNeutral: { backgroundColor: colors.soft },
    toneNeutralText: { color: colors.textSecondary },
    toneOk: { backgroundColor: colors.status.greenBg },
    toneOkText: { color: colors.status.greenText },
    toneWarn: { backgroundColor: colors.status.amberBg },
    toneWarnText: { color: colors.status.amberText },
    toneBad: { backgroundColor: colors.status.redBg },
    toneBadText: { color: colors.status.redText },
    toneInfo: { backgroundColor: colors.avatarBlue },
    toneInfoText: { color: colors.blue },
    caps: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, letterSpacing: 0.6, textTransform: "uppercase", color: colors.muted },
  });

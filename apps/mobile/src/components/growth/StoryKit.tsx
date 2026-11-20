import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SkeletonBlock } from "../Skeleton";
import { UnderlinedText } from "../UnderlinedText";
import type { ChipTone } from "../../features/growth/story";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function StoryStep({
  n,
  title,
  aside,
  needs,
  children,
  onLayoutY,
}: {
  n: number;
  title: string;
  aside?: ReactNode;
  needs?: boolean;
  children: ReactNode;
  onLayoutY?: (y: number) => void;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View
      style={styles.step}
      accessibilityRole="summary"
      accessibilityLabel={title}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
    >
      <View style={styles.stepHead}>
        <View style={[styles.stepNumber, needs && styles.stepNumberNeeds]}>
          <Text style={[styles.stepNumberText, needs && styles.stepNumberTextNeeds]}>{n}</Text>
        </View>
        <Text style={styles.stepTitle} accessibilityRole="header">
          {title}
        </Text>
        {aside ? (typeof aside === "string" ? <Text style={styles.asideText}>{aside}</Text> : aside) : null}
      </View>
      <View style={styles.stepBody}>{children}</View>
    </View>
  );
}

export function StoryBecause({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.because} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={styles.becauseText}>{children}</Text>
    </View>
  );
}

export function StoryBox({ children, tone }: { children: ReactNode; tone?: "needs" }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.box, tone === "needs" && styles.boxNeeds]}>{children}</View>;
}

export function StoryRow({ children, first, style }: { children: ReactNode; first?: boolean; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.row, !first && styles.rowRule, style]}>{children}</View>;
}

export function StatusChip({ tone, children }: { tone: ChipTone; children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.chip, styles[`chip_${tone}`]]}>
      <Text style={[styles.chipText, styles[`chipText_${tone}`]]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

export function TextLink({
  label,
  onPress,
  expanded,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  expanded?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.link, pressed && styles.pressed, disabled && styles.disabled]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ expanded, disabled: !!disabled }}
    >
      <UnderlinedText style={styles.linkText}>{label}</UnderlinedText>
    </Pressable>
  );
}

export function ActionButton({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  busyLabel,
  grow,
  compact,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  grow?: boolean;
  compact?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" ? styles.buttonPrimary : styles.buttonSecondary,
        grow && styles.buttonGrow,
        compact && styles.buttonCompact,
        pressed && !off && styles.buttonPressed,
        disabled && styles.disabled,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
    >
      <Text style={[styles.buttonText, compact && styles.buttonTextCompact, variant === "primary" ? styles.buttonTextPrimary : styles.buttonTextSecondary]}>
        {busy ? busyLabel ?? label : label}
      </Text>
    </Pressable>
  );
}

export function ErrorLine({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.errorLine} accessibilityRole="alert">
      {children}
    </Text>
  );
}

export function Eyebrow({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.eyebrow}>{children.toUpperCase()}</Text>;
}

export function FactRow({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fact}>
      <View style={styles.factHead}>
        <Text style={styles.factLabel} accessibilityRole="header">
          {label}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

export function SubLabel({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.subLabel}>{children}</Text>;
}

export function AlertLine({ children, right }: { children: string; right?: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.alertRow} accessibilityRole="alert">
      <Text style={styles.alertText}>{children}</Text>
      {right}
    </View>
  );
}

export function Bars({ label, lines = 2, height = 14 }: { label: string; lines?: number; height?: number }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.bars} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBlock key={i} height={height} width={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
    </View>
  );
}

export function GoalBar({ pct, label }: { pct: number | null; label: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={pct === null ? { text: "Not counted yet" } : { min: 0, max: 100, now: pct }}
    >
      {pct !== null ? <View style={[styles.fill, { width: `${Math.max(pct, 2)}%` }]} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    step: { marginTop: 4 },
    stepHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.ink,
      alignItems: "center",
      justifyContent: "center",
    },
    stepNumberNeeds: { backgroundColor: colors.status.amberDot },
    stepNumberText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.onInk },
    stepNumberTextNeeds: { color: colors.onAccent },
    stepTitle: { flex: 1, fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, includeFontPadding: false, color: colors.ink },
    aside: { marginTop: 6, marginLeft: 32, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
    asideText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    stepBody: { marginTop: space.md },
    because: { marginVertical: space.lg, marginLeft: 11 },
    becauseText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    box: { borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.panel, overflow: "hidden" },
    boxNeeds: { backgroundColor: colors.approvalBg, borderColor: colors.approvalBorder },
    row: { paddingHorizontal: space.lg, paddingVertical: 14 },
    rowRule: { borderTopWidth: 1, borderTopColor: colors.line },
    chip: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, maxWidth: 200 },
    chipText: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false },
    chip_good: { backgroundColor: colors.status.greenBg },
    chipText_good: { color: colors.status.greenText },
    chip_bad: { backgroundColor: colors.status.redBg },
    chipText_bad: { color: colors.status.redText },
    chip_wait: { backgroundColor: colors.status.amberBg },
    chipText_wait: { color: colors.status.amberText },
    chip_live: { backgroundColor: colors.soft },
    chipText_live: { color: colors.blue },
    chip_quiet: { backgroundColor: colors.soft },
    chipText_quiet: { color: colors.muted },
    link: { alignSelf: "flex-start", paddingVertical: 2 },
    linkText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.4 },
    button: { minHeight: 48, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
    buttonGrow: { flex: 1 },
    buttonCompact: { minHeight: 34, borderRadius: 10, paddingHorizontal: space.md },
    buttonTextCompact: { fontSize: 13, lineHeight: 16 },
    buttonPrimary: { backgroundColor: colors.ink },
    buttonSecondary: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised },
    buttonPressed: { opacity: 0.8 },
    buttonText: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, includeFontPadding: false },
    buttonTextPrimary: { color: colors.onInk },
    buttonTextSecondary: { color: colors.ink },
    errorLine: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.red },
    eyebrow: { fontFamily: font.family.semi, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted, letterSpacing: 0.4 },
    fact: { paddingVertical: space.lg, borderTopWidth: 1, borderTopColor: colors.line, gap: space.sm },
    factHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
    factLabel: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    subLabel: { marginTop: space.sm, fontFamily: font.family.medium, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: colors.muted },
    alertRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.sm },
    alertText: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.status.amberText },
    bars: { gap: 10, paddingVertical: 4 },
    track: { height: 6, borderRadius: radius.pill, backgroundColor: colors.soft, overflow: "hidden" },
    fill: { height: 6, borderRadius: radius.pill, backgroundColor: colors.status.greenDot },
  });

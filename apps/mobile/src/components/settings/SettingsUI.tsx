import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackIcon, Icon, type IconName } from "../Icon";
import { ErrorCard } from "../ErrorCard";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const TOAST_HIDE_AFTER_MS = 2200;

export function BackHeader({ title, right }: { title: string; right?: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <View style={styles.header}>
      <Pressable
        style={[styles.headerButton, styles.headerBackButton]}
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <BackIcon color={colors.wire.ink} />
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.headerRightSlot}>{right}</View>
    </View>
  );
}

export function SectionLabel({
  children,
  first,
  right,
}: {
  children: string;
  first?: boolean;
  right?: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.sectionRow, !first && styles.sectionAfterGroup]}>
      <Text style={styles.section}>{children}</Text>
      {right}
    </View>
  );
}

export function ListGroup({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.group}>
      <View style={styles.groupClip}>{children}</View>
    </View>
  );
}

export function Badge({ tone, children }: { tone: "ink" | "neutral" | "amber"; children: string }) {
  const styles = useStyles(makeStyles);
  const toneStyle = tone === "ink" ? styles.badgeInk : tone === "amber" ? styles.badgeAmber : styles.badgeNeutral;
  return (
    <View style={[styles.badge, toneStyle]}>
      <Text
        style={[
          styles.badgeText,
          tone === "ink" ? styles.badgeTextInk : tone === "amber" ? styles.badgeTextAmber : styles.badgeTextNeutral,
        ]}
        numberOfLines={1}
      >
        {children}
      </Text>
    </View>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && !selected && styles.segmentPressed,
            ]}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, checked: selected }}
          >
            <Text style={[styles.segmentText, selected ? styles.segmentTextSelected : styles.segmentTextIdle]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function useSettingsToast(bottomOffset = 112): { show(message: string): void; toast: ReactNode } {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      setMessage(null);
    }, TOAST_HIDE_AFTER_MS);
  }, []);

  const toast = message ? (
    <View
      style={[styles.toastWrap, { bottom: bottomOffset + insets.bottom }]}
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <View style={styles.toast}>
        <Text style={styles.toastText} numberOfLines={2}>
          {message}
        </Text>
      </View>
    </View>
  ) : null;

  return { show, toast };
}

export function Row({
  label,
  sub,
  icon,
  leading,
  detail,
  trailing,
  onPress,
  chevron,
  role = "button",
  state,
  accessibilityLabel,
  destructive,
  chip,
}: {
  label: string;
  sub?: string;
  icon?: IconName;
  leading?: ReactNode;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  role?: "button" | "switch";
  state?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  accessibilityLabel?: string;
  destructive?: boolean;
  chip?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const showChevron = chevron ?? (!!onPress && !trailing && role === "button");
  const disabled = !!state?.disabled;
  const rowStyle = chip ? [styles.row, styles.rowChip] : styles.row;
  const body = (
    <>
      {leading ? (
        <View style={styles.rowIcon}>{leading}</View>
      ) : icon ? (
        <View style={chip ? styles.rowIconChip : styles.rowIcon}>
          <Icon name={icon} size={chip ? 18 : 20} color={chip ? colors.wire.ink : colors.ink} />
        </View>
      ) : null}
      <View style={[styles.rowText, disabled && styles.rowDisabled]}>
        <Text style={[styles.rowLabel, chip && styles.rowLabelChip, destructive && styles.rowLabelDestructive]}>{label}</Text>
        {sub ? <Text style={[styles.rowSub, chip && styles.rowSubChip]}>{sub}</Text> : null}
      </View>
      {detail || trailing || showChevron ? (
        <View style={[styles.rowTrailing, disabled && styles.rowDisabled]}>
          {detail ? (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
          {trailing}
          {showChevron ? (
            <View style={styles.chevronRight}>
              <Icon name="chevron" size={18} color={chip ? colors.wire.faint : colors.ink} strokeWidth={chip ? 1.8 : undefined} />
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );

  if (!onPress || disabled) {
    return (
      <View
        style={rowStyle}
        accessible={disabled || undefined}
        accessibilityRole={disabled ? role : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={state}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [rowStyle, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={state}
    >
      {body}
    </Pressable>
  );
}

export function ToggleRow({
  label,
  icon,
  value,
  onValueChange,
  chip,
}: {
  label: string;
  icon?: IconName;
  value: boolean;
  onValueChange: (v: boolean) => void;
  chip?: boolean;
}) {
  return (
    <Row
      chip={chip}
      label={label}
      icon={icon}
      role="switch"
      state={{ checked: value }}
      onPress={() => onValueChange(!value)}
      trailing={<PillSwitch value={value} />}
    />
  );
}

export function PillSwitch({ value }: { value: boolean }) {
  const styles = useStyles(makeStyles);
  const knob = useRef(new Animated.Value(value ? 1 : 0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      knob.setValue(value ? 1 : 0);
      return;
    }
    Animated.timing(knob, {
      toValue: value ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [value, knob, reduceMotion]);

  return (
    <View
      style={[styles.track, value && styles.trackOn]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Animated.View
        style={[
          styles.knob,
          !value && styles.knobOff,
          { transform: [{ translateX: knob.interpolate({ inputRange: [0, 1], outputRange: [0, 14] }) }] },
        ]}
      />
    </View>
  );
}

export function Intro({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.intro}>{children}</Text>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  busyLabel = "Saving…",
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const off = disabled || busy;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.primary,
        disabled && styles.primaryDisabled,
        busy && styles.off,
        pressed && !off && styles.pressed,
        style,
      ]}
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
    >
      <Text style={[styles.primaryText, disabled && styles.primaryTextDisabled]}>{busy ? busyLabel : label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  icon,
  danger,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.secondary, pressed && !disabled && styles.pressed, disabled && styles.disabled, style]}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
    >
      {icon ? <Icon name={icon} size={17} strokeWidth={1.9} color={danger ? colors.red : colors.ink} /> : null}
      <Text style={[styles.secondaryText, danger && styles.secondaryTextDanger]}>{label}</Text>
    </Pressable>
  );
}

export function Message({ tone = "ok", children }: { tone?: "ok" | "error"; children: string }) {
  const styles = useStyles(makeStyles);
  if (tone === "error") return <ErrorCard message={children} />;
  return (
    <Text
      style={styles.message}
      accessibilityLiveRegion="polite"
    >
      {children}
    </Text>
  );
}

export const settingsStyles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  header: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.wire.line,
  },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerBackButton: { margin: 2 },
  headerRightSlot: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    marginHorizontal: space.xs,
    fontFamily: font.family.semi,
    fontSize: 17,
    lineHeight: 24,
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.wire.ink,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: space.md,
    marginBottom: space.md,
    minHeight: 22,
  },
  section: {
    fontFamily: font.family.semi,
    fontSize: 11,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
    paddingLeft: space.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  sectionAfterGroup: { marginTop: 28 },
  group: {
    borderWidth: 1,
    borderColor: colors.wire.line,
    borderRadius: 16,
    backgroundColor: colors.panel,
  },
  groupClip: { borderRadius: 15, overflow: "hidden" },
  badge: {
    flexShrink: 0,
    alignSelf: "center",
    borderRadius: radius.pill,
    paddingVertical: 2,
    paddingHorizontal: 9,
  },
  badgeNeutral: { backgroundColor: colors.soft },
  badgeInk: { backgroundColor: colors.ink },
  badgeAmber: { backgroundColor: colors.approvalBg },
  badgeText: {
    fontFamily: font.family.semi,
    fontSize: font.size.sm,
    lineHeight: 18,
    includeFontPadding: false,
  },
  badgeTextNeutral: { color: colors.ink },
  badgeTextInk: { color: colors.onInk },
  badgeTextAmber: { color: colors.amber },
  segmented: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
  },
  segment: {
    flex: 1,
    minHeight: 38,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  segmentSelected: {
    backgroundColor: colors.wire.tabOn,
    shadowColor: "#171511",
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  segmentPressed: { backgroundColor: colors.line },
  segmentText: {
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    textAlign: "center",
  },
  segmentTextSelected: {
    fontFamily: font.family.semi,
    color: colors.ink,
  },
  segmentTextIdle: {
    fontFamily: font.family.medium,
    color: colors.muted,
  },
  toastWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: space.lg,
  },
  toast: {
    maxWidth: "100%",
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    backgroundColor: colors.ink,
  },
  toastText: {
    fontFamily: font.family.medium,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.onInk,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 54,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: -1,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.soft },
  rowIcon: { marginRight: space.md },
  rowChip: {
    minHeight: 56,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginBottom: 0,
    borderBottomWidth: 0,
  },
  rowIconChip: {
    width: 32,
    height: 32,
    marginRight: space.md,
    borderRadius: 9,
    backgroundColor: colors.wire.tint,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  rowLabelChip: {
    fontFamily: font.family.medium,
    fontSize: 15,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.wire.text,
  },
  rowSub: {
    marginTop: 2,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  rowSubChip: {
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.wire.sub,
  },
  rowLabelDestructive: { color: colors.red },
  rowDisabled: { opacity: 0.45 },
  rowTrailing: {
    flexShrink: 1,
    maxWidth: "60%",
    marginLeft: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  rowMeta: {
    flexShrink: 1,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  chevronRight: { transform: [{ rotate: "-90deg" }] },
  track: {
    width: 35,
    height: 21,
    borderRadius: radius.pill,
    backgroundColor: colors.switchOff,
    padding: 3,
    justifyContent: "center",
  },
  trackOn: { backgroundColor: colors.ink },
  knob: { width: 15, height: 15, borderRadius: radius.pill, backgroundColor: colors.onInk },
  knobOff: { backgroundColor: colors.switchKnobOff },
  intro: {
    fontFamily: font.family.regular,
    fontSize: font.size.base,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.muted,
    marginTop: space.xs,
    marginBottom: space.lg,
  },
  primary: {
    marginTop: space.xl,
    minHeight: 46,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  primaryText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.onInk,
  },
  secondary: {
    marginTop: space.md,
    minHeight: 46,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
  },
  secondaryText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  secondaryTextDanger: { color: colors.red },
  primaryDisabled: { backgroundColor: colors.disabledFill },
  primaryTextDisabled: { color: colors.disabledText },
  off: { opacity: 0.4 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  message: {
    marginTop: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 11,
    padding: space.md,
    fontFamily: font.family.medium,
    fontSize: font.size.sm,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.green,
  },
});

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { control, type } from "./design";
import { UnderlinedText } from "../UnderlinedText";

type PrimaryProps = {
  label: string;
  onPress: () => void;
  dimmed?: boolean;
  busy?: boolean;
  disabled?: boolean;
};

export function PrimaryButton({ label, onPress, dimmed, busy, disabled }: PrimaryProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={[styles.primary, (dimmed || disabled) && styles.dimmed]}
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
    >
      {busy ? (
        <ActivityIndicator color={colors.onInk} />
      ) : (
        <Text style={styles.primaryText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  icon,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.secondary} onPress={onPress} accessibilityRole="button">
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({
  label,
  onPress,
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      style={styles.text}
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.form.soft} />
      ) : (
        <UnderlinedText style={[styles.textLabel, disabled && styles.dimmed]}>{label}</UnderlinedText>
      )}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  primary: {
    minHeight: control.buttonHeight,
    borderRadius: control.buttonRadius,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  dimmed: { opacity: 0.28 },
  primaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: type.buttonSize,
    color: colors.onInk,
  },
  secondary: {
    minHeight: control.buttonHeight,
    borderRadius: control.buttonRadius,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.bg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  secondaryText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: type.buttonSize,
    color: colors.ink,
  },
  icon: { alignItems: "center", justifyContent: "center" },
  text: { minHeight: 44, alignItems: "center", justifyContent: "center", padding: 10 },
  textLabel: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: type.textButtonSize,
    color: colors.ink,
  },
});

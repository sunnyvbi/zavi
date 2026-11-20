import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const ui = useStyles(makeUi);
  return <View style={[ui.card, style]}>{children}</View>;
}

export function CardButton({
  label,
  onPress,
  disabled,
  busy,
  variant = "primary",
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "secondary" | "plain";
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const ui = useStyles(makeUi);
  const { colors } = useTheme();
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        ui.btn,
        variant === "primary" && ui.btnPrimary,
        variant === "secondary" && ui.btnSecondary,
        variant === "plain" && ui.btnPlain,
        off && ui.btnOff,
        pressed && !off && ui.btnPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={variant === "primary" ? colors.onInk : colors.ink} />
      ) : null}
      <Text
        style={[
          ui.btnText,
          variant === "primary" ? ui.btnTextPrimary : null,
          variant === "plain" ? ui.btnTextPlain : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  const ui = useStyles(makeUi);
  if (!message) return null;
  return (
    <Text style={ui.error} accessibilityRole="alert">
      {message}
    </Text>
  );
}

export function errorText(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : "";
  return m && !/^Request failed \(\d+\)$/.test(m) ? m : fallback;
}

export const makeUi = (colors: Colors) => StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.lg,
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
  },
  title: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, color: colors.ink },
  body: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.regular, color: colors.ink },
  muted: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.regular, color: colors.textSecondary },
  small: { fontSize: font.size.sm, lineHeight: 17, fontFamily: font.family.regular, color: colors.muted },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  btnPrimary: { backgroundColor: colors.ink },
  btnSecondary: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel },
  btnPlain: { paddingHorizontal: 6 },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.ink },
  btnTextPrimary: { color: colors.onInk },
  btnTextPlain: { fontFamily: font.family.medium, color: colors.muted },
  error: { fontSize: font.size.sm, lineHeight: 17, fontFamily: font.family.medium, color: colors.red },
});

import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { Icon, type IconName } from "./Icon";

export function ConfirmDialog({
  visible,
  icon,
  logo,
  title,
  message,
  cancelLabel,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  icon?: IconName;
  logo?: ReactNode;
  title: string;
  message: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <ScrollView
        style={styles.backdrop}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.heading}>
            {logo ?? (
              <View style={styles.icon}>
                {icon ? <Icon name={icon} size={22} color={colors.ink} /> : null}
              </View>
            )}
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
          </View>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.actions}>
            {cancelLabel ? (
              <Pressable
                style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                accessibilityRole="button"
                onPress={onCancel}
              >
                <Text style={styles.secondaryText}>{cancelLabel}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.primary, destructive && styles.primaryDestructive, pressed && styles.pressed]}
              accessibilityRole="button"
              onPress={onConfirm}
            >
              <Text style={[styles.primaryText, destructive && styles.primaryTextOnAccent]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </Modal>
  );
}

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.scrim },
  container: { flexGrow: 1, justifyContent: "center", padding: space.xl },
  card: {
    width: "100%",
    maxWidth: 340,
    alignSelf: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.lg + space.xs,
    padding: space.xl,
    ...(dark ? { borderWidth: 1, borderColor: colors.borderRaised } : null),
  },
  heading: { flexDirection: "row", alignItems: "center", gap: space.md },
  icon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: dark ? colors.borderRaised : colors.soft,
  },
  title: { flex: 1, includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.lg, color: colors.ink },
  message: {
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: font.size.base,
    lineHeight: 22,
    color: colors.muted,
    marginTop: space.lg,
  },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xl },
  secondary: {
    flex: 1,
    minHeight: 44,
    padding: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: dark ? colors.borderRaised : colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: {
    flex: 1,
    minHeight: 44,
    padding: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryDestructive: { backgroundColor: colors.redFill },
  secondaryText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: font.size.base, color: dark ? colors.ink : colors.muted, textAlign: "center" },
  primaryText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: font.size.base, color: colors.onInk, textAlign: "center" },
  primaryTextOnAccent: { color: colors.onAccent },
  pressed: { opacity: 0.7 },
});

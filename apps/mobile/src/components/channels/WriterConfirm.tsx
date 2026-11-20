import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export type WriterConfirmProps = {
  title: string;
  body: string;
  previewText?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  destructive?: boolean;
};

export function WriterConfirm({
  title,
  body,
  previewText,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
  destructive = false,
}: WriterConfirmProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.box}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.body}>{body}</Text>
      {previewText ? <Text style={styles.preview}>{previewText}</Text> : null}
      <Pressable
        style={[styles.primary, destructive && styles.primaryDestructive, busy && styles.disabled]}
        onPress={onConfirm}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={confirmLabel}
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color={destructive ? colors.onAccent : colors.onInk} />
        ) : (
          <Text style={[styles.primaryText, destructive && styles.primaryTextOnAccent]}>{confirmLabel}</Text>
        )}
      </Pressable>
      <Pressable
        style={[styles.secondary, busy && styles.disabled]}
        onPress={onCancel}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
        accessibilityState={{ disabled: busy }}
      >
        <Text style={styles.secondaryText}>{cancelLabel}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    backgroundColor: colors.soft,
  },
  title: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 17, color: colors.ink },
  body: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted, marginTop: 6 },
  preview: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 14, lineHeight: 24, color: colors.ink, marginTop: 12 },
  primary: {
    backgroundColor: colors.ink,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 46,
    marginTop: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryDestructive: { backgroundColor: colors.redFill },
  primaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 13, color: colors.onInk },
  primaryTextOnAccent: { color: colors.onAccent },
  secondary: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingVertical: 13,
    paddingHorizontal: 15,
    minHeight: 46,
    marginTop: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  secondaryText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
  disabled: { opacity: 0.4 },
});

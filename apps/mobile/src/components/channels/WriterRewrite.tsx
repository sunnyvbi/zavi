import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const STYLES = ["Make it shorter", "Make it more direct"] as const;

export type WriterRewriteProps = {
  onSubmit: (message: string) => void;
  onCancel: () => void;
  busy: boolean;
};

export function WriterRewrite({ onSubmit, onCancel, busy }: WriterRewriteProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string>(STYLES[0]);

  return (
    <View>
      <Text style={styles.title} accessibilityRole="header">
        Rewrite this draft
      </Text>
      <Text style={styles.intro}>Choose a rewrite style.</Text>
      <Text style={styles.label}>Style</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Style" style={styles.options}>
        {STYLES.map((option) => {
          const checked = option === selected;
          return (
            <Pressable
              key={option}
              style={[styles.option, checked && styles.optionSelected, busy && styles.disabled]}
              onPress={() => setSelected(option)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityLabel={option}
              accessibilityState={{ checked, disabled: busy }}
            >
              <Text style={styles.optionText}>{option}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        style={[styles.primary, busy && styles.disabled]}
        onPress={() => onSubmit(selected)}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Rewrite"
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy ? <ActivityIndicator color={colors.onInk} /> : <Text style={styles.primaryText}>Rewrite</Text>}
      </Pressable>
      <Pressable
        style={[styles.secondary, busy && styles.disabled]}
        onPress={onCancel}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        accessibilityState={{ disabled: busy }}
      >
        <Text style={styles.secondaryText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  title: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 17, color: colors.ink },
  intro: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted, marginTop: 6 },
  label: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 12, color: colors.ink, marginTop: 16, marginBottom: 8 },
  options: { gap: 8, marginBottom: 16 },
  option: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 11,
    padding: 13,
    minHeight: 46,
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  optionSelected: { borderColor: colors.ink },
  optionText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 16, color: colors.ink },
  primary: {
    backgroundColor: colors.ink,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 13, color: colors.onInk },
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
  },
  secondaryText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
  disabled: { opacity: 0.4 },
});

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ErrorLine } from "./ui";

export function SuggestionChips({
  suggestions,
  onSend,
}: {
  suggestions: string[];
  onSend?: (text: string) => Promise<boolean>;
}) {
  const styles = useStyles(makeStyles);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!onSend) return null;

  async function tap(label: string) {
    if (sending) return;
    setSending(label);
    setError(null);
    const ok = await onSend!(label);
    setSending(null);
    if (!ok) setError("Couldn't send that. Try again or type it.");
  }

  return (
    <View style={styles.wrap} accessibilityLabel="Quick replies">
      <View style={styles.row}>
        {suggestions.map((label) => (
          <Pressable
            key={label}
            onPress={() => void tap(label)}
            disabled={sending !== null}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.chip,
              pressed && styles.chipPressed,
              sending !== null && sending !== label && styles.chipOff,
            ]}
          >
            <Text style={styles.chipText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <ErrorLine message={error} />
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  chipPressed: { backgroundColor: colors.soft },
  chipOff: { opacity: 0.45 },
  chipText: { fontSize: font.size.base, fontFamily: font.family.medium, color: colors.ink },
});

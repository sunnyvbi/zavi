import { useEffect, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { FocusRing } from "../ZaviTextField";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export type WriterEditProps = {
  initialText: string;
  charLimit: number;
  onSave: (text: string) => void;
  onCancel: () => void;
};

export function WriterEdit({ initialText, charLimit, onSave, onCancel }: WriterEditProps) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [text, setText] = useState(initialText);
  const [keyboardOpen, setKeyboardOpen] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    setKeyboardOpen(Keyboard.isVisible());
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const count = Array.from(text).length;
  const invalid = text.trim().length === 0 || count > charLimit;

  return (
    <View>
      <FocusRing radius={10}>
        {(focus) => (
          <TextInput
            keyboardAppearance={keyboardAppearance}
            style={[styles.input, keyboardOpen && styles.inputKeyboardOpen]}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            textAlignVertical="top"
            cursorColor={colors.ink}
            selectionHandleColor={colors.ink}
            selectionColor={textSelectionColor}
            accessibilityLabel="Edit draft"
            accessibilityHint={`Up to ${charLimit} characters`}
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
          />
        )}
      </FocusRing>
      <View style={styles.counterRow}>
        <Text
          style={[styles.counter, invalid && styles.counterInvalid]}
          accessibilityLabel={`${count} of ${charLimit} characters`}
          accessibilityLiveRegion="polite"
        >
          {count}/{charLimit}
        </Text>
      </View>
      <Pressable
        style={[styles.primary, invalid && styles.disabled]}
        onPress={() => onSave(text)}
        disabled={invalid}
        accessibilityRole="button"
        accessibilityLabel="Save"
        accessibilityState={{ disabled: invalid }}
      >
        <Text style={styles.primaryText}>Save</Text>
      </Pressable>
      <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel">
        <Text style={styles.secondaryText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  input: {
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 15,
    lineHeight: 27,
    color: colors.ink,
    minHeight: 210,
    maxHeight: 350,
    padding: 12,
  },
  inputKeyboardOpen: { maxHeight: 210 },
  counterRow: { flexDirection: "row", justifyContent: "flex-end", paddingTop: 8, paddingBottom: 12 },
  counter: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 10, color: colors.muted },
  counterInvalid: { color: colors.red },
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

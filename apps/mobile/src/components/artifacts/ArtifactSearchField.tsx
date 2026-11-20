import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { hintText } from "../ZaviTextField";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ArtifactGlyph } from "./ArtifactGlyph";

export function ArtifactSearchField({
  value,
  onChangeText,
  placeholder = "Search artifacts",
  autoFocus = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  return (
    <View style={styles.field}>
      <ArtifactGlyph name="search" size={20} color={colors.muted} />
      <TextInput
        keyboardAppearance={keyboardAppearance}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        autoFocus={autoFocus}
        placeholder={hintText(placeholder)}
        placeholderTextColor={colors.muted}
        cursorColor={colors.ink}
        selectionColor={textSelectionColor}
        selectionHandleColor={colors.ink}
        returnKeyType="search"
        accessibilityLabel="Search artifacts"
      />
      {value.length > 0 ? (
        <Pressable
          style={styles.clear}
          onPress={() => onChangeText("")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Clear artifact search"
        >
          <View style={styles.clearMark}>
            <ArtifactGlyph name="close" size={12} color={colors.onInk} />
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  field: {
    minHeight: 49,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
  },
  input: {
    minWidth: 0,
    flex: 1,
    height: 49,
    paddingVertical: 0,
    textAlignVertical: "center",
    includeFontPadding: false,
    fontFamily: font.family.medium,
    fontSize: 15,
    color: colors.ink,
  },
  clear: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  clearMark: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.muted,
  },
});

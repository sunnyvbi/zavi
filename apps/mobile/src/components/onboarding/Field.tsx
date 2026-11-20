import React, { forwardRef, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { control, type } from "./design";
import { useRevealOnFocus } from "./Shell";

type Props = TextInputProps & {
  label: string;
  hint?: string;
  multiline?: boolean;
  compact?: boolean;
};

export const Field = forwardRef<TextInput, Props>(function Field(
  { label, hint, multiline, compact, style, ...rest },
  ref,
) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [focused, setFocused] = useState(false);
  const reveal = useRevealOnFocus();
  const boxRef = useRef<View>(null);

  return (
    <View ref={boxRef}>
      <Text style={[styles.label, compact && styles.labelCompact]}>{label}</Text>
      <View style={styles.wrap}>
        {focused ? (
          <View style={[styles.ring, compact && styles.ringCompact]} pointerEvents="none" />
        ) : null}
        <TextInput
          keyboardAppearance={keyboardAppearance}
          ref={ref}
          style={[
            styles.input,
            compact && styles.inputCompact,
            multiline && styles.textarea,
            focused && styles.inputFocused,
            style,
          ]}
          placeholderTextColor={colors.form.placeholder}
          cursorColor={colors.ink}
          selectionColor={textSelectionColor}
            selectionHandleColor={colors.ink}
          multiline={multiline}
          textAlignVertical={multiline ? "top" : "center"}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            reveal?.(boxRef.current);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
        />
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  label: {
    marginTop: 20,
    marginBottom: 8,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 14,
    color: colors.ink,
  },
  labelCompact: { marginTop: 8 },
  wrap: { position: "relative" },
  ring: {
    position: "absolute",
    top: -3,
    left: -3,
    right: -3,
    bottom: -3,
    borderWidth: 6,
    borderColor: colors.form.ring,
    borderRadius: 18,
  },
  input: {
    minHeight: control.inputHeight,
    borderWidth: 1,
    borderColor: colors.form.edge,
    borderRadius: control.inputRadius,
    backgroundColor: colors.bg,
    paddingHorizontal: 15,
    paddingVertical: 12,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 15,
    letterSpacing: 0,
    color: colors.ink,
  },
  inputCompact: {
    fontFamily: font.family.medium,
    minHeight: 44,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  textarea: { minHeight: control.textareaHeight, paddingVertical: 15, lineHeight: 24 },
  ringCompact: { borderRadius: 14 },
  inputFocused: { borderColor: colors.ink },
  hint: {
    marginTop: 8,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.hintSize,
    lineHeight: type.hintLine,
    color: colors.form.soft,
  },
});

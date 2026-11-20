import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useReduceMotion } from "../lib/motion";
import { font, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export const hintText = (text?: string) => (text ? ` ${text}` : text);

const LINE_HEIGHT = 22;
const BOX_PAD = 18;
const MAX_LINES = 4;

const HALO = 3;

export function ZaviBorder({
  selected,
  error,
  radius = 16,
  style,
  children,
}: {
  selected: boolean;
  error?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const active = useRef(new Animated.Value(selected ? 1 : 0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    const to = selected ? 1 : 0;
    if (reduceMotion) {
      active.setValue(to);
      return;
    }
    Animated.timing(active, { toValue: to, duration: 300, useNativeDriver: false }).start();
  }, [selected, active, reduceMotion]);

  const borderColor = error
    ? colors.field.error
    : active.interpolate({ inputRange: [0, 1], outputRange: [colors.field.border, colors.field.borderActive] });

  return (
    <View collapsable={false} style={style}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.halo,
          { borderRadius: radius + HALO, opacity: error ? 1 : active },
          error && styles.haloError,
        ]}
      />
      <Animated.View style={[styles.box, { borderRadius: radius, borderColor }]}>{children}</Animated.View>
    </View>
  );
}

export function FocusRing({
  radius,
  error,
  style,
  children,
}: {
  radius: number;
  error?: boolean;
  style?: StyleProp<ViewStyle>;
  children: (focus: { onFocus: () => void; onBlur: () => void }) => ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <ZaviBorder selected={focused} error={error} radius={radius} style={style}>
      {children({ onFocus: () => setFocused(true), onBlur: () => setFocused(false) })}
    </ZaviBorder>
  );
}

export function ZaviTextField({
  title,
  error,
  containerStyle,
  style,
  onFocus,
  onBlur,
  editable = true,
  minLines = 1,
  maxLines = MAX_LINES,
  inSheet = false,
  ...input
}: TextInputProps & {
  title?: string;
  inSheet?: boolean;
  minLines?: number;
  maxLines?: number;
  error?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const [focused, setFocused] = useState(false);
  const [typed, setTyped] = useState(!!(input.value ?? input.defaultValue));
  const Input = inSheet ? BottomSheetTextInput : TextInput;
  const oneLine = input.multiline === false;
  const empty = input.value !== undefined ? !input.value : !typed;
  const ownHint = oneLine && !!input.placeholder;
  const pad = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const hintPad = {
    paddingLeft: pad.paddingLeft ?? pad.paddingHorizontal ?? pad.padding ?? 12,
    paddingRight: pad.paddingRight ?? pad.paddingHorizontal ?? pad.padding ?? 12,
  };

  return (
    <View style={containerStyle}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <ZaviBorder selected={focused && editable} error={error} radius={10}>
        <Input
          keyboardAppearance={keyboardAppearance}
          placeholderTextColor={colors.muted}
          selectionColor={textSelectionColor}
          cursorColor={colors.ink}
          editable={editable}
          multiline
          submitBehavior={input.onSubmitEditing ? "blurAndSubmit" : "newline"}
          {...input}
          placeholder={ownHint ? undefined : hintText(input.placeholder)}
          onChangeText={(text) => {
            setTyped(text.length > 0);
            input.onChangeText?.(text);
          }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            styles.input,
            { minHeight: LINE_HEIGHT * minLines + BOX_PAD, maxHeight: LINE_HEIGHT * Math.max(minLines, maxLines) + BOX_PAD },
            minLines === 1 ? styles.inputSingle : styles.inputMulti,
            !editable && styles.inputDisabled,
            style,
          ]}
        />
        {ownHint && empty ? (
          <View pointerEvents="none" style={[styles.hintBox, hintPad]}>
            <Text style={styles.hint} numberOfLines={1}>
              {hintText(input.placeholder)}
            </Text>
          </View>
        ) : null}
      </ZaviBorder>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  halo: {
    position: "absolute",
    top: -HALO,
    left: -HALO,
    right: -HALO,
    bottom: -HALO,
    borderWidth: HALO * 2,
    borderColor: colors.field.halo,
  },
  haloError: { borderColor: colors.field.errorHalo },
  box: { borderWidth: 1, backgroundColor: colors.field.background, overflow: "hidden" },
  title: {
    marginBottom: 8,
    fontFamily: font.family.medium,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.ink,
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: font.family.medium,
    fontSize: 15,
    includeFontPadding: false,
    color: colors.ink,
  },
  inputSingle: Platform.OS === "ios" ? { paddingVertical: 10 } : { textAlignVertical: "center" },
  hintBox: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center" },
  hint: { fontFamily: font.family.medium, fontSize: 15, includeFontPadding: false, color: colors.muted },
  inputMulti: { lineHeight: LINE_HEIGHT, textAlignVertical: "top" },
  inputDisabled: { backgroundColor: colors.field.disabled, color: colors.muted },
});

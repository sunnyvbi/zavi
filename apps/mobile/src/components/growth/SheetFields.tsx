import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { dateLabel } from "../../features/growth/dates";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { Icon } from "../Icon";
import { FocusRing } from "../ZaviTextField";
import { DatePickerDialog } from "./DatePickerDialog";

export function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{required ? `${label} *` : label}</Text>
      {children}
    </View>
  );
}

export function FieldHint({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.hint}>{children}</Text>;
}

export function FieldError({ children }: { children?: string }) {
  const styles = useStyles(makeStyles);
  if (!children) return null;
  return (
    <Text style={styles.error} accessibilityRole="alert">
      {children}
    </Text>
  );
}

export function SheetInput({
  value,
  onChange,
  onBlur,
  placeholder,
  label,
  numeric,
  multiline,
  readOnly,
  maxLength,
  invalid,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  label: string;
  numeric?: boolean;
  multiline?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  return (
    <FocusRing radius={radius.sm} error={invalid}>
      {(focus) => (
        <BottomSheetTextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          selectionColor={textSelectionColor}
          cursorColor={colors.ink}
          selectionHandleColor={colors.ink}
          keyboardAppearance={keyboardAppearance}
          maxLength={maxLength}
          editable={!readOnly}
          autoFocus={autoFocus}
          multiline={multiline}
          keyboardType={numeric ? "decimal-pad" : "default"}
          autoCapitalize={numeric ? "none" : "sentences"}
          onFocus={focus.onFocus}
          onBlur={() => {
            focus.onBlur();
            onBlur?.();
          }}
          style={[
            styles.textInput,
            multiline ? styles.inputMulti : styles.inputSingle,
            readOnly && styles.inputReadOnly,
          ]}
        />
      )}
    </FocusRing>
  );
}

export function PickerField({
  value,
  options,
  placeholder,
  label,
  invalid,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  label: string;
  invalid?: boolean;
  onChange: (v: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.input, styles.inputSingle, styles.picker, invalid && styles.inputInvalid, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: current?.label ?? placeholder }}
        accessibilityState={{ expanded: open }}
      >
        <Text style={[styles.pickerText, !current && styles.placeholder]} numberOfLines={1}>
          {current?.label ?? placeholder}
        </Text>
        <Icon name="chevronDown" size={18} color={colors.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.popupBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.popupCard} onPress={() => {}}>
            <Text style={styles.popupTitle}>{label}</Text>
            {options.map((o) => (
              <Pressable
                key={o.value}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                accessibilityRole="radio"
                accessibilityState={{ checked: o.value === value }}
              >
                <Text style={[styles.optionText, o.value === value && styles.optionOn]}>{o.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

export function DateField({
  value,
  onChange,
  onBlur,
  label,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  label: string;
  invalid?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const text = dateLabel(value);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.input, styles.inputSingle, styles.picker, invalid && styles.inputInvalid, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: text || "No date" }}
      >
        <Text style={[styles.pickerText, !text && styles.placeholder]} numberOfLines={1}>
          {text || "Pick a date"}
        </Text>
      </Pressable>
      <DatePickerDialog
        visible={open}
        value={value}
        onSelect={(v) => {
          onChange(v);
          onBlur?.();
        }}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: { marginBottom: space.lg, gap: 8 },
    label: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.ink },
    hint: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.textSecondary },
    error: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.red },
    input: {
      borderWidth: 1,
      borderColor: colors.field.border,
      borderRadius: radius.sm,
      backgroundColor: colors.field.background,
      paddingHorizontal: 12,
      fontFamily: font.family.medium,
      fontSize: 15,
      includeFontPadding: false,
      color: colors.ink,
    },
    textInput: {
      paddingHorizontal: 12,
      fontFamily: font.family.medium,
      fontSize: 15,
      includeFontPadding: false,
      color: colors.ink,
    },
    inputSingle: { minHeight: 42, paddingVertical: 8, textAlignVertical: "center" },
    inputMulti: { minHeight: 110, paddingVertical: 10, lineHeight: 22, textAlignVertical: "top" },
    inputInvalid: { borderColor: colors.field.error },
    inputReadOnly: { backgroundColor: colors.soft, color: colors.muted },
    picker: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
    pickerText: { flex: 1, fontFamily: font.family.medium, fontSize: 15, lineHeight: 20, includeFontPadding: false, color: colors.ink },
    placeholder: { color: colors.muted },
    pressed: { opacity: 0.8 },
    popupBackdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "center", paddingHorizontal: 24 },
    popupCard: { backgroundColor: colors.surfaceRaised, borderRadius: 16, overflow: "hidden" },
    popupTitle: { fontFamily: font.family.semi, fontSize: 14, lineHeight: 20, includeFontPadding: false, color: colors.muted, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
    option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    optionPressed: { backgroundColor: colors.soft },
    optionText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 18, includeFontPadding: false, color: colors.ink },
    optionOn: { fontFamily: font.family.semi },
  });

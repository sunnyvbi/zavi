import { Pressable, StyleSheet, Text, View } from "react-native";
import { AppBottomSheet } from "./AppBottomSheet";
import { Icon } from "./Icon";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export type SheetOption<T> = { value: T; label: string };

export function OptionSheet<T>({
  open,
  title,
  message,
  options,
  value,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  message?: string;
  options: SheetOption<T>[];
  value: T;
  onPick: (value: T) => void;
  onClose: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <AppBottomSheet open={open} onClose={onClose} title={title}>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <View style={styles.group}>
        {options.map((o, i) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={String(o.value ?? `unset-${i}`)}
              style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
              onPress={() => {
                onPick(o.value);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.text, selected && styles.textOn]}>{o.label}</Text>
              {selected ? <Icon name="tick" size={18} color={colors.status.tick} /> : null}
            </Pressable>
          );
        })}
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    message: { marginBottom: space.md, fontSize: 14, lineHeight: 20, fontFamily: font.family.regular, color: colors.textSecondary },
    group: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, overflow: "hidden", marginBottom: space.lg },
    row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 50, paddingHorizontal: space.lg },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    pressed: { backgroundColor: colors.soft },
    text: { flex: 1, fontSize: 15, fontFamily: font.family.medium, color: colors.ink },
    textOn: { fontFamily: font.family.semi },
  });

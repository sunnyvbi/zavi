import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { HOLD_TO_CONFIRM_MS, type adApproveConfirm } from "../../features/channels/channelPage";
import { font, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export type AdApproveConfirmProps = {
  confirm: ReturnType<typeof adApproveConfirm>;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
};

export function AdApproveConfirm({ confirm, onConfirm, onCancel, busy }: AdApproveConfirmProps) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef(0);
  const confirmNow = useRef(onConfirm);
  confirmNow.current = onConfirm;
  const stop = () => {
    press.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(() => stop, []);

  const pressIn = () => {
    if (!confirm.hold || busy) return;
    if (timer.current) clearTimeout(timer.current);
    const mine = ++press.current;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (press.current !== mine) return;
      setHolding(false);
      confirmNow.current();
    }, HOLD_TO_CONFIRM_MS);
  };

  return (
    <View style={styles.box}>
      <Text style={styles.title} accessibilityRole="header">
        {confirm.title}
      </Text>
      <Text style={styles.platform}>{confirm.platform}</Text>
      {confirm.rows.map((r, i) => (
        <View key={`${r.item}-${i}`} style={styles.row}>
          <Text style={styles.item}>{r.item}</Text>
          <Text style={styles.change}>
            {r.before} {"->"} {r.after}
          </Text>
        </View>
      ))}
      {confirm.money ? <Text style={styles.money}>{confirm.money}</Text> : null}
      <Text style={styles.note}>{confirm.note}</Text>
      <Pressable
        style={[styles.primary, holding && styles.primaryHolding, busy && styles.disabled]}
        onPress={confirm.hold ? undefined : onConfirm}
        onPressIn={pressIn}
        onPressOut={confirm.hold ? stop : undefined}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={confirm.confirmLabel}
        accessibilityHint={confirm.hold ? "Press and hold for one second to approve." : undefined}
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color={colors.onInk} />
        ) : (
          <Text style={styles.primaryText}>{holding ? "Keep holding" : confirm.confirmLabel}</Text>
        )}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 16, backgroundColor: colors.soft },
    title: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 17, color: colors.ink },
    platform: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted, marginTop: 4 },
    row: { marginTop: 12 },
    item: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
    change: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.ink, marginTop: 2 },
    money: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.ink, marginTop: 12 },
    note: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted, marginTop: 8 },
    primary: { backgroundColor: colors.ink, borderRadius: 12, height: 48, marginTop: 16, alignItems: "center", justifyContent: "center" },
    primaryHolding: { opacity: 0.7 },
    primaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
    secondary: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      height: 48,
      marginTop: 9,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bg,
    },
    secondaryText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    disabled: { opacity: 0.4 },
  });

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardAvoider } from "../KeyboardAvoider";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { Member } from "../../features/settings/api";
import { ZaviTextField } from "../ZaviTextField";
import { ErrorCard } from "../ErrorCard";

export function TransferOwnershipDialog({
  visible,
  member,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  member: Member | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!visible) setTyped("");
  }, [visible]);

  useEffect(() => {
    setTyped("");
  }, [member?.user_id, member?.email]);

  if (!member) return null;

  const matches = typed.trim().toLowerCase() === member.email.toLowerCase();
  const transferDisabled = busy || !matches;

  const cancel = () => {
    if (busy) return;
    Keyboard.dismiss();
    onCancel();
  };

  const confirm = () => {
    if (transferDisabled) return;
    Keyboard.dismiss();
    onConfirm();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={cancel}>
      <KeyboardAvoider style={styles.avoider}>
        <ScrollView
          style={styles.backdrop}
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable style={styles.center} onPress={cancel} disabled={busy}>
            <Pressable
              style={styles.card}
              onPress={Keyboard.dismiss}
              accessibilityViewIsModal
              accessibilityRole="alert"
            >
              <Text style={styles.title} accessibilityRole="header">
                Transfer ownership
              </Text>
              <Text style={styles.message}>
                <Text style={styles.messageStrong}>{member.email}</Text>
                <Text> becomes the Owner and you become an Admin. This </Text>
                <Text style={styles.messageDanger}>cannot be undone.</Text>
              </Text>
              <ZaviTextField
                title="Type their email to confirm"
                value={typed}
                onChangeText={setTyped}
                placeholder={member.email}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                accessibilityLabel="Type their email to confirm"
                maxLines={1}
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
                containerStyle={styles.field}
              />
              {error ? <ErrorCard message={error} /> : null}
              <View style={styles.actions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondary,
                    busy && styles.disabled,
                    pressed && !busy && styles.pressed,
                  ]}
                  onPress={cancel}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                >
                  <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.primary,
                    transferDisabled && styles.disabled,
                    pressed && !transferDisabled && styles.pressed,
                  ]}
                  onPress={confirm}
                  disabled={transferDisabled}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: transferDisabled, busy }}
                >
                  {busy ? (
                    <View style={styles.busyContent}>
                      <ActivityIndicator size="small" color={colors.onAccent} />
                      <Text style={styles.primaryText}>Transferring…</Text>
                    </View>
                  ) : (
                    <Text style={styles.primaryText}>Transfer</Text>
                  )}
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </ScrollView>
      </KeyboardAvoider>
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  avoider: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: colors.scrim },
  container: { flexGrow: 1 },
  center: {
    flexGrow: 1,
    justifyContent: "center",
    padding: space.xl,
  },
  card: {
    width: "100%",
    maxWidth: 340,
    alignSelf: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.lg + space.xs,
    padding: space.xl,
  },
  title: {
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    includeFontPadding: false,
    color: colors.ink,
  },
  message: {
    marginTop: space.md,
    fontFamily: font.family.regular,
    fontSize: font.size.base,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  messageStrong: {
    fontFamily: font.family.semi,
    color: colors.ink,
  },
  messageDanger: {
    fontFamily: font.family.semi,
    color: colors.red,
  },
  field: { marginTop: space.lg },
  actions: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.xl,
  },
  secondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  primary: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.redFill,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
  },
  secondaryText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
    textAlign: "center",
  },
  primaryText: {
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.onAccent,
    textAlign: "center",
  },
  busyContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});

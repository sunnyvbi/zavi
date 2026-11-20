import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../components/Screen";
import { ErrorCard, friendlyError } from "../components/ErrorCard";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ZaviTextField } from "../components/ZaviTextField";
import { useKeyboardReveal } from "../components/useKeyboardReveal";
import { BackHeader } from "../components/settings/SettingsUI";
import { useAuth } from "../auth/AuthProvider";
import {
  AccountDeletionUnavailableError,
  deleteAccount,
} from "../features/account/api";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { KeyboardAvoider } from "../components/KeyboardAvoider";
import { track } from "../lib/analytics";
import { resetTo } from "../lib/nav";
import { PHASE_ROUTE } from "../features/creator/phase";

const CONFIRM_WORD = "DELETE";
const SUPPORT_EMAIL = "support@zaviagent.com";

export default function DeleteAccount() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { keyboardOpen, scrollRef, onScroll, reveal } = useKeyboardReveal();
  const fieldBox = useRef<View>(null);
  const { session, signOut } = useAuth();
  const email = session?.user?.email ?? "";

  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const armed = typed.trim().toUpperCase() === CONFIRM_WORD;

  function onDeletePress() {
    if (!armed || busy) return;
    setConfirming(true);
  }

  async function run() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      await deleteAccount();
      track("account_deleted", { source: Platform.OS });
      await signOut().catch(() => {});
      resetTo(PHASE_ROUTE.auth);
      Alert.alert(
        "Account deleted",
        "Your Zavi account and its data have been deleted. Sorry to see you go.",
      );
    } catch (e) {
      if (e instanceof AccountDeletionUnavailableError) {
        setUnavailable(true);
      } else {
        setError(friendlyError(e, "Couldn't delete your account. Please try again."));
      }
      setBusy(false);
    }
  }

  return (
    <Screen>
      <BackHeader title="Delete account" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          <View style={styles.intro}>
            <Text style={styles.title}>This can&apos;t be undone</Text>
            <Text style={styles.description}>
              Deleting your account is permanent. We cannot restore your data afterwards.
            </Text>
            {email ? (
              <Text style={styles.description}>
                Signed in as <Text style={styles.emphasis}>{email}</Text>
              </Text>
            ) : null}
          </View>

          <Card
            title="What gets deleted"
            items={[
              "Your Zavi login and profile.",
              "Your conversations, agent runs, and everything the agents learned about you.",
              "Any workspace where you are the only member, and all of its data.",
              "Every connected account we hold a token for — Meta, Google, Slack, GitHub.",
            ]}
          />

          <Card
            title="What stays"
            items={[
              "Workspaces that still have other members. You are removed from them; their data stays with the remaining members.",
              "Billing records we are legally required to keep, for up to 7 years.",
            ]}
          />

          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              If your workspace is on a paid plan, cancel it at zaviagent.com first. Deleting your
              account here does not cancel billing or refund unused credits.
            </Text>
          </View>

          <View ref={fieldBox}>
            <ZaviTextField
              title={`Type ${CONFIRM_WORD} to confirm`}
              value={typed}
              onChangeText={(v) => {
                setTyped(v);
                if (error) setError(null);
              }}
              onFocus={() => reveal(fieldBox.current)}
              placeholder={CONFIRM_WORD}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
              maxLines={1}
              editable={!busy}
              error={!!error}
              accessibilityLabel={`Type ${CONFIRM_WORD} to confirm account deletion`}
            />
            {error ? <ErrorCard message={error} /> : null}
          </View>

          {}
          {unavailable ? (
            <View style={styles.card}>
              <Text style={styles.description}>
                Account deletion isn&apos;t available in this version yet. Email us and we will
                delete your account for you, normally within 5 business days.
              </Text>
              <Pressable
                style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]}
                accessibilityRole="button"
                onPress={() =>
                  void Linking.openURL(
                    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Data deletion request")}`,
                  ).catch(() =>
                    Alert.alert("Couldn't open mail", `Please email ${SUPPORT_EMAIL}.`),
                  )
                }
              >
                <Text style={styles.secondaryText}>Email {SUPPORT_EMAIL}</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.bottomBar, { paddingBottom: (keyboardOpen ? 0 : insets.bottom) + space.lg }]}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.secondary,
              pressed && styles.pressed,
              busy && styles.disabled,
            ]}
            onPress={() => router.back()}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Keep account</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.delete,
              !armed && styles.deleteOff,
              pressed && armed && styles.pressed,
            ]}
            onPress={onDeletePress}
            disabled={!armed || busy}
            accessibilityRole="button"
            accessibilityLabel="Delete my account"
            accessibilityState={{ disabled: !armed || busy, busy }}
          >
            {busy ? (
              <ActivityIndicator color={colors.onInk} />
            ) : (
              <Text style={[styles.deleteText, !armed && styles.deleteTextOff]}>Delete account</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoider>

      <ConfirmDialog
        visible={confirming}
        icon="trash"
        title="Delete your account?"
        message="This permanently deletes your Zavi account and cannot be undone."
        cancelLabel="Cancel"
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={() => void run()}
      />
    </Screen>
  );
}

function Card({ title, items }: { title: string; items: string[] }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {items.map((t) => (
        <View key={t} style={styles.bulletRow}>
          <View style={styles.bulletDot} />
          <Text style={styles.bulletText}>{t}</Text>
        </View>
      ))}
    </View>
  );
}

const text = { includeFontPadding: false } as const;

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.lg },
  intro: { gap: space.sm },
  title: { ...text, fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, color: colors.ink },
  description: {
    ...text,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  emphasis: { fontFamily: font.family.semi, color: colors.ink },
  card: {
    padding: space.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
  },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  bulletDot: {
    width: 4,
    height: 4,
    marginTop: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.textSecondary,
    flexShrink: 0,
  },
  bulletText: {
    ...text,
    flex: 1,
    minWidth: 0,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  notice: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
  noticeText: { ...text, fontFamily: font.family.medium, fontSize: 13, lineHeight: 18, color: colors.ink },
  bottomBar: {
    flexDirection: "row",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  button: {
    flex: 1,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  secondary: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
  secondaryText: { ...text, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.ink },
  delete: { backgroundColor: colors.redFill },
  deleteOff: { backgroundColor: colors.soft },
  deleteText: { ...text, fontFamily: font.family.semi, fontSize: 14, lineHeight: 18, color: colors.onAccent },
  deleteTextOff: { color: colors.muted },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});

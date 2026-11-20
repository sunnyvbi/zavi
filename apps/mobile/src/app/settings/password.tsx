import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import {
  BackHeader,
  Intro,
  Message,
  PrimaryButton,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { friendlyError } from "../../components/ErrorCard";
import { supabase } from "../../lib/supabase";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";

const MIN = 8;

export default function Password() {
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save() {
    setDone(false);
    if (password.length < MIN) {
      setError(`Password must be at least ${MIN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(friendlyError(err, "Couldn't update your password. Try again."));
      return;
    }
    setPassword("");
    setConfirm("");
    setDone(true);
  }

  return (
    <Screen>
      <BackHeader title="Password" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Intro>Use at least 8 characters. You stay signed in on this device.</Intro>
          <ZaviTextField
            title="New password"
            containerStyle={styles.field}
            maxLines={1}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
            secureTextEntry
            multiline={false}
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            placeholder="New password"
          />
          <ZaviTextField
            title="Confirm password"
            containerStyle={styles.field}
            maxLines={1}
            submitBehavior="blurAndSubmit"
            value={confirm}
            onChangeText={(t) => {
              setConfirm(t);
              setError(null);
            }}
            secureTextEntry
            multiline={false}
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            placeholder="Type it again"
            returnKeyType="done"
            onSubmitEditing={() => void save()}
          />
          {error ? <Message tone="error">{error}</Message> : null}
          {done ? <Message>Password updated.</Message> : null}
          <PrimaryButton
            label="Update password"
            onPress={() => void save()}
            disabled={!password || !confirm}
            busy={busy}
          />
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, field: { marginTop: 16 } });

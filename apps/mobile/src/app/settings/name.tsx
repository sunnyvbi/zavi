import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import {
  BackHeader,
  Message,
  PrimaryButton,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { useAuth } from "../../auth/AuthProvider";
import { friendlyError } from "../../components/ErrorCard";
import { supabase } from "../../lib/supabase";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";

const MAX = 80;

export default function Name() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const initial =
    typeof session?.user?.user_metadata?.full_name === "string"
      ? session.user.user_metadata.full_name.trim()
      : "";
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const changed = trimmed !== initial;

  async function save() {
    if (!trimmed) {
      setError("Add your name.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ data: { full_name: trimmed } });
    setBusy(false);
    if (err) {
      setError(friendlyError(err, "Couldn't save your name. Try again."));
      return;
    }
    router.back();
  }

  return (
    <Screen>
      <BackHeader title="Your name" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <ZaviTextField
            containerStyle={styles.field}
            title="Name"
            value={value}
            onChangeText={(t) => {
              setValue(t);
              setError(null);
            }}
            placeholder="Your full name"
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            maxLength={MAX}
            maxLines={1}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={() => changed && void save()}
            autoFocus
          />
          {error ? <Message tone="error">{error}</Message> : null}
          <PrimaryButton label="Save" onPress={() => void save()} disabled={!changed} busy={busy} />
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 }, field: { marginTop: 16 } });

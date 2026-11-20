import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import {
  BackHeader,
  Intro,
  Message,
  PrimaryButton,
  Segmented,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { ApiFetchError } from "../../lib/api";
import { track } from "../../lib/analytics";
import { validateEmail } from "../../auth/validateEmail";
import { useCreateInvite } from "../../features/settings/api";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";

type Role = "member" | "admin" | "viewer";

const ROLE_HELP: Record<Role, string> = {
  member: "Uses every agent and channel. Can't change billing, team or connections.",
  admin: "Everything a member can do, plus billing, team and connections.",
  viewer: "Read-only. Sees the workspace but can't run agents or approve anything.",
};
const ROLE_LABEL: Record<Role, string> = { member: "Member", admin: "Admin", viewer: "Viewer" };

function inviteError(e: unknown): string {
  if (e instanceof ApiFetchError && e.message.trim()) return e.message.trim();
  return "Couldn't send the invite. Try again.";
}

export default function InviteTeammate() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const create = useCreateInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const v = email.trim();
    const invalid = validateEmail(v);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({ email: v, role });
      track("member_invited", { role });
      router.back();
    } catch (e) {
      setError(inviteError(e));
    }
  }

  return (
    <Screen>
      <BackHeader title="Invite a teammate" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
        >
          <Intro>Choose the access they need. They get an email to join.</Intro>
          <ZaviTextField
            title="Email address"
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setError(null);
            }}
            placeholder="teammate@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            maxLines={1}
            error={!!error}
            autoFocus
          />

          <Text style={styles.roleTitle}>Role</Text>
          <Segmented
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: "admin", label: ROLE_LABEL.admin },
              { value: "member", label: ROLE_LABEL.member },
              { value: "viewer", label: ROLE_LABEL.viewer },
            ]}
          />
          <Text style={styles.help}>{ROLE_HELP[role]}</Text>

          {error ? <Message tone="error">{error}</Message> : null}
          <PrimaryButton
            label="Send invite"
            onPress={() => void send()}
            disabled={!email.trim()}
            busy={create.isPending}
          />
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  roleTitle: {
    marginTop: space.xl,
    marginBottom: space.sm,
    fontFamily: font.family.medium,
    fontSize: 13,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  help: {
    marginTop: space.sm,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
});

import { ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import {
  BackHeader,
  Intro,
  ListGroup,
  Row,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { useAuth } from "../../auth/AuthProvider";

export default function Account() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const user = session?.user;
  const email = user?.email ?? "";
  const name =
    typeof user?.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";
  const hasPassword = (user?.identities ?? []).some((i) => i.provider === "email");

  return (
    <Screen>
      <BackHeader title="Account" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <Intro>Manage your profile and sign-in.</Intro>
        <ListGroup>
          <Row
            label="Name"
            icon="user"
            detail={name || "Add your name"}
            onPress={() => router.push("/settings/name")}
            chevron
          />
          <Row label="Email" icon="mail" detail={email || "—"} accessibilityLabel={`Email ${email}`} />
          <Row
            label={hasPassword ? "Change password" : "Set a password"}
            icon="key"
            onPress={() => router.push("/settings/password")}
          />
        </ListGroup>
      </ScrollView>
    </Screen>
  );
}

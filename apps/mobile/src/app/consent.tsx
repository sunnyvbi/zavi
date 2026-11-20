import { useState } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AiConsentGate } from "../components/AiConsentGate";
import { useAuth } from "../auth/AuthProvider";
import { useAiConsent } from "../features/consent/useAiConsent";
import { useOnboarding } from "../features/onboarding/OnboardingProvider";
import { track } from "../lib/analytics";
import { type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export default function Consent() {
  const styles = useStyles(makeStyles);
  const consent = useAiConsent();
  const { signOut } = useAuth();
  const { status } = useOnboarding();
  const [leaving, setLeaving] = useState(false);
  const noWorkspace = status === "needed";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom", "left", "right"]}>
      <AiConsentGate
        onAgree={() => {
          consent.agree();
          track("ai_consent_answered", { agreed: true });
        }}
        onDecline={
          noWorkspace
            ? () => {
                if (leaving) return;
                setLeaving(true);
                void signOut().finally(() => setLeaving(false));
              }
            : () => {
                consent.decline();
                track("ai_consent_answered", { agreed: false });
              }
        }
        declineLabel={noWorkspace ? "Sign out" : "Not now"}
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
  });

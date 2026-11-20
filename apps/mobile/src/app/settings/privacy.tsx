import { BackHandler, Linking, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { AiConsentGate, PRIVACY_URL } from "../../components/AiConsentGate";
import { BackHeader, ListGroup, Row, settingsStyles } from "../../components/settings/SettingsUI";
import { useAiConsent } from "../../features/consent/useAiConsent";
import { space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { useEffect, useState } from "react";

export default function Privacy() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const consent = useAiConsent();
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!reviewing) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setReviewing(false);
      return true;
    });
    return () => sub.remove();
  }, [reviewing]);

  return (
    <Screen>
      <BackHeader title="Privacy" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <Text style={styles.intro}>What Zavi shares with AI models to do the work for you.</Text>

        <ListGroup>
          <Row label="Status" detail={consent.agreed ? "On" : "Off"} />
          <Row label="Review and agree" onPress={() => setReviewing(true)} />
          <Row label="Privacy policy" onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => {})} />
        </ListGroup>
      </ScrollView>

      {}
      {reviewing ? (
        <SafeAreaView style={styles.reviewCenter} edges={["top", "bottom", "left", "right"]}>
          <AiConsentGate
            onAgree={() => {
              consent.agree();
              setReviewing(false);
            }}
            onDecline={() => setReviewing(false)}
            declineLabel="Close"
          />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  intro: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    marginBottom: space.md,
  },
  reviewCenter: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg },
});

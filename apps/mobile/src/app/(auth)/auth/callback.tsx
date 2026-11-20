import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { completeBrowserOAuth } from "../../../auth/oauth";
import { font, type Colors } from "../../../theme/tokens";
import { useStyles, useTheme } from "../../../theme/theme";
import { track } from "../../../lib/analytics";

export default function AuthCallback() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { callbackUrl } = useLocalSearchParams<{
    callbackUrl?: string | string[];
  }>();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void completeBrowserOAuth(
      typeof callbackUrl === "string" ? callbackUrl : "",
    )
      .then(() => {
        if (mounted) router.replace("/");
      })
      .catch((failure: unknown) => {
        if (mounted) {
          track("auth_failed", { step: "oauth_browser" });
          setMessage(
            failure instanceof Error
              ? failure.message
              : "Unable to finish signing in. Please try again.",
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, [callbackUrl, router]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.body}>
        {message ? (
          <>
            <Text style={styles.title}>Sign-in could not finish.</Text>
            <Text style={styles.message} accessibilityRole="alert">
              {message}
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => router.replace("/(auth)/login")}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>Back to log in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.ink} />
            <Text style={styles.message} accessibilityLiveRegion="polite">
              Finishing sign-in...
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 20 },
  title: {
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: 24,
    color: colors.ink,
    textAlign: "center",
  },
  message: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: font.size.base,
    color: colors.muted,
    textAlign: "center",
  },
  button: {
    minHeight: 53,
    borderRadius: 30,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  buttonText: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.onInk,
  },
});

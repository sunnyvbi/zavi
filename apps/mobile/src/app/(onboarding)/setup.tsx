import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusSpinner } from "../../components/channels/ChannelStates";
import { ErrorLine, Shell } from "../../components/onboarding/Shell";
import { PrimaryButton, TextButton } from "../../components/onboarding/Buttons";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { font, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ZaviAppIcon } from "../../components/ZaviAppIcon";
import { track } from "../../lib/analytics";

const SLOW_MS = 60_000;

export default function Setup() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { ready, finish, finishError, flow, data } = useOnboarding();
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const started = useRef(false);
  const viewed = useRef(false);
  const mode = flow === "add" ? "add_company" : flow ?? "first";

  const run = useCallback(() => {
    setFailed(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    void finish().then((ok) => {
      clearTimeout(timer);
      if (!ok) setFailed(true);
    });
  }, [finish]);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    run();
  }, [ready, run]);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "setup", mode });
  }, [ready, mode]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => !failed && !slow);
    return () => sub.remove();
  }, [failed, slow]);

  if (!ready) return null;

  const building = data.noSite;

  return (
    <Shell
      step={5}
      bare
      fill
      footer={
        failed ? (
          <>
            <PrimaryButton label="Try again" onPress={run} />
            {}
            {flow === "add" ? <TextButton label="Go back" onPress={() => router.back()} /> : null}
          </>
        ) : slow ? (
          <TextButton label="Go back" onPress={() => router.back()} />
        ) : undefined
      }
    >
      <View style={styles.center}>
        <ZaviAppIcon size={72} radius={18} />
        {failed ? null : <StatusSpinner size={26} />}
        <Text style={styles.title} accessibilityRole="header">
          {failed ? "We hit a snag setting up your workspace" : "Setting up your workspace…"}
        </Text>
        <Text style={styles.body}>
          {failed
            ? "Nothing is lost. Check your connection and try again."
            : slow
              ? "This is taking longer than usual. You can keep waiting, or go back; your workspace keeps setting up either way."
              : building
                ? "Zavi is starting to build your idea and spinning up your agent team. This can take up to two minutes."
                : "Zavi is spinning up your agent team with everything it just learned. This can take up to two minutes."}
        </Text>
        {failed ? <ErrorLine message={finishError} /> : null}
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20, paddingBottom: 80 },
    title: { fontFamily: font.family.semi, fontSize: 22, lineHeight: 28, textAlign: "center", color: colors.ink },
    body: { fontFamily: font.family.regular, fontSize: 16, lineHeight: 24, textAlign: "center", color: colors.muted },
  });

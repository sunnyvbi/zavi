import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Shell, Heading } from "../../components/onboarding/Shell";
import { PrimaryButton, TextButton } from "../../components/onboarding/Buttons";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { runSiteScan } from "../../features/onboarding/api";
import type { OnboardingData } from "../../features/onboarding/types";
import { type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ZaviGlance } from "../../components/ZaviGlance";
import { useReduceMotion } from "../../lib/motion";
import { track } from "../../lib/analytics";

const scan = {
  orbitHeight: 174,
  orbitTop: 20,
  orbitBottom: 25,
  ringSize: 150,
  ringSpinMs: 2000,
  stepGap: 12,
  stepPaddingV: 14,
  stepSize: 13,
  badgeSize: 20,
  badgeTextSize: 10,
  badgeSpinMs: 1000,
} as const;

const NEXT = "/(onboarding)/business";

export default function Scanning() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { data, patch, ready, flow } = useOnboarding();
  const mode = flow === "add" ? "add_company" : flow ?? "first";

  const reduceMotion = useReduceMotion();
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const viewed = useRef(false);
  const ringSpin = useRef(new Animated.Value(0)).current;
  const badgeSpin = useRef(new Animated.Value(0)).current;

  const website = data.website.trim();
  const skipScan = !website || data.noSite;
  const running = !failed && !done;

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "scanning", mode });
  }, [ready, mode]);

  useEffect(() => {
    if (!ready) return;
    if (skipScan) {
      track("onboarding_scan_completed", { status: "skipped" });
      router.replace(NEXT);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    cancelledRef.current = false;
    let alive = true;
    setFailed(false);
    setDone(false);

    runSiteScan(website, controller.signal)
      .then((result) => {
        if (!alive) return;
        setDone(true);
        track("onboarding_scan_completed", {
          status: result.status === "ok" ? "ok" : "skipped",
          competitors_found: result.status === "ok" ? result.competitors.length : undefined,
        });
        if (result.status === "ok") {
          const fields: Partial<OnboardingData> = {};
          if (result.workspace) fields.workspace = result.workspace;
          if (result.description) fields.description = result.description;
          if (result.audience) fields.audience = result.audience;
          if (result.competitors.length > 0) fields.competitors = result.competitors;
          if (Object.keys(fields).length > 0) patch(fields);
        }
        router.replace(NEXT);
      })
      .catch(() => {
        if (!alive) return;
        if (cancelledRef.current) return;
        track("onboarding_scan_completed", { status: "failed" });
        setFailed(true);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [ready, skipScan, website, attempt, patch, router]);

  useEffect(() => {
    if (reduceMotion || !running) {
      ringSpin.setValue(0);
      badgeSpin.setValue(0);
      return;
    }
    const turn = (value: Animated.Value, duration: number) =>
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
    const ring = turn(ringSpin, scan.ringSpinMs);
    const badge = turn(badgeSpin, scan.badgeSpinMs);
    ring.start();
    badge.start();
    return () => {
      ring.stop();
      badge.stop();
    };
  }, [reduceMotion, running, ringSpin, badgeSpin]);

  const spinStyle = (value: Animated.Value) => ({
    transform: [
      {
        rotate: value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }),
      },
    ],
  });

  function onCancel() {
    cancelledRef.current = true;
    track("onboarding_scan_completed", { status: "skipped" });
    controllerRef.current?.abort();
    router.back();
  }

  const footer = failed ? (
    <>
      <PrimaryButton label="Try again" onPress={() => setAttempt((n) => n + 1)} />
      <TextButton label="Add details myself" onPress={() => {
        track("onboarding_scan_completed", { status: "skipped" });
        router.replace(NEXT);
      }} />
    </>
  ) : (
    <TextButton label="Cancel" onPress={onCancel} />
  );

  function step(number: string, label: string, state: "pending" | "active" | "done") {
    return (
      <View style={styles.step} accessibilityRole="text">
        <View style={[styles.badge, state === "done" && styles.badgeDone]}>
          {state === "done" ? (
            <View style={styles.tick} />
          ) : state === "active" ? (
            <Animated.View style={[styles.badgeSpinner, spinStyle(badgeSpin)]} />
          ) : (
            <Text style={styles.badgeText}>{number}</Text>
          )}
        </View>
        <Text style={[styles.stepLabel, state === "done" && styles.stepLabelDone]}>{label}</Text>
      </View>
    );
  }

  const state = done ? "done" : failed ? "pending" : "active";

  return (
    <Shell step={1} hideBack footer={footer}>
      {}
      <View style={styles.orbit} accessible={false}>
        <View style={styles.ring} />
        {running && !reduceMotion ? (
          <Animated.View style={[styles.ringHighlight, spinStyle(ringSpin)]} />
        ) : null}
        {}
        <ZaviGlance size={78} working={running} />
      </View>

      <Heading
        center
        title={failed ? "We could not read your site." : "Preparing your workspace."}
        sub={
          failed
            ? "You can try again, or add the details yourself."
            : "Putting your business details together."
        }
      />

      {step("1", "Business details", state)}
      {step("2", "Competitor list", done ? "done" : "pending")}
    </Shell>
  );
}

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  orbit: {
    height: scan.orbitHeight,
    marginTop: scan.orbitTop,
    marginBottom: scan.orbitBottom,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: scan.ringSize,
    height: scan.ringSize,
    borderRadius: scan.ringSize / 2,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: dark ? colors.soft : "#f3f7fd",
  },
  ringHighlight: {
    position: "absolute",
    width: scan.ringSize,
    height: scan.ringSize,
    borderRadius: scan.ringSize / 2,
    borderWidth: 2,
    borderColor: "transparent",
    borderTopColor: "#027bff",
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: scan.stepGap,
    paddingVertical: scan.stepPaddingV,
  },
  stepLabel: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: scan.stepSize,
    color: colors.form.soft,
  },
  stepLabelDone: { color: colors.ink },
  badge: {
    width: scan.badgeSize,
    height: scan.badgeSize,
    borderRadius: scan.badgeSize / 2,
    borderWidth: 1,
    borderColor: colors.form.edge,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDone: { backgroundColor: colors.ink, borderColor: colors.ink },
  badgeText: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: scan.badgeTextSize,
    color: colors.form.soft,
  },
  badgeSpinner: {
    position: "absolute",
    top: -1,
    left: -1,
    width: scan.badgeSize,
    height: scan.badgeSize,
    borderRadius: scan.badgeSize / 2,
    borderWidth: 1,
    borderColor: "transparent",
    borderTopColor: colors.ink,
  },
  tick: {
    width: 5,
    height: 9,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: colors.onInk,
    transform: [{ rotate: "45deg" }],
    marginTop: -2,
  },
});

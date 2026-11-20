import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ErrorLine, Heading, Shell } from "../../components/onboarding/Shell";
import { PrimaryButton, TextButton } from "../../components/onboarding/Buttons";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { askPushPermission, registerForPush } from "../../lib/push";
import { type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ZaviAppIcon } from "../../components/ZaviAppIcon";
import { track } from "../../lib/analytics";

const preview = {
  centerPaddingTop: 0,
  stackMarginTop: 39,
  stackMarginBottom: 30,
  stackPaddingBottom: 18,
  ghostHeight: 70,
  ghostRadius: 23,
  backGhostBottom: 5,
  backGhostInset: 21,
  frontGhostBottom: 12,
  frontGhostInset: 10,
  cardRadius: 24,
  cardPaddingV: 17,
  cardPaddingH: 14,
  cardGap: 12,
  tileSize: 42,
  tileRadius: 11,
  titleSize: 14,
  timeSize: 10,
  bodySize: 12,
  bodyLine: 18,
} as const;

export default function Notifications5() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { patch, ready, finish, prewarmFinish, flow, finishError } = useOnboarding();
  const [busy, setBusy] = useState<null | "primary" | "later">(null);
  const [error, setError] = useState<string | null>(null);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);

  useEffect(() => {
    if (ready) prewarmFinish();
  }, [ready, prewarmFinish]);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "notifications", mode });
  }, [ready, mode]);

  if (!ready) return null;

  async function complete(outcome: "allowed" | "denied" | "later") {
    setError(null);
    patch({ notification: outcome });
    track("onboarding_notifications_answered", { outcome });
    if (flow !== "replay") {
      setBusy(null);
      router.push("/(onboarding)/setup");
      return;
    }
    if (!(await finish())) {
      setBusy(null);
      setError("Couldn't save your company details. Check your connection and try again.");
    }
  }

  async function onTurnOn() {
    if (busy) return;
    setBusy("primary");
    let outcome: "allowed" | "denied" = "denied";
    try {
      outcome = (await askPushPermission()) ? "allowed" : "denied";
      if (outcome === "allowed") void registerForPush().catch(() => {});
    } catch {
    }
    await complete(outcome);
  }

  function onLater() {
    if (busy) return;
    setBusy("later");
    void complete("later");
  }

  return (
    <Shell
      step={5}
      onBack={() => router.back()}
      footer={
        <>
          <PrimaryButton
            label="Turn on notifications"
            onPress={onTurnOn}
            busy={busy === "primary"}
            disabled={busy === "later"}
          />
          <TextButton
            label="Maybe later"
            onPress={onLater}
            busy={busy === "later"}
            disabled={busy === "primary"}
          />
        </>
      }
    >
      <View style={styles.center}>
        <Heading
          center
          title="Stay in the loop."
          sub="Get an alert when Zavi has an update or needs your approval."
        />

        {}
        <View style={styles.stack}>
          <View style={styles.ghostBack} />
          <View style={styles.ghostFront} />

          <View style={styles.card}>
            <ZaviAppIcon size={preview.tileSize} radius={preview.tileRadius} />
            <View style={styles.cardBody}>
              <View style={styles.cardRow}>
                <Text style={styles.cardTitle}>Zavi</Text>
                <Text style={styles.cardTime}>now</Text>
              </View>
              <Text style={styles.cardText}>
                Your next action is ready.{"\n"}Take a look when you have a moment.
              </Text>
            </View>
          </View>
        </View>
      </View>

      {}
      <ErrorLine message={error ? (finishError ?? error) : null} />
    </Shell>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  center: { paddingTop: preview.centerPaddingTop },
  stack: {
    position: "relative",
    marginTop: preview.stackMarginTop,
    marginBottom: preview.stackMarginBottom,
    paddingBottom: preview.stackPaddingBottom,
  },
  ghostBack: {
    position: "absolute",
    bottom: preview.backGhostBottom,
    left: preview.backGhostInset,
    right: preview.backGhostInset,
    height: preview.ghostHeight,
    borderRadius: preview.ghostRadius,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.form.panel,
  },
  ghostFront: {
    position: "absolute",
    bottom: preview.frontGhostBottom,
    left: preview.frontGhostInset,
    right: preview.frontGhostInset,
    height: preview.ghostHeight,
    borderRadius: preview.ghostRadius,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.bg,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: preview.cardGap,
    paddingVertical: preview.cardPaddingV,
    paddingHorizontal: preview.cardPaddingH,
    borderRadius: preview.cardRadius,
    borderWidth: 1,
    borderColor: colors.form.edge,
    backgroundColor: colors.bg,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.03,
    shadowRadius: 11,
    elevation: 2,
  },
  cardBody: { flex: 1 },
  cardRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  cardTitle: { includeFontPadding: false, fontFamily: "Inter_600SemiBold", fontSize: preview.titleSize, color: colors.ink },
  cardTime: { includeFontPadding: false, fontFamily: "Inter_400Regular", fontSize: preview.timeSize, color: colors.form.soft },
  cardText: {
    marginTop: 5,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: preview.bodySize,
    lineHeight: preview.bodyLine,
    color: colors.form.soft,
  },
});

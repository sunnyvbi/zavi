import { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Shell, Heading, ErrorLine } from "../../components/onboarding/Shell";
import { PrimaryButton } from "../../components/onboarding/Buttons";
import { Field } from "../../components/onboarding/Field";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { LIMITS } from "../../features/onboarding/types";
import { UnderlinedText } from "../../components/UnderlinedText";
import { font, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { track } from "../../lib/analytics";

function splitWebsite(raw: string): { scheme: string; host: string; rest: string } {
  const trimmed = raw.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  const body = scheme ? trimmed.slice(scheme[0].length) : trimmed;
  const cut = body.search(/[/?#]/);
  return {
    scheme: scheme ? scheme[0].toLowerCase() : "https://",
    host: (cut < 0 ? body : body.slice(0, cut)).toLowerCase(),
    rest: cut < 0 ? "" : body.slice(cut),
  };
}

function normaliseWebsite(raw: string): string {
  if (!raw.trim()) return "";
  const { scheme, host, rest } = splitWebsite(raw);
  return `${scheme}${host}${rest}`;
}

export default function Website() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { data, patch, suggestedWebsite, ready, flow, cancelFlow } = useOnboarding();
  const [error, setError] = useState<string | null>(null);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "website", mode });
  }, [ready, mode]);

  if (!ready) return null;

  const fromEmail = suggestedWebsite !== "" && data.website === suggestedWebsite;

  function onChange(text: string) {
    setError(null);
    patch({ website: text });
  }

  function onFromScratch() {
    Keyboard.dismiss();
    track("onboarding_path_switched", { to: "idea" });
    setError(null);
    patch({ noSite: true, website: "" });
    router.push("/(onboarding)/idea");
  }

  function onContinue() {
    const typed = data.website.trim();
    if (!typed) {
      track("onboarding_website_invalid");
      setError("Add your website.");
      return;
    }
    if (!splitWebsite(typed).host.includes(".")) {
      track("onboarding_website_invalid");
      setError("That does not look like a website address.");
      return;
    }
    setError(null);
    track("onboarding_website_submitted");
    patch({ noSite: false, website: normaliseWebsite(typed) });
    router.push("/(onboarding)/scanning");
  }

  return (
    <Shell
      step={1}
      hideBack={!flow}
      onBack={() => {
        track("onboarding_exited", { from: "website_intake" });
        cancelFlow();
        router.back();
      }}
      footer={
        <PrimaryButton
          label="Continue"
          onPress={onContinue}
          dimmed={!data.website.trim()}
        />
      }
    >
      <Heading
        title="Let’s set up your ZAVI workspace"
        sub="Your workspace is where your AI workflows, data, and ideas come together."
      />

      <Field
        label="Add your website."
        placeholder="yourcompany.com"
        hint={fromEmail ? "Added from your email. You can change it." : undefined}
        value={data.website}
        onChangeText={onChange}
        inputMode="url"
        autoCapitalize="none"
        autoComplete="url"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={onContinue}
        maxLength={LIMITS.website}
        autoFocus
      />
      <ErrorLine message={error} />

      <View style={styles.scratch}>
        <Text style={styles.scratchText}>Don’t have a website yet? </Text>
        <Pressable onPress={onFromScratch} hitSlop={6} accessibilityRole="button" accessibilityLabel="Create one from scratch">
          <UnderlinedText style={styles.scratchLink}>Create one from scratch</UnderlinedText>
        </Pressable>
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scratch: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", marginTop: 16 },
    scratchText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 13, color: colors.muted },
    scratchLink: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: colors.ink },
  });

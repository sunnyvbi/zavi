import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ErrorLine, Heading, Shell } from "../../components/onboarding/Shell";
import { PrimaryButton } from "../../components/onboarding/Buttons";
import { Field } from "../../components/onboarding/Field";
import { type } from "../../components/onboarding/design";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { LIMITS, MAX_COMPETITORS, type Competitor } from "../../features/onboarding/types";
import { type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { track } from "../../lib/analytics";

export default function Competitors() {
  const styles = useStyles(makeStyles);
  const { colors, dark } = useTheme();
  const router = useRouter();
  const { data, patch, ready, flow } = useOnboarding();
  const [error, setError] = useState<string | null>(null);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);
  const nameRefs = useRef<(TextInput | null)[]>([]);

  const competitors = data.competitors;
  const full = competitors.length >= MAX_COMPETITORS;
  const missingName = competitors.findIndex((c) => !c.name.trim() && !!c.domain.trim());

  useEffect(() => {
    if (pendingFocus === null) return;
    nameRefs.current[pendingFocus]?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "competitors", mode });
  }, [ready, mode]);

  function write(next: Competitor[]) {
    setError(null);
    patch({ competitors: next });
  }

  function update(index: number, fields: Partial<Competitor>) {
    write(competitors.map((c, i) => (i === index ? { ...c, ...fields } : c)));
  }

  function remove(index: number) {
    nameRefs.current.splice(index, 1);
    write(competitors.filter((_, i) => i !== index));
    track("onboarding_competitor_removed");
  }

  function add() {
    if (full) return;
    setPendingFocus(competitors.length);
    write([...competitors, { name: "", domain: "" }]);
    track("onboarding_competitor_added");
  }

  function onContinue() {
    if (missingName >= 0) {
      setError(`Give competitor ${missingName + 1} a name.`);
      return;
    }
    const kept = competitors
      .map((c) => ({ name: c.name.trim(), domain: c.domain.trim() }))
      .filter((c) => c.name || c.domain);
    patch({ competitors: kept });
    router.push("/(onboarding)/notifications");
  }

  if (!ready) return null;

  return (
    <Shell
      step={4}
      onBack={() => router.back()}
      footer={
        <>
          <ErrorLine message={error} />
          <PrimaryButton label="Continue" onPress={onContinue} dimmed={missingName >= 0} />
        </>
      }
    >
      <Heading
        title="Review your competitors"
        sub="We’ll use this list to compare your brand’s visibility across topics and find gaps and opportunities. Review the initial list below."
      />

      {competitors.length === 0 ? (
        <Text style={styles.empty}>Add competitors you know. You can also do this later.</Text>
      ) : null}

      {}
      {competitors.map((competitor, index) => (
        <View key={index} style={styles.entry}>
          <View style={styles.row}>
            <View style={styles.rowLead}>
              {}
              <View style={[styles.initial, dark && { backgroundColor: colors.soft }]}>
                <Text style={styles.initialText}>{(competitor.name.trim()[0] ?? String(index + 1)).toUpperCase()}</Text>
              </View>
              <Text style={styles.rowTitle}>{`COMPETITOR ${index + 1}`}</Text>
            </View>
            <Pressable
              style={styles.iconButton}
              onPress={() => remove(index)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove competitor ${index + 1}`}
            >
              <Text style={styles.iconGlyph}>×</Text>
            </Pressable>
          </View>

          <Field
            compact
            ref={(node) => {
              nameRefs.current[index] = node;
            }}
            label="Name"
            placeholder="Company name"
            maxLength={LIMITS.competitorName}
            value={competitor.name}
            onChangeText={(text) => update(index, { name: text })}
          />

          <Field
            compact
            label="Website"
            placeholder="company.com"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={LIMITS.competitorDomain}
            value={competitor.domain}
            onChangeText={(text) => update(index, { domain: text })}
          />
        </View>
      ))}

      {}
      <Pressable
        style={[styles.add, full && styles.addDimmed]}
        onPress={add}
        accessibilityRole="button"
        accessibilityState={{ disabled: full }}
      >
        <View style={styles.plus}>
          <View style={styles.plusBar} />
          <View style={styles.plusStem} />
        </View>
        <Text style={styles.addLabel}>Add competitor</Text>
      </Pressable>
    </Shell>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  empty: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.subSize,
    lineHeight: type.subLine,
    color: colors.form.soft,
    marginBottom: 24,
  },
  entry: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.form.edge,
    padding: 12,
    borderRadius: 16,
    marginVertical: 8,
    shadowColor: "#101828",
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  rowLead: { flexDirection: "row", alignItems: "center", gap: 8 },
  initial: { width: 24, height: 24, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: "#e6f2ff" },
  initialText: { fontFamily: "Inter_700Bold", includeFontPadding: false, fontSize: 11, color: "#027bff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowTitle: {
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.form.placeholder,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: {
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: 20,
    lineHeight: 24,
    color: colors.ink,
  },
  add: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 8,
  },
  addDimmed: { opacity: 0.28 },
  addLabel: {
    fontFamily: "Inter_600SemiBold",
    includeFontPadding: false,
    fontSize: 14,
    color: colors.ink,
  },
  plus: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  plusBar: {
    position: "absolute",
    width: 16,
    height: 1.5,
    backgroundColor: colors.ink,
  },
  plusStem: {
    position: "absolute",
    width: 1.5,
    height: 16,
    backgroundColor: colors.ink,
  },
});

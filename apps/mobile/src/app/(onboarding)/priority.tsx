import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useRouter } from "expo-router";
import { ErrorLine, Heading, Shell } from "../../components/onboarding/Shell";
import { PrimaryButton } from "../../components/onboarding/Buttons";
import { type } from "../../components/onboarding/design";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { GOALS } from "../../features/onboarding/types";
import { type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { track } from "../../lib/analytics";

const choice = {
  gap: 9,
  rowGap: 13,
  minHeight: 66,
  paddingV: 13,
  paddingH: 15,
  radius: 16,
  titleSize: 14,
  iconSize: 38,
  iconRadius: 11,
  checkSize: 20,
} as const;

const TINT: Record<string, string> = {
  social: "#e6f2ff",
  search: "#f5faf8",
  ads: "#fffaf0",
  launch: "#f3efff",
  time: "#eef2f7",
};

function GoalIcon({ id, color }: { id: string; color: string }) {
  const p = { stroke: color, strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", fill: "none" } as const;
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      {id === "social" ? (
        <>
          <Path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" {...p} />
          <Path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" {...p} />
          <Path d="M8 6v8" {...p} />
        </>
      ) : null}
      {id === "search" ? (
        <>
          <Circle cx="11" cy="11" r="8" {...p} />
          <Path d="m21 21-4.34-4.34" {...p} />
        </>
      ) : null}
      {id === "ads" ? (
        <>
          <Circle cx="12" cy="12" r="10" {...p} />
          <Circle cx="12" cy="12" r="6" {...p} />
          <Circle cx="12" cy="12" r="2" {...p} />
        </>
      ) : null}
      {id === "launch" ? (
        <>
          <Path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" {...p} />
          <Path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" {...p} />
          <Path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" {...p} />
          <Path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" {...p} />
        </>
      ) : null}
      {id === "time" ? (
        <>
          <Path d="M10 2h4" {...p} />
          <Path d="M12 14l3-3" {...p} />
          <Circle cx="12" cy="14" r="8" {...p} />
        </>
      ) : null}
    </Svg>
  );
}

export default function Priority() {
  const styles = useStyles(makeStyles);
  const { colors, dark } = useTheme();
  const router = useRouter();
  const { data, patch, ready, flow } = useOnboarding();
  const [error, setError] = useState<string | null>(null);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "priority", mode });
  }, [ready, mode]);

  if (!ready) return null;

  const selected = data.goal;

  function onPick(id: string) {
    patch({ goal: id });
    track("onboarding_priority_picked", { priority: id });
    setError(null);
  }

  function onContinue() {
    if (!selected) {
      setError("Pick one priority to continue.");
      return;
    }
    setError(null);
    router.push("/(onboarding)/competitors");
  }

  return (
    <Shell
      step={3}
      onBack={() => router.back()}
      footer={<PrimaryButton label="Continue" onPress={onContinue} dimmed={!selected} />}
    >
      <Heading title={"What should we\ntake on first?"} sub="Pick one priority. You can do more later." />

      {}
      <View style={styles.list} accessibilityRole="radiogroup">
        {GOALS.map((goal) => {
          const on = selected === goal.id;
          return (
            <Pressable
              key={goal.id}
              style={[styles.choice, on && styles.choiceOn]}
              onPress={() => onPick(goal.id)}
              accessible
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${goal.title}. ${goal.sub}`}
            >
              <View style={[styles.icon, { backgroundColor: dark ? colors.soft : TINT[goal.id] ?? colors.soft }]}>
                <GoalIcon id={goal.id} color={colors.ink} />
              </View>
              <View style={styles.copy}>
                <Text style={styles.title}>{goal.title}</Text>
                <Text style={styles.sub}>{goal.sub}</Text>
              </View>
              <View style={[styles.check, on && styles.checkOn]}>
                {on ? <View style={styles.checkMark} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <ErrorLine message={error} />
    </Shell>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  list: { gap: choice.gap },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: choice.rowGap,
    minHeight: choice.minHeight,
    paddingVertical: choice.paddingV,
    paddingHorizontal: choice.paddingH,
    borderWidth: 1,
    borderColor: colors.form.edge,
    borderRadius: choice.radius,
    backgroundColor: colors.bg,
  },
  choiceOn: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.form.panel,
  },
  icon: {
    borderWidth: 1,
    borderColor: colors.line,
    width: choice.iconSize,
    height: choice.iconSize,
    borderRadius: choice.iconRadius,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1 },
  title: {
    fontFamily: "Inter_700Bold",
    includeFontPadding: false,
    fontSize: 15,
    color: colors.ink,
  },
  sub: {
    marginTop: 3,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.hintSize,
    lineHeight: type.hintLine,
    color: colors.form.soft,
  },
  check: {
    width: choice.checkSize,
    height: choice.checkSize,
    borderRadius: choice.checkSize / 2,
    borderWidth: 1,
    borderColor: colors.form.edge,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  checkMark: {
    width: 5,
    height: 9,
    borderRightWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: colors.onInk,
    transform: [{ rotate: "45deg" }],
    marginTop: -2,
  },
});

import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ErrorLine, Heading, Shell } from "../../components/onboarding/Shell";
import { PrimaryButton } from "../../components/onboarding/Buttons";
import { Field } from "../../components/onboarding/Field";
import { type } from "../../components/onboarding/design";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { LIMITS } from "../../features/onboarding/types";
import { type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { track } from "../../lib/analytics";

const MIN_IDEA = 8;

export default function Business() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { data, patch, ready, replaying, flow } = useOnboarding();
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const mode = flow === "add" ? "add_company" : flow ?? "first";
  const viewed = useRef(false);
  const [open, setOpen] = useState(false);

  const workspaceRef = useRef<TextInput>(null);
  const descriptionRef = useRef<TextInput>(null);
  const audienceRef = useRef<TextInput>(null);

  const chevronTurn = useRef(new Animated.Value(0)).current;

  const startedWithName = useRef<boolean | null>(null);
  if (ready && startedWithName.current === null) {
    startedWithName.current = data.workspace.trim().length > 0;
  }
  const collapsible = startedWithName.current === true;
  const expanded = open || data.workspace.trim().length === 0;

  const focusDone = useRef(false);
  useEffect(() => {
    if (!ready || focusDone.current) return;
    focusDone.current = true;
    if (!data.workspace.trim()) workspaceRef.current?.focus();
    else if (!data.description.trim()) descriptionRef.current?.focus();
    else if (!data.audience.trim()) audienceRef.current?.focus();
  }, [ready, data.workspace, data.description, data.audience]);

  useEffect(() => {
    Animated.timing(chevronTurn, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded, chevronTurn]);

  useEffect(() => {
    if (!ready || viewed.current) return;
    viewed.current = true;
    track("onboarding_step_viewed", { step: "business", mode });
  }, [ready, mode]);

  if (!ready) return null;

  const building = data.noSite && !replaying;
  const workspace = data.workspace.trim();
  const description = data.description.trim();
  const incomplete = !workspace || (building ? description.length < MIN_IDEA : !description);

  function onContinue() {
    if (!data.workspace.trim()) {
      setOpen(true);
      setWorkspaceError("Give your workspace a name.");
      setDescriptionError(null);
      return;
    }
    if (!data.description.trim()) {
      setWorkspaceError(null);
      setDescriptionError(building ? "Tell Zavi what you want to build." : "Tell Zavi what your business does.");
      return;
    }
    if (building && data.description.trim().length < MIN_IDEA) {
      setWorkspaceError(null);
      setDescriptionError("Add a little more about what you want to build.");
      return;
    }
    setWorkspaceError(null);
    setDescriptionError(null);
    track("onboarding_business_submitted");
    router.push(building ? "/(onboarding)/notifications" : "/(onboarding)/priority");
  }

  function edit(fields: Partial<typeof data>) {
    patch(fields);
    if ("workspace" in fields && workspaceError) setWorkspaceError(null);
    if ("description" in fields && descriptionError) setDescriptionError(null);
  }

  const workspaceField = (
    <Field
      ref={workspaceRef}
      label="Workspace name"
      placeholder="Your company or project"
      autoComplete="organization"
      maxLength={LIMITS.workspace}
      value={data.workspace}
      onChangeText={(v) => edit({ workspace: v })}
    />
  );

  return (
    <Shell
      step={2}
      onBack={() => router.back()}
      footer={<PrimaryButton label="Continue" onPress={onContinue} dimmed={incomplete} />}
    >
      <Heading
        title={building ? "What should Zavi build?" : "What should Zavi know?"}
        sub={building ? "Describe your idea. Zavi builds it for you." : "Review your business details."}
      />

      {}
      {data.website ? (
        <View style={styles.status}>
          <View style={styles.fileGlyph}>
            <View style={styles.fileLineLong} />
            <View style={styles.fileLineShort} />
          </View>
          <Text style={styles.statusText} numberOfLines={1}>
            {data.website}
          </Text>
        </View>
      ) : null}

      {}
      {collapsible ? (
        <View style={styles.accordion}>
          <Pressable
            style={styles.summary}
            onPress={() => {
              if (data.workspace.trim().length === 0) return;
              setOpen(!expanded);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${data.workspace}. Workspace name. Edit`}
          >
            <View style={styles.summaryText}>
              <Text style={styles.name}>{data.workspace}</Text>
              <Text style={styles.nameSub}>Workspace name · Edit</Text>
            </View>
            <Animated.View
              style={[styles.chevronBox, { transform: [{ rotate: turn(chevronTurn) }] }]}
            >
              <View style={styles.chevron} />
            </Animated.View>
          </Pressable>
          {expanded ? <View style={styles.panel}>{workspaceField}</View> : null}
        </View>
      ) : (
        workspaceField
      )}
      <ErrorLine message={workspaceError} />

      <Field
        ref={descriptionRef}
        label={building ? "What do you want to build?" : "What does your business do?"}
        placeholder={building ? "An app that…" : "We help…"}
        multiline
        maxLength={LIMITS.description}
        value={data.description}
        onChangeText={(v) => edit({ description: v })}
      />
      <ErrorLine message={descriptionError} />

      <Field
        ref={audienceRef}
        label="Who is it for?"
        placeholder="The people you want to reach…"
        multiline
        maxLength={LIMITS.audience}
        value={data.audience}
        onChangeText={(v) => edit({ audience: v })}
      />
    </Shell>
  );
}

function turn(value: Animated.Value): Animated.AnimatedInterpolation<string> {
  return value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] });
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  statusText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.hintSize,
    color: colors.form.soft,
  },
  fileGlyph: {
    width: 13,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.form.soft,
    borderRadius: 2,
    paddingHorizontal: 2,
    paddingTop: 7.5,
    gap: 2,
  },
  fileLineLong: { height: 1.5, width: 7, backgroundColor: colors.form.soft, borderRadius: 1 },
  fileLineShort: { height: 1.5, width: 5, backgroundColor: colors.form.soft, borderRadius: 1 },
  accordion: { borderBottomWidth: 1, borderBottomColor: colors.form.edge },
  summary: {
    minHeight: 70,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  summaryText: { flex: 1, minWidth: 0 },
  name: { includeFontPadding: false, fontFamily: "Inter_400Regular", fontSize: type.subSize, color: colors.ink },
  nameSub: {
    marginTop: 4,
    fontFamily: "Inter_400Regular",
    includeFontPadding: false,
    fontSize: type.hintSize,
    lineHeight: type.hintLine,
    color: colors.form.soft,
  },
  panel: { paddingBottom: 18 },
  chevronBox: { width: 17, height: 17, alignItems: "center", justifyContent: "center" },
  chevron: {
    width: 8,
    height: 8,
    borderRightWidth: 1.8,
    borderBottomWidth: 1.8,
    borderColor: colors.form.soft,
    transform: [{ rotate: "45deg" }],
    marginBottom: 3,
  },
});

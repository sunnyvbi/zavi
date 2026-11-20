import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { LoadingScreen } from "../components/LoadingScreen";
import { ErrorCard } from "../components/ErrorCard";
import { BackIcon, Icon } from "../components/Icon";
import { UnderlinedText } from "../components/UnderlinedText";
import { ZaviWordmark } from "../components/ZaviWordmark";
import { showDialog } from "../components/DialogHost";
import { PrimaryButton } from "../components/settings/SettingsUI";
import { WorkspaceSheet } from "../components/settings/WorkspaceSheet";
import { useWorkspace } from "../features/workspaces/WorkspaceProvider";
import { ImportStep } from "../components/setup/ImportStep";
import { ConnectorsStep } from "../components/setup/ConnectorsStep";
import { PolishStep } from "../components/setup/PolishStep";
import { SetupStepsSheet } from "../components/setup/SetupStepsSheet";
import { useSetup } from "../features/setup/SetupProvider";
import { useAiConsent } from "../features/consent/useAiConsent";
import { currentStep, stepStatuses } from "../features/setup/state";
import * as copy from "../features/setup/copy";
import { resetTo } from "../lib/nav";
import { track } from "../lib/analytics";
import { font, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

const ignorePolishDirty = () => undefined;

export default function Setup() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const setup = useSetup();
  const consent = useAiConsent();
  const { tenants } = useWorkspace();
  const workspaces = useRef<BottomSheetModal>(null);
  const s = setup.state?.enabled === true ? setup.state : null;
  const [viewing, setViewing] = useState<1 | 2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const step = s ? currentStep(s) : 1;
  const shown: 1 | 2 | 3 = viewing !== null && viewing < step ? viewing : step;
  const nextStep = shown === 1 && step > 2 ? 2 : null;

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (shown > 1) {
        setViewing((shown - 1) as 1 | 2);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [shown]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!s || s.done) {
    if (setup.loadError) {
      return (
        <SafeAreaView style={styles.screen} edges={["top", "bottom", "left", "right"]}>
          <View style={styles.center}>
            <ErrorCard message={copy.LOAD_FAILED} />
            <PrimaryButton label={copy.TRY_AGAIN} onPress={() => {
              Keyboard.dismiss();
              void setup.refresh();
            }} />
          </View>
        </SafeAreaView>
      );
    }
    return <LoadingScreen />;
  }

  const oneState = s.one_state === true;
  const fromScratch = s.from_scratch === true;
  const markDocs = (outcome: "done" | "skipped") =>
    run(async () => {
      await setup.mark({ step: "docs", outcome });
      track("setup_step_completed", { step: "docs", skipped: outcome === "skipped" });
    });
  const markConnectors = (outcome: "done" | "skipped") =>
    run(async () => {
      await setup.mark({ step: "connectors", outcome });
      track("setup_step_completed", { step: "connectors", skipped: outcome === "skipped" });
      setup.startDraft();
    });

  const landOnGrowth = () => {
    if (consent.status === "needed") return;
    resetTo("/chat");
    router.push("/growth");
  };

  const finish = async (problems: string[]) => {
    await run(async () => {
      await setup.mark({ step: "done" });
      track("setup_step_completed", { step: "polish", skipped: false });
      track("setup_finished");
      if (problems.length) {
        await showDialog({ title: "Saved, with a gap", message: copy.finishNote(problems), confirmLabel: "OK" });
      }
      landOnGrowth();
    });
  };

  const statuses = stepStatuses(s);
  const sub = copy.STEP_SUBS[shown - 1];
  const header = (
    <View style={styles.head}>
      <Text style={styles.title} accessibilityRole="header">
        {copy.STEP_TITLES[shown - 1]}
      </Text>
      {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      <Pressable
        onPress={() => {
          Keyboard.dismiss();
          void showDialog({ title: copy.WHY_TITLE, message: copy.WHY[shown - 1], icon: "sparkles", confirmLabel: "OK" });
        }}
        style={styles.why}
        accessibilityRole="button"
        hitSlop={6}
      >
        <Icon name="helpCircle" size={16} color={colors.textSecondary} />
        <UnderlinedText style={styles.whyText}>{copy.WHY_TITLE}</UnderlinedText>
      </Pressable>
      {error ? <ErrorCard message={error} style={styles.error} /> : null}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        {shown > 1 ? (
          <>
            <View style={styles.headerSide}>
              <Pressable
                onPress={() => {
                  Keyboard.dismiss();
                  setViewing((shown - 1) as 1 | 2);
                }}
                style={styles.headerButton}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={8}
              >
                <BackIcon color={colors.ink} />
              </Pressable>
            </View>
            <ZaviWordmark width={64} />
          </>
        ) : (
          <View style={[styles.headerSide, styles.headerLogoOnly]}>
            <ZaviWordmark width={64} />
          </View>
        )}
        <View style={[styles.headerSide, styles.headerRight]}>
          {}
          {tenants.length > 1 && !setup.busy ? (
            <Pressable onPress={() => {
              Keyboard.dismiss();
              workspaces.current?.present();
            }} accessibilityRole="button" hitSlop={6}>
              <UnderlinedText style={styles.headerLink}>{copy.SWITCH_COMPANY}</UnderlinedText>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setStepsOpen(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${copy.stepOf(shown)}, show all steps`}
            hitSlop={8}
          >
            <UnderlinedText style={styles.headerLink}>{copy.stepOf(shown)}</UnderlinedText>
          </Pressable>
        </View>
      </View>

      <View style={styles.flex}>
        {shown === 1 ? (
          <ImportStep
            header={header}
            reopened={viewing === 1}
            skipBody={copy.skip1Body(oneState, fromScratch)}
            backStep={nextStep ?? step}
            onFinish={viewing === 1 ? () => {
              Keyboard.dismiss();
              setViewing(nextStep);
            } : () => {
              Keyboard.dismiss();
              return markDocs("done");
            }}
            onSkip={() => {
              Keyboard.dismiss();
              return markDocs("skipped");
            }}
          />
        ) : null}
        {shown === 2 ? (
          <ConnectorsStep
            header={header}
            reopened={viewing === 2}
            onContinue={viewing === 2 ? () => {
              Keyboard.dismiss();
              setViewing(nextStep);
            } : () => {
              Keyboard.dismiss();
              return markConnectors("done");
            }}
            onSkip={viewing === 2 ? () => {
              Keyboard.dismiss();
              setViewing(nextStep);
            } : () => {
              Keyboard.dismiss();
              return markConnectors("skipped");
            }}
          />
        ) : null}
        {}
        {step === 3 ? (
          <View style={[styles.flex, shown !== 3 && styles.hidden]}>
            <PolishStep
              header={header}
              skipBody={copy.skip3Body(oneState, fromScratch)}
              onDirtyChange={ignorePolishDirty}
              onSkip={() => {
                Keyboard.dismiss();
                return run(async () => {
                  await setup.mark({ step: "done" });
                  track("setup_step_completed", { step: "polish", skipped: true });
                  track("setup_finished");
                });
              }}
              onFinish={(problems) => {
                Keyboard.dismiss();
                return finish(problems);
              }}
            />
          </View>
        ) : null}
      </View>
      <WorkspaceSheet ref={workspaces} />
      <SetupStepsSheet open={stepsOpen} onClose={() => {
        Keyboard.dismiss();
        setStepsOpen(false);
      }} shown={shown} statuses={statuses} />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    flex: { flex: 1 },
    hidden: { display: "none" },
    center: { flex: 1, justifyContent: "center", padding: space.lg, gap: space.lg },
    header: {
      height: 64,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headerSide: { flex: 1, flexDirection: "row", alignItems: "center" },
    headerLogoOnly: { paddingLeft: space.md },
    headerButton: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    headerRight: { justifyContent: "flex-end", gap: space.md, paddingRight: space.md },
    headerLink: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.ink },
    head: { marginBottom: space.xl },
    title: { fontFamily: font.family.bold, fontSize: 24, lineHeight: 30, color: colors.ink },
    sub: { marginTop: space.sm, fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    why: { marginTop: space.md, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
    whyText: { fontFamily: font.family.semi, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
    error: { marginTop: space.md },
  });

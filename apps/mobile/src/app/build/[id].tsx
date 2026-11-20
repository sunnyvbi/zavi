import { useMemo, useRef, useState } from "react";
import { BUILD_ESTIMATE_NOTE } from "@zavi/shared";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { BackHeader, SectionLabel, settingsStyles } from "../../components/settings/SettingsUI";
import { BuildEmptyState, BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { BuildProgress } from "../../components/build/BuildProgress";
import { BuildChanges } from "../../components/build/BuildChanges";
import { BuildPublish } from "../../components/build/BuildPublish";
import { BuildExport } from "../../components/build/BuildExport";
import { BuildRating } from "../../components/build/BuildRating";
import { SiteLook } from "../../components/build/SiteLook";
import { useCanManage } from "../../features/settings/api";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { cancelBuild, continueBuild } from "../../features/build/api";
import { buildKeys, useBuildRatings, useBuildRefines, useBuildStatus } from "../../features/build/hooks";
import { canRateRefine } from "../../features/build/feedback";
import { siteAppId } from "../../features/build/siteTheme";
import { CardButton } from "../../components/reply/ui";
import {
  buildErrorMessage,
  buildRoleView,
  buildView,
  cleanObjective,
  deriveBuildSteps,
} from "../../features/build/logic";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

function repoNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "") || null;
}

export default function BuildDetail() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const runId = typeof id === "string" && id ? id : null;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const role = buildRoleView(useCanManage());

  const statusQ = useBuildStatus(runId);
  const refinesQ = useBuildRefines(runId);

  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const inFlight = useRef(false);

  const body = statusQ.data ?? null;
  const view = body ? buildView(body) : null;
  const run = body?.run ?? null;
  const canRateBuild = !!view && !view.superseded && (view.status === "ready" || view.status === "stopped");
  const ratingIds = useMemo(
    () => [
      ...(canRateBuild && runId ? [runId] : []),
      ...(refinesQ.data ?? []).filter(canRateRefine).map((r) => r.id),
    ],
    [canRateBuild, runId, refinesQ.data],
  );
  const ratings = useBuildRatings(ratingIds).data ?? {};
  const steps = useMemo(
    () => deriveBuildSteps(run?.stages ?? [], run?.status ?? null, !!view?.live),
    [run?.stages, run?.status, view?.live],
  );

  const reread = () => {
    if (!runId) return;
    void qc.invalidateQueries({ queryKey: buildKeys.status(tenant, runId) });
    void qc.invalidateQueries({ queryKey: buildKeys.sessions(tenant) });
    void qc.invalidateQueries({ queryKey: buildKeys.design(tenant, runId) });
  };

  function onOpen() {
    const url = view?.openUrl;
    if (!url) return;
    void WebBrowser.openBrowserAsync(url).catch(() =>
      Alert.alert("Couldn't open the app", "Try again in a moment."),
    );
  }

  function onStop() {
    if (inFlight.current || !runId) return;
    Alert.alert("Stop this build?", "Zavi stops working on it. Steps already finished are kept.", [
      { text: "Keep building", style: "cancel" },
      { text: "Stop build", style: "destructive", onPress: () => void doStop() },
    ]);
  }

  async function doStop() {
    if (inFlight.current || !runId) return;
    inFlight.current = true;
    setStopping(true);
    setActionError(null);
    try {
      await cancelBuild(runId);
    } catch (e) {
      if ((e as { status?: number } | null)?.status !== 404) {
        setActionError(buildErrorMessage(e, "Couldn't stop the build. Please try again."));
      }
    } finally {
      reread();
      inFlight.current = false;
      setStopping(false);
    }
  }

  async function onContinue() {
    if (inFlight.current || !runId) return;
    inFlight.current = true;
    setContinuing(true);
    setActionError(null);
    try {
      await continueBuild(runId);
    } catch (e) {
      setActionError(buildErrorMessage(e, "Couldn't continue the build. Please try again."));
    } finally {
      reread();
      inFlight.current = false;
      setContinuing(false);
    }
  }

  const siteApp = siteAppId(body?.site?.id);
  const notFound = (statusQ.error as { status?: number } | null)?.status === 404;
  const title = cleanObjective(run?.objective) ?? "Your app";

  return (
    <Screen>
      <BackHeader title="Build" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            view?.status === "building" ? undefined : (
              <RefreshControl
                refreshing={pulling}
                onRefresh={async () => {
                  setPulling(true);
                  await Promise.allSettled([
                    statusQ.refetch(),
                    refinesQ.refetch(),
                    qc.invalidateQueries({ queryKey: buildKeys.builtin(tenant) }),
                    qc.invalidateQueries({ queryKey: ["build-publish-status", tenant] }),
                  ]);
                  setPulling(false);
                }}
                tintColor={colors.muted}
                colors={[colors.ink]}
                progressBackgroundColor={colors.surfaceRaised}
              />
            )
          }
        >
          {!runId || notFound ? (
            <BuildEmptyState text="This build can't be found. It may belong to another workspace." />
          ) : statusQ.isLoading ? (
            <BuildSkeleton rows={6} label="Loading build" />
          ) : statusQ.isError || !body ? (
            <BuildErrorState text="Couldn't load this build." onRetry={() => void statusQ.refetch()} />
          ) : !view ? (
            <BuildEmptyState text="This build can't be found. It may belong to another workspace." />
          ) : (
            <>
              <BuildProgress
                title={title}
                view={view}
                steps={steps}
                stopping={stopping}
                continuing={continuing}
                onOpen={onOpen}
                onStop={onStop}
                onContinue={() => void onContinue()}
                onRetry={() => router.push({ pathname: "/build/new", params: run?.objective ? { idea: title } : {} })}
                onNewBuild={() => router.push("/build/new")}
                actionError={actionError}
              />

              {runId && !view.superseded ? <SiteLook runId={runId} buildActive={view.status === "building"} /> : null}

              {canRateBuild && runId ? (
                <View style={styles.rating}>
                  <BuildRating runId={runId} label="build" saved={ratings[runId] ?? null} />
                </View>
              ) : null}

              {view.canChange && runId ? (
                <>
                  <SectionLabel>Change it</SectionLabel>
                  <BuildChanges
                    runId={runId}
                    refines={refinesQ.data ?? []}
                    refinesLoading={refinesQ.isLoading}
                    refinesFailed={refinesQ.isError}
                    ratings={ratings}
                  />
                </>
              ) : null}

              {view.canChange && siteApp && runId ? (
                <>
                  <SectionLabel>Theme</SectionLabel>
                  <Text style={styles.themeNote}>Colours, fonts, corners and a logo. Changes wait for Publish.</Text>
                  <View style={styles.themeButton}>
                    <CardButton
                      label="Edit theme and logo"
                      variant="secondary"
                      onPress={() => router.push({ pathname: "/build/theme", params: { appId: siteApp, runId } })}
                    />
                  </View>
                </>
              ) : null}

              {view.appHost ? (
                <>
                  <SectionLabel>Publish</SectionLabel>
                  <BuildPublish appHost={view.appHost} canManage={role.canPublish} />
                </>
              ) : null}

              {role.canExport && body.target?.repo_url && !view.superseded ? (
                <>
                  <SectionLabel>Export to GitHub</SectionLabel>
                  <BuildExport repoName={repoNameFromUrl(body.target.repo_url)} runId={runId} />
                </>
              ) : null}

              {view.status === "building" ? (
                <Text style={styles.note}>{`${BUILD_ESTIMATE_NOTE} You can leave this screen; it keeps going.`}</Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  flex: { flex: 1 },
  rating: { marginTop: space.md },
  themeNote: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  themeButton: { flexDirection: "row", marginTop: space.sm },
  note: {
    marginTop: space.xl,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
});

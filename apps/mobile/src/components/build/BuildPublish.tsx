import { useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { CardButton } from "../reply/ui";
import { Icon } from "../Icon";
import { ErrorCard } from "../ErrorCard";
import { ensureBuiltinUrl, publishEdits, saveVisibility, unpublishEdits } from "../../features/build/api";
import { buildKeys, useBuiltinUrl, usePublishStatus, useVisibility } from "../../features/build/hooks";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { track } from "../../lib/analytics";
import {
  VISIBILITY_OPTIONS,
  publishErrorMessage,
  publishOutcome,
  publishView,
  type Visibility,
} from "../../features/build/logic";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function BuildPublish({ appHost, canManage }: { appHost: string; canManage: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const builtinQ = useBuiltinUrl(true);
  const statusQ = usePublishStatus(appHost);
  const visQ = useVisibility(canManage);

  const [publishing, setPublishing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [savingVis, setSavingVis] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (builtinQ.isLoading || statusQ.isLoading) {
    return <Text style={styles.muted}>Loading publish status…</Text>;
  }
  if (builtinQ.isError || statusQ.isError) {
    return (
      <View style={styles.row}>
        <Text style={styles.muted}>Couldn't load publish status.</Text>
        <CardButton
          label="Retry"
          variant="secondary"
          onPress={() => {
            void builtinQ.refetch();
            void statusQ.refetch();
          }}
        />
      </View>
    );
  }

  const builtin = builtinQ.data ?? null;
  const status = statusQ.data ?? null;
  const shownNotice = notice && notice.startsWith("Setting up") && builtin?.status === "live" ? "Published." : notice;
  const view = publishView({ builtin, status });
  const pending = status?.pending ?? 0;
  const busy = publishing || reverting || savingVis;

  const refresh = () => {
    builtinQ.rearm();
    void qc.invalidateQueries({ queryKey: buildKeys.publish(tenant, appHost) });
  };

  async function onPublish() {
    if (inFlight.current || !canManage) return;
    inFlight.current = true;
    setPublishing(true);
    setError(null);
    setNotice(null);
    try {
      let address = builtin;
      if (!address || address.status !== "live") {
        address = await ensureBuiltinUrl();
        if (address) qc.setQueryData(buildKeys.builtin(tenant), address);
      }
      const outcome = publishOutcome(address);
      if (outcome.kind === "blocked" && pending === 0) {
        setError(outcome.text);
        return;
      }
      if (pending > 0) await publishEdits(appHost);
      if (outcome.kind === "published" || outcome.kind === "setting_up") track("build_published");
      if (outcome.kind === "published") setNotice("Published.");
      else if (outcome.kind === "setting_up") setNotice(outcome.text);
      else setError(outcome.text);
    } catch (e) {
      setError(publishErrorMessage(e, "We couldn't publish your app. Try again."));
    } finally {
      refresh();
      inFlight.current = false;
      setPublishing(false);
    }
  }

  function onRevert() {
    if (inFlight.current || !canManage) return;
    Alert.alert(
      "Revert inline edits?",
      "The live site goes back to the app as it was built. Your draft edits stay on zaviagent.com.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Revert", style: "destructive", onPress: () => void doRevert() },
      ],
    );
  }

  async function doRevert() {
    if (inFlight.current) return;
    inFlight.current = true;
    setReverting(true);
    setError(null);
    setNotice(null);
    try {
      await unpublishEdits(appHost);
      track("build_unpublished");
      setNotice("Reverted. The live site shows the original build.");
    } catch (e) {
      setError(publishErrorMessage(e, "Couldn't revert. Try again."));
    } finally {
      refresh();
      inFlight.current = false;
      setReverting(false);
    }
  }

  async function onVisibility(next: Visibility) {
    if (inFlight.current || !canManage || next === visQ.data) return;
    inFlight.current = true;
    setSavingVis(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveVisibility(next);
      qc.setQueryData(buildKeys.visibility(tenant), saved);
    } catch (e) {
      setError(publishErrorMessage(e, "Couldn't change who can see your app. Try again."));
    } finally {
      inFlight.current = false;
      setSavingVis(false);
    }
  }

  const visibility = visQ.data ?? null;
  const storedNotEnforced = visibility !== null && visibility !== "public";

  return (
    <View style={styles.wrap}>
      <View style={styles.statusRow}>
        <View
          style={[
            styles.dot,
            { backgroundColor: view.tone === "live" ? colors.green : view.tone === "waiting" ? colors.amber : colors.muted },
          ]}
        />
        <View style={styles.statusText}>
          <Text style={styles.title}>{view.title}</Text>
          <Text style={styles.sub}>{view.sub}</Text>
          {builtin?.status === "live" && builtin.url ? <Text style={styles.sub}>{builtin.url}</Text> : null}
        </View>
      </View>

      {!canManage ? (
        <Text style={styles.muted}>Only workspace owners and admins can publish.</Text>
      ) : (
        <>
          <View style={styles.row}>
            {view.publishLabel ? (
              <CardButton
                label={publishing ? "Publishing" : view.publishLabel}
                busy={publishing}
                disabled={busy}
                onPress={() => void onPublish()}
              />
            ) : null}
            {view.canRevert ? (
              <CardButton
                label={reverting ? "Reverting" : "Revert inline edits"}
                busy={reverting}
                disabled={busy}
                variant="secondary"
                onPress={onRevert}
              />
            ) : null}
          </View>

          <Text style={styles.label}>Who can see it</Text>
          <View style={styles.options} accessibilityRole="radiogroup">
            {VISIBILITY_OPTIONS.map((o) => {
              const selected = o.enforced && visibility === o.value;
              const disabled = !o.enforced || busy || visQ.isLoading;
              return (
                <Pressable
                  key={o.value}
                  style={({ pressed }) => [styles.option, pressed && !disabled && styles.pressed]}
                  onPress={disabled ? undefined : () => void onVisibility(o.value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled }}
                  accessibilityLabel={o.enforced ? `${o.label}. ${o.hint}` : `${o.label}, coming soon. ${o.hint}`}
                >
                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, !o.enforced && styles.off]}>
                      {o.label}
                      {o.enforced ? "" : " (coming soon)"}
                    </Text>
                    <Text style={[styles.sub, !o.enforced && styles.off]}>{o.hint}</Text>
                  </View>
                  {selected ? <Icon name="check" size={18} color={colors.green} /> : null}
                </Pressable>
              );
            })}
          </View>
          {storedNotEnforced ? (
            <Text style={styles.warn}>
              Your app was set to {visibility}, but access control isn't live yet, so anyone with the link can still
              open it. Choose Public to match.
            </Text>
          ) : null}
        </>
      )}

      {error ? <ErrorCard message={error} style={styles.errorCard} /> : null}
      {shownNotice ? (
        <Text style={styles.ok} accessibilityLiveRegion="polite">
          {shownNotice}
        </Text>
      ) : null}
    </View>
  );
}

const text = { includeFontPadding: false } as const;

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: space.md },
  statusRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  statusText: { flex: 1, gap: 2 },
  title: { ...text, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.ink },
  sub: { ...text, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 17, color: colors.muted },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  muted: { ...text, fontFamily: font.family.regular, fontSize: font.size.sm, color: colors.muted },
  label: { ...text, fontFamily: font.family.semi, fontSize: font.size.sm, color: colors.ink },
  options: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    marginBottom: -1,
  },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { ...text, fontFamily: font.family.medium, fontSize: font.size.base, color: colors.ink },
  off: { opacity: 0.45 },
  pressed: { backgroundColor: colors.soft },
  warn: { ...text, fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, color: colors.amber },
  errorCard: { marginTop: 0 },
  ok: { ...text, fontFamily: font.family.medium, fontSize: font.size.sm, lineHeight: 18, color: colors.green },
});

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "../Icon";
import { ErrorCard } from "../ErrorCard";
import { CardButton } from "../reply/ui";
import { StatusSpinner } from "../channels/ChannelStates";
import { Badge } from "../settings/SettingsUI";
import { WebsiteTile } from "./WebsiteTile";
import { pickLook } from "../../features/build/api";
import { buildKeys, useSiteDesign } from "../../features/build/hooks";
import { buildErrorMessage } from "../../features/build/logic";
import {
  ASK_FOR_NEW_LOOK,
  BUILD_WITH_LOOK,
  LAYOUT_SET_LINE,
  PICK_FAILED,
  PICK_FIRST,
  PICK_HEADING,
  START_FAILED,
  SWITCH_FREE_LINE,
  awaitsPick,
  collapsedLook,
  countdownLine,
  lookStartedLine,
  recommendedLook,
  secondsLeft,
  selectedLookLine,
  websiteNumber,
  type SiteDesign,
  type SiteLook,
} from "../../features/build/siteDesign";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

function useSecondsLeft(deadlineMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadlineMs) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);
  return secondsLeft(deadlineMs, now);
}

export function SiteLook({ runId, buildActive }: { runId: string; buildActive: boolean }) {
  const styles = useStyles(makeStyles);
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const q = useSiteDesign(runId, buildActive);
  const design = q.data ?? null;

  const [selected, setSelected] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const picking = awaitsPick(design, started);
  const secs = useSecondsLeft(picking ? design?.deadline_ms ?? null : null);

  const { refetch } = q;
  useEffect(() => {
    if (secs !== 0) return;
    const t = setTimeout(() => void refetch(), 1500);
    return () => clearTimeout(t);
  }, [secs, refetch]);

  if (!design || design.looks.length === 0) return null;

  async function choose(lookId: string, mode: "start" | "switch") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(lookId);
    setError(null);
    try {
      const next = await pickLook(runId, lookId);
      if (next) qc.setQueryData(buildKeys.design(tenant, runId), next);
      setStarted(lookId);
      if (mode === "switch") setChanging(false);
      void qc.invalidateQueries({ queryKey: buildKeys.status(tenant, runId) });
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 409) void refetch();
      setError(buildErrorMessage(e, mode === "start" ? START_FAILED : PICK_FAILED));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  if (picking) {
    const rec = recommendedLook(design);
    const chosen = design.looks.find((l) => l.id === selected) ?? null;
    return (
      <View style={styles.card} accessibilityLabel="Your site's look">
        <Text style={styles.eyebrow}>Design brief</Text>
        <Text style={styles.heading}>{PICK_HEADING}</Text>
        {rec && secs !== null ? (
          <View style={styles.timer} accessibilityRole="timer" accessibilityLiveRegion="polite">
            <Icon name="timer" size={14} />
            <Text style={styles.timerText}>{countdownLine(rec.label, secs)}</Text>
          </View>
        ) : null}
        <View style={styles.tiles} accessibilityRole="radiogroup">
          {design.looks.map((look, i) => (
            <LookCard
              key={look.id}
              look={look}
              index={i}
              design={design}
              selected={selected === look.id}
              busy={busy === look.id}
              disabled={busy !== null}
              onPress={() => setSelected(look.id)}
            />
          ))}
        </View>
        <Text style={styles.note}>{chosen ? selectedLookLine(chosen.label) : PICK_FIRST}</Text>
        {error ? <ErrorCard message={error} style={styles.error} /> : null}
        <View style={styles.row}>
          <CardButton
            label={BUILD_WITH_LOOK}
            busy={busy !== null}
            disabled={!selected}
            onPress={() => selected && void choose(selected, "start")}
          />
        </View>
      </View>
    );
  }

  const { name, canChange } = collapsedLook(design, started);
  const justStarted = started ? design.looks.find((l) => l.id === started) : null;
  return (
    <View style={styles.card}>
      {justStarted && !changing ? <Text style={styles.note}>{lookStartedLine(justStarted.label)}</Text> : null}
      <View style={styles.lookLine}>
        <Text style={styles.lookText}>
          {"Look: "}
          <Text style={styles.lookName}>{name}</Text>
          {canChange ? " · " : ` · ${ASK_FOR_NEW_LOOK}`}
        </Text>
        {canChange ? (
          <Pressable
            onPress={() => {
              setError(null);
              setChanging((v) => !v);
            }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={styles.change}>{changing ? "Done" : "Change"}</Text>
          </Pressable>
        ) : null}
      </View>
      {changing && canChange ? (
        <>
          <Text style={styles.note}>{`${SWITCH_FREE_LINE}${design.structure ? LAYOUT_SET_LINE : ""}`}</Text>
          <View style={styles.tiles}>
            {design.looks.map((look, i) => (
              <LookCard
                key={look.id}
                look={look}
                index={i}
                design={design}
                selected={look.id === (started ?? design.chosen)}
                busy={busy === look.id}
                disabled={busy !== null}
                onPress={() => void choose(look.id, "switch")}
              />
            ))}
          </View>
          {error ? <ErrorCard message={error} style={styles.error} /> : null}
        </>
      ) : null}
    </View>
  );
}

function LookCard({
  look,
  index,
  design,
  selected,
  busy,
  disabled,
  onPress,
}: {
  look: SiteLook;
  index: number;
  design: SiteDesign;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled, busy }}
      accessibilityLabel={`${websiteNumber(index)}: ${look.label}${look.recommended ? " (recommended)" : ""}`}
      style={[styles.tile, selected && styles.tileOn]}
    >
      <WebsiteTile look={look} fallback={design.preview} />
      <View style={styles.tileFoot}>
        <View style={styles.tileWords}>
          <Text style={styles.tileNumber}>{websiteNumber(index)}</Text>
          <Text style={styles.tileLabel} numberOfLines={1}>
            {look.label}
          </Text>
        </View>
        {look.recommended ? <Badge tone="neutral">Recommended</Badge> : null}
        {busy ? <StatusSpinner size={12} /> : selected ? (
          <View style={styles.check}>
            <Icon name="check" size={12} color={colors.onInk} />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.lg,
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    backgroundColor: colors.panel,
  },
  eyebrow: { fontFamily: font.family.medium, fontSize: font.size.xs, includeFontPadding: false, color: colors.muted },
  heading: { fontFamily: font.family.semi, fontSize: font.size.lg, includeFontPadding: false, color: colors.ink },
  timer: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
  },
  timerText: { fontFamily: font.family.medium, fontSize: font.size.sm, includeFontPadding: false, color: colors.ink },
  tiles: { gap: space.md, marginTop: space.xs },
  tile: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: "hidden" },
  tileOn: { borderColor: colors.ink, borderWidth: 2 },
  tileFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.panel,
  },
  tileWords: { flex: 1, gap: 2 },
  tileNumber: { fontFamily: font.family.regular, fontSize: font.size.xs, includeFontPadding: false, color: colors.muted },
  tileLabel: { fontFamily: font.family.semi, fontSize: font.size.base, includeFontPadding: false, color: colors.ink },
  check: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  note: { fontFamily: font.family.regular, fontSize: font.size.sm, lineHeight: 18, includeFontPadding: false, color: colors.muted },
  error: { marginTop: 0 },
  row: { flexDirection: "row" },
  lookLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  lookText: { fontFamily: font.family.regular, fontSize: font.size.base, includeFontPadding: false, color: colors.ink },
  lookName: { fontFamily: font.family.semi },
  change: { fontFamily: font.family.semi, fontSize: font.size.base, includeFontPadding: false, color: colors.ink, textDecorationLine: "underline" },
});

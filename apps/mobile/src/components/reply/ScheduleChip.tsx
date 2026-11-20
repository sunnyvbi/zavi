import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  cronToShape,
  describeCron,
  deviceTimeZone,
  formatInZone,
  nextRuns,
  parseTimeOfDay,
  scheduleLine,
  timeZoneLabel,
  withTimeOfDay,
  type Schedule,
} from "../../features/agents/schedule";
import {
  deleteSchedule,
  fetchSchedule,
  runAgentNow,
  saveSchedule,
} from "../../features/agents/replyApi";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { FocusRing } from "../ZaviTextField";
import { CardButton, ErrorLine, errorText, makeUi } from "./ui";

const DEFAULT_CRON = "0 9 * * *";

export function ScheduleChip({ slug, flush = false }: { slug: string;  flush?: boolean }) {
  const styles = useStyles(makeStyles);
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetchSchedule(slug);
      setSchedule(res.schedule ?? null);
      setWarning(res.warning ?? null);
    } catch {
      setSchedule(undefined);
      setLoadFailed(true);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const line = loadFailed
    ? "Couldn't load the schedule"
    : schedule === undefined
      ? "Checking schedule"
      : scheduleLine(schedule);

  return (
    <View style={[styles.wrap, flush && styles.flush]}>
      <Pressable
        onPress={() => (loadFailed ? void load() : setOpen((v) => !v))}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      >
        <Text style={styles.clock}>🕒</Text>
        <Text style={styles.line} numberOfLines={flush ? 2 : 1}>
          {line}
        </Text>
        <Text style={styles.change}>
          {loadFailed ? "Retry" : schedule === null ? "Set one" : open ? "Close" : "Change"}
        </Text>
      </Pressable>
      {open && schedule !== undefined ? (
        <ScheduleEditor slug={slug} schedule={schedule} warning={warning} onChanged={load} />
      ) : null}
    </View>
  );
}

function ScheduleEditor({
  slug,
  schedule,
  warning,
  onChanged,
}: {
  slug: string;
  schedule: Schedule | null;
  warning: string | null;
  onChanged: () => Promise<void>;
}) {
  const styles = useStyles(makeStyles);
  const ui = useStyles(makeUi);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const cron = schedule?.cron_expression ?? DEFAULT_CRON;
  const tz = schedule ? (schedule.timezone ?? "UTC") : deviceTimeZone();
  const { shape, time } = cronToShape(cron);
  const hasTime = shape === "daily" || shape === "weekdays" || shape === "weekly";

  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [timeText, setTimeText] = useState(time);
  useEffect(() => {
    setEnabled(schedule?.enabled ?? true);
    setTimeText(time);
  }, [schedule, time]);
  const [busy, setBusy] = useState<null | "save" | "run" | "delete">(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseTimeOfDay(timeText);
  const upcoming = enabled ? nextRuns(hasTime ? (withTimeOfDay(cron, timeText) ?? cron) : cron, tz, 3) : [];

  async function save() {
    const nextCron = hasTime ? withTimeOfDay(cron, timeText) : cron;
    if (!nextCron) {
      setError("Enter a time like 09:30 (24-hour).");
      return;
    }
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      const res = await saveSchedule(
        slug,
        schedule ? { cron_expression: nextCron, enabled } : { cron_expression: nextCron, enabled, timezone: tz },
      );
      setNote(res?.warning ? `Saved. ${res.warning}` : "Saved.");
      await onChanged();
    } catch (e) {
      setError(errorText(e, "Couldn't save the schedule."));
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    setBusy("run");
    setError(null);
    setNote(null);
    try {
      await runAgentNow(slug);
      setNote("Run started.");
    } catch (e) {
      setError(errorText(e, "Couldn't start a run."));
    } finally {
      setBusy(null);
    }
  }

  function confirmDelete() {
    Alert.alert(
      "Delete this schedule?",
      "The agent will stop running automatically until you set a new one.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void remove() },
      ],
    );
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    setNote(null);
    try {
      await deleteSchedule(slug);
      setNote("Schedule removed.");
      await onChanged();
    } catch (e) {
      setError(errorText(e, "Couldn't delete the schedule."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={ui.small}>
        One schedule per channel. Saving replaces the existing one. Each run stages drafts for your
        approval; nothing posts on its own.
      </Text>

      {warning ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>This schedule will not run.</Text>
          <Text style={ui.small}>{warning}</Text>
        </View>
      ) : null}

      <View style={styles.rowBetween}>
        <Text style={styles.label}>On</Text>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          trackColor={{ true: colors.switchOn, false: colors.switchOff }}
          accessibilityLabel="Schedule on"
        />
      </View>

      {hasTime ? (
        <View style={styles.rowBetween}>
          <Text style={styles.label}>Time (24-hour)</Text>
          <FocusRing radius={radius.md} style={styles.timeRing}>
            {(focus) => (
              <TextInput
                keyboardAppearance={keyboardAppearance}
                value={timeText}
                onChangeText={setTimeText}
                placeholder="09:00"
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                style={styles.time}
                accessibilityLabel="Time of day, 24-hour"
                onFocus={() => focus.onFocus()}
                onBlur={() => focus.onBlur()}
              />
            )}
          </FocusRing>
        </View>
      ) : null}

      <Text style={ui.body}>
        {hasTime && parsed
          ? describeCron(withTimeOfDay(cron, timeText) ?? cron, timeZoneLabel(tz))
          : (describeCron(cron, timeZoneLabel(tz)) ?? cron)}
      </Text>
      <Text style={ui.small}>
        {!enabled
          ? "Paused while this schedule is off."
          : upcoming.length > 0
            ? `Next: ${upcoming.map((d) => formatInZone(d, tz)).join(" · ")}`
            : "No upcoming runs."}
      </Text>
      {schedule ? (
        <Text style={ui.small}>
          Last run: {schedule.last_fired_at ? formatInZone(new Date(schedule.last_fired_at), tz) : "never"}
        </Text>
      ) : null}

      <ErrorLine message={error} />
      {note ? <Text style={ui.small}>{note}</Text> : null}

      <View style={ui.row}>
        <CardButton label="Save" busy={busy === "save"} disabled={busy !== null} onPress={() => void save()} />
        <CardButton
          label={busy === "run" ? "Starting" : "Run now"}
          variant="secondary"
          busy={busy === "run"}
          disabled={busy !== null}
          onPress={() => void runNow()}
        />
        {schedule ? (
          <CardButton
            label="Delete"
            variant="plain"
            busy={busy === "delete"}
            disabled={busy !== null}
            onPress={confirmDelete}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  flush: { marginTop: 0 },
  chip: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipPressed: { backgroundColor: colors.soft },
  clock: { fontSize: 13 },
  line: { flexShrink: 1, fontSize: font.size.md, fontFamily: font.family.semi, color: colors.ink },
  change: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.blue },
  panel: {
    gap: space.md,
    padding: space.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
  },
  warning: { gap: 2, padding: space.md, borderRadius: radius.md, backgroundColor: colors.approvalBg },
  warningTitle: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.amber },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  label: { fontSize: 14, fontFamily: font.family.medium, color: colors.ink },
  timeRing: {
    width: 84,
  },
  time: {
    height: 40,
    paddingHorizontal: 10,
    textAlign: "center",
    fontSize: 15,
    fontFamily: font.family.medium,
    color: colors.ink,
  },
});

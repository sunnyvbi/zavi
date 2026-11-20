import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { BackHeader, PrimaryButton, SecondaryButton, settingsStyles } from "../../components/settings/SettingsUI";
import { BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { Field, Notice, Section, StatusPill, makeStyles as makeAbStyles, useToneColor } from "../../components/agentBuilder/AgentBuilderUI";
import { ErrorLine, errorText } from "../../components/reply/ui";
import { TextLink } from "../../components/growth/StoryKit";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import {
  agentBuilderKeys,
  deleteNote,
  previewSchedule,
  setAgentStatus,
  startTestRun,
  updateAgent,
  useAgentList,
  useAgentNotes,
  useAgentRuns,
  useRun,
  useRunReceipts,
  type AgentList,
} from "../../features/agentBuilder/api";
import {
  CUSTOM_AGENT_HONEST_LINE,
  PAUSED_AFTER_FAILS,
  TEST_RUN_CONFIRM,
  findBuilderAgent,
  nextRun,
  pastWhen,
  pausedLine,
  plainRunText,
  receiptLine,
  runStatus,
  savedWhen,
  sendsResultsLine,
  whenItRuns,
  type BuilderAgent,
  type BuilderNote,
  type BuilderRun,
} from "../../features/agentBuilder/logic";
import { track } from "../../lib/analytics";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useAgentList();
  const agent = q.data ? findBuilderAgent(q.data.agents, id ?? null) : null;
  return (
    <Screen>
      <BackHeader title={agent?.name ?? "Agent"} />
      {q.isLoading ? (
        <View style={settingsStyles.content}>
          <BuildSkeleton rows={3} label="Loading agent" />
        </View>
      ) : q.isError ? (
        <View style={settingsStyles.content}>
          <BuildErrorState text="Couldn't load your agents." onRetry={() => void q.refetch()} />
        </View>
      ) : agent ? (
        <AgentDetail key={agent.id} agent={agent} />
      ) : (
        <View style={settingsStyles.content}>
          <NotFound />
        </View>
      )}
    </Screen>
  );
}

function NotFound() {
  const ab = useStyles(makeAbStyles);
  return <Text style={ab.small}>This agent was not found. It may have been archived.</Text>;
}

type Preview =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; cron: string; tz: string; label: string; next: string[] }
  | { phase: "bad"; message: string }
  | { phase: "error" };

function useSchedulePreview(text: string): Preview {
  const [preview, setPreview] = useState<Preview>({ phase: "idle" });
  const seqRef = useRef(0);
  useEffect(() => {
    const typed = text.trim();
    const seq = ++seqRef.current;
    if (!typed) {
      setPreview({ phase: "idle" });
      return;
    }
    setPreview({ phase: "loading" });
    const timer = setTimeout(async () => {
      try {
        const body = await previewSchedule(typed);
        if (seq !== seqRef.current) return;
        setPreview(body.ok ? { phase: "ok", ...body } : { phase: "bad", message: body.message });
      } catch {
        if (seq === seqRef.current) setPreview({ phase: "error" });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  return preview;
}

function fireTime(iso: string, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
  }
}

function AgentDetail({ agent }: { agent: BuilderAgent }) {
  const styles = useStyles(makeStyles);
  const ab = useStyles(makeAbStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  const runs = useAgentRuns(agent.id);
  const notes = useAgentNotes(agent.id);

  const paused = agent.status === "paused";
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [scheduleText, setScheduleText] = useState("");
  const schedule = useSchedulePreview(editing ? scheduleText : "");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmTest, setConfirmTest] = useState(false);
  const [starting, setStarting] = useState(false);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const testStartRef = useRef(false);
  const test = useRun(testRunId);
  const testDone = !!test.data?.done;
  const testing = starting || (!!testRunId && !testDone);
  const [actingRuns, setActingRuns] = useState<ReadonlySet<string>>(() => new Set());

  const scheduleTriggers = agent.triggers.filter((t) => t.kind === "schedule");

  const { refetch: refetchRuns } = runs;
  const { refetch: refetchNotes } = notes;
  useEffect(() => {
    if (testDone) {
      void refetchRuns();
      void refetchNotes();
    }
  }, [testDone, refetchRuns, refetchNotes]);

  const patchAgent = (next: BuilderAgent) =>
    queryClient.setQueryData<AgentList>(agentBuilderKeys.list(tenant), (old) =>
      old ? { ...old, agents: old.agents.map((x) => (x.id === next.id ? { ...x, ...next } : x)) } : old,
    );

  const onReceipts = useCallback((runId: string, count: number) => {
    setActingRuns((prev) => {
      if ((count > 0) === prev.has(runId)) return prev;
      const next = new Set(prev);
      if (count > 0) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }, []);

  const runTest = async () => {
    if (testStartRef.current) return;
    testStartRef.current = true;
    setConfirmTest(false);
    setStarting(true);
    setError(null);
    try {
      setTestRunId(await startTestRun(agent.id));
      track("agent_test_run", { source: "agent_page" });
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      testStartRef.current = false;
      setStarting(false);
    }
  };

  const togglePause = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await setAgentStatus(agent.id, paused ? "active" : "paused");
      patchAgent(next);
      track(paused ? "agent_resumed" : "agent_paused");
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      await setAgentStatus(agent.id, "archived");
      track("agent_archived");
      setConfirmArchive(false);
      void queryClient.invalidateQueries({ queryKey: agentBuilderKeys.archived(tenant) });
      router.dismissTo({ pathname: "/agents", params: { archived: agent.name } });
    } catch (e) {
      setConfirmArchive(false);
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const typedSchedule = scheduleText.trim();
  const instructionsChanged = !!instructions.trim() && instructions !== agent.instructions;
  const scheduleReady = schedule.phase === "ok";
  const canSave =
    !saving &&
    !!instructions.trim() &&
    (!typedSchedule || scheduleReady) &&
    (instructionsChanged || (!!typedSchedule && scheduleReady));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await updateAgent(agent.id, {
        ...(instructions !== agent.instructions ? { instructions } : {}),
        ...(typedSchedule && schedule.phase === "ok" ? { schedule_cron: schedule.cron } : {}),
      });
      patchAgent(next);
      setScheduleText("");
      setEditing(false);
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const toggleEdit = () => {
    if (editing) {
      setInstructions(agent.instructions);
      setScheduleText("");
    }
    setEditing((v) => !v);
  };

  const removeNote = async (noteId: string) => {
    setError(null);
    try {
      await deleteNote(agent.id, noteId);
      queryClient.setQueryData<BuilderNote[]>(agentBuilderKeys.notes(tenant, agent.id), (old) =>
        old ? old.filter((n) => n.id !== noteId) : old,
      );
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    }
  };

  const openResults = (runId: string) =>
    router.push({ pathname: "/agents/results", params: { id: agent.id, run: runId } });
  const openChat = () => router.push({ pathname: "/chat", params: { slug: agent.slug, back: "1" } });
  const pausedText = paused ? pausedLine(agent) : null;

  return (
    <KeyboardAvoider style={styles.flex}>
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          <StatusPill paused={paused} />
          {agent.role ? <Text style={ab.small}>{agent.role}</Text> : null}
          {pausedText ? <Text style={ab.body}>{pausedText}</Text> : null}
        </View>

        <View style={styles.actions}>
          <PrimaryButton
            label={starting ? "Starting…" : testing ? "Testing…" : "Test run"}
            onPress={() => setConfirmTest(true)}
            disabled={testing || paused}
            style={styles.action}
          />
          <SecondaryButton label={editing ? "Done editing" : "Edit"} onPress={toggleEdit} style={styles.action} />
        </View>
        <View style={styles.actions}>
          <SecondaryButton
            label={paused ? "Resume" : "Pause"}
            onPress={() => void togglePause()}
            disabled={busy}
            style={styles.action}
          />
          <SecondaryButton
            label="Archive"
            danger
            onPress={() => setConfirmArchive(true)}
            disabled={busy}
            style={styles.action}
          />
        </View>

        <Notice>{CUSTOM_AGENT_HONEST_LINE}</Notice>
        <ErrorLine message={error} />
        {paused && agent.paused_reason === PAUSED_AFTER_FAILS ? (
          <Notice>Resume starts the count again. If the next 3 runs do not finish, it pauses again and sends one notice.</Notice>
        ) : null}

        <Section title="Setup">
          <Field label="Instructions">
            {editing ? (
              <ZaviTextField
                value={instructions}
                onChangeText={setInstructions}
                maxLength={20000}
                minLines={4}
                maxLines={10}
                accessibilityLabel="Instructions"
              />
            ) : (
              <Text style={ab.body}>{agent.instructions}</Text>
            )}
          </Field>
          <Field label="When it runs">
            {editing && scheduleTriggers.length > 0 ? (
              <View style={styles.scheduleBox}>
                <Text style={ab.small}>{`Now: ${whenItRuns(scheduleTriggers)}`}</Text>
                <ZaviTextField
                  value={scheduleText}
                  onChangeText={setScheduleText}
                  maxLength={200}
                  placeholder="weekdays at 10am"
                  accessibilityLabel="When it runs"
                />
                <View accessibilityLiveRegion="polite">
                  {schedule.phase === "loading" ? <Text style={ab.small}>Reading…</Text> : null}
                  {schedule.phase === "bad" ? <Text style={ab.body}>{schedule.message}</Text> : null}
                  {schedule.phase === "error" ? <Text style={ab.body}>Couldn’t read that. Try again.</Text> : null}
                  {schedule.phase === "ok" ? (
                    <>
                      <Text style={[ab.body, styles.semi]}>{schedule.label}</Text>
                      {schedule.next.length > 0 ? (
                        <Text style={ab.small}>{`Next: ${schedule.next.map((iso) => fireTime(iso, schedule.tz)).join(" · ")}`}</Text>
                      ) : null}
                    </>
                  ) : null}
                </View>
              </View>
            ) : (
              <Text style={ab.body}>{whenItRuns(agent.triggers)}</Text>
            )}
          </Field>
          <Field label="Sends results to">{sendsResultsLine(agent.deliver)}</Field>
          <Field label="Next run">{nextRun(agent)}</Field>
          {editing ? <PrimaryButton label="Save" onPress={() => void save()} disabled={!canSave} busy={saving} style={styles.flat} /> : null}
        </Section>

        <Section title="Run history" aside={actingRuns.size > 0 ? "Acts on its own. Every action is listed here." : undefined}>
          {testRunId || starting ? (
            <View style={styles.resultBox}>
              {test.data?.done ? (
                <>
                  <Text style={ab.small}>This was a real run. The result is shown here only.</Text>
                  <Text style={ab.body} selectable>
                    {test.data.output ? plainRunText(test.data.output) : "The run finished without any output."}
                  </Text>
                </>
              ) : (
                <Text style={ab.small} accessibilityLiveRegion="polite">
                  {starting ? "Starting…" : "Testing…"}
                </Text>
              )}
            </View>
          ) : null}
          {runs.isLoading ? (
            <BuildSkeleton rows={2} label="Loading runs" />
          ) : runs.isError ? (
            <BuildErrorState text="Couldn't load the runs." onRetry={() => void runs.refetch()} />
          ) : (runs.data ?? []).length === 0 ? (
            <View style={styles.emptyRow}>
              <Text style={ab.small}>Not run yet. Runs show here with their result.</Text>
              {!paused ? <SecondaryButton label="+ Test run" onPress={() => setConfirmTest(true)} style={styles.flat} /> : null}
            </View>
          ) : (
            (runs.data ?? []).map((r) => (
              <RunRow key={r.id} agentId={agent.id} run={r} onReceipts={onReceipts} onOpenResults={openResults} />
            ))
          )}
        </Section>

        <Section title="Saved to the brain" aside="Findings this agent saved. Each run starts from its last result.">
          {notes.isLoading ? (
            <BuildSkeleton rows={1} label="Loading notes" />
          ) : notes.isError ? (
            <BuildErrorState text="Couldn't load the notes." onRetry={() => void notes.refetch()} />
          ) : (notes.data ?? []).length === 0 ? (
            <Text style={[ab.small, styles.dashed]}>No notes saved yet</Text>
          ) : (
            (notes.data ?? []).map((n) => (
              <View key={n.id} style={styles.note}>
                <Text style={ab.body}>{n.text}</Text>
                <View style={styles.noteFoot}>
                  <Text style={ab.small}>{`Saved ${savedWhen(n.created_at)}`}</Text>
                  <Pressable
                    onPress={() => void removeNote(n.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Delete note"
                  >
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </Section>

        <Section title="Chat with this agent" aside={`Ask it anything in its own thread, or type @${agent.name} in any chat, Slack or WhatsApp.`}>
          <SecondaryButton label={`Chat with ${agent.name}`} onPress={openChat} style={styles.flat} />
        </Section>
      </ScrollView>

      <ConfirmDialog
        visible={confirmTest}
        icon="alertCircle"
        title="Run a test?"
        message={TEST_RUN_CONFIRM}
        cancelLabel="Cancel"
        confirmLabel="Run test"
        onCancel={() => setConfirmTest(false)}
        onConfirm={() => void runTest()}
      />
      <ConfirmDialog
        visible={confirmArchive}
        icon="trash"
        title={`Archive "${agent.name}"?`}
        message="It stops running. Its run history and receipts are kept, and you can unarchive it."
        cancelLabel="Cancel"
        confirmLabel="Archive agent"
        destructive
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => void archive()}
      />
    </KeyboardAvoider>
  );
}

function RunRow({
  agentId,
  run,
  onReceipts,
  onOpenResults,
}: {
  agentId: string;
  run: BuilderRun;
  onReceipts: (runId: string, count: number) => void;
  onOpenResults: (runId: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const ab = useStyles(makeAbStyles);
  const tone = useToneColor();
  const rs = runStatus(run);
  const receipts = useRunReceipts(agentId, run.id);
  const [open, setOpen] = useState(false);
  const result = useRun(open ? run.id : null);

  const count = receipts.data?.length ?? 0;
  useEffect(() => {
    if (receipts.data) onReceipts(run.id, count);
  }, [receipts.data, count, run.id, onReceipts]);

  return (
    <View style={styles.run}>
      <Text style={ab.small}>{pastWhen(run.finished_at ?? run.enqueued_at)}</Text>
      <View style={styles.runHead}>
        <Text style={[styles.semi, { color: tone(rs.tone) }]}>{rs.label}</Text>
        {run.test ? <Text style={styles.chip}>Test run</Text> : null}
      </View>
      {run.failure ? <Text style={ab.small}>{run.failure}</Text> : null}
      {run.summary ? <Text style={ab.body}>{run.summary}</Text> : null}
      {}
      {receipts.isError ? (
        <Text style={ab.small}>Couldn’t load this run’s actions.</Text>
      ) : count > 0 ? (
        <View style={styles.receipts}>
          {receipts.data?.map((x) => (
            <View key={x.id} style={styles.receipt}>
              <View style={styles.receiptDot} />
              <Text style={[ab.body, styles.flex]}>{receiptLine(x)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.runLinks}>
        <TextLink label={open ? "Hide result" : "Open result"} expanded={open} onPress={() => setOpen((v) => !v)} />
        <TextLink label="Open results page" onPress={() => onOpenResults(run.id)} />
      </View>
      {open ? (
        <View style={styles.resultBox}>
          {result.isLoading ? (
            <Text style={ab.small}>Loading…</Text>
          ) : result.isError ? (
            <Text style={ab.small}>Couldn’t load the result.</Text>
          ) : result.data?.output ? (
            <Text style={ab.body} selectable>
              {plainRunText(result.data.output)}
            </Text>
          ) : (
            <Text style={ab.small}>{result.data?.done === false ? "Still running." : "The run finished without any output."}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    head: { gap: space.xs, marginBottom: space.xs },
    actions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
    action: { flex: 1, marginTop: 0 },
    flat: { marginTop: 0 },
    semi: { fontSize: font.size.base, fontFamily: font.family.semi },
    scheduleBox: { gap: space.xs },
    resultBox: {
      gap: space.xs,
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.md,
      backgroundColor: colors.soft,
    },
    emptyRow: { gap: space.sm },
    run: { gap: 3, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    runHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    chip: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 6,
      overflow: "hidden",
      backgroundColor: colors.soft,
      fontSize: font.size.sm,
      fontFamily: font.family.medium,
      color: colors.muted,
    },
    receipts: { gap: space.xs, marginTop: space.xs },
    receipt: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.sm,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
    },
    receiptDot: { width: 6, height: 6, borderRadius: 3, marginTop: 8, backgroundColor: colors.ink },
    runLinks: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: space.lg, marginTop: space.sm },
    dashed: {
      padding: space.md,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
      borderRadius: radius.md,
    },
    note: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    noteFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    deleteText: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.red },
  });

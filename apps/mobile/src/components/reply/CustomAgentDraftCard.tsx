import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useOpenBillingScreen } from "../../features/agents/billingLink";
import { useCanManage } from "../../features/settings/api";
import {
  createAgent,
  fetchAgentForRun,
  setAgentStatus,
  startTestRun,
  updateAgent,
  useRun,
} from "../../features/agentBuilder/api";
import { track } from "../../lib/analytics";
import {
  CUSTOM_AGENT_HONEST_LINE,
  TEST_RUN_CONFIRM,
  deliverLabel,
  draftFromServerAgent,
  plainRunText,
  runStatus,
  triggerLabel,
  type CustomAgentCardData,
  type CustomAgentDraft,
} from "../../features/agentBuilder/logic";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { ZaviTextField } from "../ZaviTextField";
import { Card, CardButton, ErrorLine, errorText, makeUi } from "./ui";

type Saved = { id: string; status: string };
const FALLBACK = "Something went wrong. Try again.";

export function CustomAgentDraftCard({ card, originRunId }: { card: CustomAgentCardData; originRunId: string | null }) {
  const ui = useStyles(makeUi);
  const canManage = useCanManage();
  const openBilling = useOpenBillingScreen();
  if (card.kind === "refusal") {
    return (
      <Card>
        <Text style={ui.body} accessibilityRole="alert">
          {card.refusal.message}
        </Text>
        {card.refusal.code !== "plan_upgrade_required" ? null : canManage && openBilling ? (
          <View style={ui.row}>
            <CardButton label="Upgrade plan" onPress={openBilling} />
          </View>
        ) : (
          <Text style={ui.small}>Ask your workspace owner to upgrade.</Text>
        )}
      </Card>
    );
  }
  return <DraftCard initial={card.draft} originRunId={originRunId} />;
}

function DraftCard({ initial, originRunId }: { initial: CustomAgentDraft; originRunId: string | null }) {
  const ui = useStyles(makeUi);
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [triggers, setTriggers] = useState(initial.triggers);
  const [deliver, setDeliver] = useState(initial.deliver);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "create" | "test">(null);
  const [error, setError] = useState<string | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [confirmingTest, setConfirmingTest] = useState(false);
  const testStartRef = useRef(false);
  const test = useRun(testRunId);

  const [checked, setChecked] = useState(!originRunId);
  useEffect(() => {
    if (!originRunId) return;
    let stopped = false;
    fetchAgentForRun(originRunId)
      .then((hit) => {
        if (!hit || stopped) return;
        setSaved({ id: hit.id, status: hit.status });
        const restored = draftFromServerAgent(hit, initial);
        setName(restored.name);
        setRole(restored.role);
        setInstructions(restored.instructions);
        setTriggers(restored.triggers);
        setDeliver(restored.deliver);
      })
      .catch(() => {})
      .finally(() => {
        if (!stopped) setChecked(true);
      });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originRunId]);

  const created = saved?.status === "active" || saved?.status === "paused";
  const archived = saved?.status === "archived";
  const testing = !!testRunId && !test.data?.done;
  const filled = !!name.trim() && !!instructions.trim();

  const ensureSaved = async (status: "draft" | "active"): Promise<Saved> => {
    if (!saved) {
      const agent = await createAgent({
        name,
        role,
        instructions,
        tools: initial.tools,
        triggers,
        deliver,
        status,
        ...(originRunId ? { origin_run_id: originRunId } : {}),
      });
      setSaved(agent);
      setDirty(false);
      return agent;
    }
    if (dirty) {
      await updateAgent(saved.id, { name, role, instructions });
      setDirty(false);
    }
    return saved;
  };

  const onCreate = async () => {
    setBusy("create");
    setError(null);
    try {
      const agent = await ensureSaved("active");
      if (agent.status !== "active") {
        await setAgentStatus(agent.id, "active");
        setSaved({ id: agent.id, status: "active" });
      }
      void queryClient.invalidateQueries({ queryKey: ["custom-agents"] });
      setEditing(false);
      track("agent_created");
    } catch (e) {
      setError(errorText(e, FALLBACK));
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    if (testStartRef.current) return;
    testStartRef.current = true;
    setConfirmingTest(false);
    setBusy("test");
    setError(null);
    try {
      const agent = await ensureSaved("draft");
      setTestRunId(await startTestRun(agent.id));
      track("agent_test_run", { source: "draft_card" });
    } catch (e) {
      setError(errorText(e, FALLBACK));
    } finally {
      testStartRef.current = false;
      setBusy(null);
    }
  };

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setDirty(true);
  };

  const testLabel = test.data?.status ?? (testRunId ? "queued" : null);

  return (
    <Card>
      <Text style={styles.eyebrow}>{archived ? "AGENT ARCHIVED" : created ? "AGENT CREATED" : "NEW AGENT"}</Text>
      {editing ? (
        <View style={styles.fields}>
          <ZaviTextField title="Name" value={name} maxLength={60} maxLines={1} onChangeText={edit(setName)} />
          <ZaviTextField title="Role" value={role} maxLength={500} onChangeText={edit(setRole)} />
          <ZaviTextField
            title="Instructions"
            value={instructions}
            maxLength={20000}
            minLines={4}
            maxLines={10}
            onChangeText={edit(setInstructions)}
          />
        </View>
      ) : (
        <View style={styles.fields}>
          <Text style={ui.title}>{name}</Text>
          {role ? <Text style={ui.muted}>{role}</Text> : null}
          <Text style={ui.body} numberOfLines={4}>
            {instructions}
          </Text>
        </View>
      )}

      <View style={styles.fields}>
        <Text style={ui.muted}>
          <Text style={styles.label}>When it runs: </Text>
          {triggers.length > 0 ? triggers.map(triggerLabel).join("; ") : "Only when you run it"}
        </Text>
        <Text style={ui.muted}>
          <Text style={styles.label}>Sends results to: </Text>
          {deliverLabel(deliver)}
        </Text>
      </View>

      <ErrorLine message={error} />

      {archived ? (
        <Text style={ui.muted}>This agent was archived.</Text>
      ) : (
        <>
          <Text style={styles.notice}>{CUSTOM_AGENT_HONEST_LINE}</Text>
          {confirmingTest ? (
            <View style={styles.fields}>
              <Text style={[ui.body, styles.label]}>{TEST_RUN_CONFIRM}</Text>
              <View style={ui.row}>
                <CardButton label="Run test" onPress={() => void onTest()} disabled={busy !== null} />
                <CardButton label="Cancel" variant="secondary" onPress={() => setConfirmingTest(false)} />
              </View>
            </View>
          ) : (
            <View style={ui.row}>
              {!created ? (
                <CardButton
                  label={busy === "create" ? "Creating…" : "Create"}
                  onPress={() => void onCreate()}
                  disabled={!checked || busy !== null || !filled}
                  busy={busy === "create"}
                />
              ) : null}
              <CardButton
                label={busy === "test" ? "Starting…" : testing ? "Testing…" : "Test run"}
                variant="secondary"
                onPress={() => setConfirmingTest(true)}
                disabled={!checked || busy !== null || testing || !filled}
              />
              {!created ? (
                <CardButton
                  label={editing ? "Done editing" : "Edit"}
                  variant="plain"
                  onPress={() => setEditing((v) => !v)}
                  disabled={!checked || busy !== null}
                />
              ) : null}
            </View>
          )}
        </>
      )}

      {created && saved ? (
        <View style={ui.row}>
          <Text style={[ui.muted, styles.flex]}>{saved.status === "paused" ? "It’s paused." : "It’s active."}</Text>
          <CardButton
            label="Open in Agent Builder"
            variant="plain"
            onPress={() => router.push({ pathname: "/agents/[id]", params: { id: saved.id } })}
          />
        </View>
      ) : null}

      {testRunId ? (
        <View style={styles.result}>
          <Text style={styles.eyebrow}>
            {`TEST RUN${testLabel ? ` · ${runStatus({ status: testLabel, test: true }).label.toUpperCase()}` : ""}`}
          </Text>
          <Text style={ui.small}>
            {test.data?.done ? "This was a real run. The result is shown here only." : "Testing… the result will show here."}
          </Text>
          {test.data?.done ? (
            <Text style={ui.body} selectable>
              {test.data.output ? plainRunText(test.data.output) : "The run finished without any output."}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    eyebrow: { fontSize: font.size.xs, letterSpacing: 0.6, fontFamily: font.family.medium, color: colors.muted },
    fields: { gap: space.xs },
    label: { fontFamily: font.family.medium, color: colors.ink },
    notice: {
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
      fontSize: font.size.md,
      lineHeight: 19,
      fontFamily: font.family.regular,
      color: colors.ink,
    },
    result: {
      gap: space.xs,
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.md,
      backgroundColor: colors.soft,
    },
  });

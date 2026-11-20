import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen } from "../../components/Screen";
import { Markdown } from "../../components/Markdown";
import { BackHeader, PrimaryButton, settingsStyles } from "../../components/settings/SettingsUI";
import { BuildErrorState, BuildSkeleton } from "../../components/build/BuildStates";
import { Field, Section, makeStyles as makeAbStyles, useToneColor } from "../../components/agentBuilder/AgentBuilderUI";
import { useAgentList, useAgentRuns, useRun } from "../../features/agentBuilder/api";
import {
  findBuilderAgent,
  nextRun,
  pastWhen,
  runResultMarkdown,
  runStatus,
  sendsResultsLine,
  whenItRuns,
  type BuilderAgent,
} from "../../features/agentBuilder/logic";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export default function AgentResultsScreen() {
  const { id, run } = useLocalSearchParams<{ id: string; run: string }>();
  const q = useAgentList();
  const agent = q.data ? findBuilderAgent(q.data.agents, id ?? null) : null;
  const ab = useStyles(makeAbStyles);
  return (
    <Screen>
      <BackHeader title="Results" />
      {q.isLoading ? (
        <View style={settingsStyles.content}>
          <BuildSkeleton rows={3} label="Loading results" />
        </View>
      ) : q.isError ? (
        <View style={settingsStyles.content}>
          <BuildErrorState text="Couldn't load your agents." onRetry={() => void q.refetch()} />
        </View>
      ) : agent && run ? (
        <Results agent={agent} runId={run} />
      ) : (
        <View style={settingsStyles.content}>
          <Text style={ab.small}>This agent was not found. It may have been archived.</Text>
        </View>
      )}
    </Screen>
  );
}

function Results({ agent, runId }: { agent: BuilderAgent; runId: string }) {
  const styles = useStyles(makeStyles);
  const ab = useStyles(makeAbStyles);
  const tone = useToneColor();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runs = useAgentRuns(agent.id);
  const detail = useRun(runId);

  const listed = runs.data?.find((r) => r.id === runId) ?? null;
  const run = detail.data && detail.data.agentSlug === agent.slug ? detail.data : null;
  const rs = run
    ? runStatus({ status: run.status, test: listed?.test ?? false })
    : listed && detail.isLoading
      ? runStatus(listed)
      : null;
  const markdown = run && run.done ? runResultMarkdown(run.output) : "";

  const pick = (next: string) => router.setParams({ run: next });
  const openChat = () => router.push({ pathname: "/chat", params: { slug: agent.slug, back: "1" } });

  return (
    <ScrollView contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}>
      <Text style={styles.title}>{agent.name}</Text>
      {rs ? (
        <View style={styles.statusLine}>
          <Text style={[styles.semi, { color: tone(rs.tone) }]}>{rs.label}</Text>
          {listed?.test ? <Text style={styles.chip}>Test run</Text> : null}
          {listed ? <Text style={ab.small}>{pastWhen(listed.finished_at ?? listed.enqueued_at)}</Text> : null}
        </View>
      ) : null}
      <PrimaryButton label="Chat with this agent" onPress={openChat} style={styles.chat} />

      {}
      <Text style={styles.label}>Runs</Text>
      {runs.isLoading ? (
        <BuildSkeleton rows={1} label="Loading runs" />
      ) : runs.isError ? (
        <BuildErrorState text="Couldn't load the runs." onRetry={() => void runs.refetch()} />
      ) : (runs.data ?? []).length === 0 ? (
        <Text style={ab.small}>No runs yet</Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.runsScroll}
          contentContainerStyle={styles.runsRow}
        >
          {(runs.data ?? []).map((r) => {
            const on = r.id === runId;
            const s = runStatus(r);
            return (
              <Pressable
                key={r.id}
                onPress={() => pick(r.id)}
                style={[styles.runChip, on && styles.runChipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${pastWhen(r.finished_at ?? r.enqueued_at)}, ${s.label}${r.test ? ", test run" : ""}`}
              >
                <Text style={styles.runChipDate}>{pastWhen(r.finished_at ?? r.enqueued_at)}</Text>
                <Text style={[styles.runChipStatus, { color: tone(s.tone) }]}>{`${s.label}${r.test ? " · Test" : ""}`}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <Section title="Result">
        {detail.isLoading ? (
          <Text style={ab.small}>Loading…</Text>
        ) : detail.isError ? (
          <Text style={ab.small}>Couldn’t load this result.</Text>
        ) : !run ? (
          <Text style={[ab.small, styles.dashed]}>{`Couldn’t find this run for ${agent.name}. Pick another run above.`}</Text>
        ) : !run.done ? (
          <Text style={[ab.small, styles.dashed]} accessibilityLiveRegion="polite">
            Still running. The result shows here when it finishes.
          </Text>
        ) : rs?.tone === "failed" ? (
          <Text style={[ab.small, styles.dashed]}>
            {listed?.failure ?? "This run stopped before it finished, so there is no result."}
          </Text>
        ) : markdown ? (
          <Markdown body={markdown} tableBleed={space.lg} />
        ) : (
          <Text style={[ab.small, styles.dashed]}>The run finished without any output.</Text>
        )}
      </Section>

      <Section title="Schedule">
        <Field label="When it runs">{whenItRuns(agent.triggers)}</Field>
        <Field label="Next run">{nextRun(agent)}</Field>
        <Field label="Sends results to">{sendsResultsLine(agent.deliver)}</Field>
      </Section>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chat: { marginTop: space.md },
    title: { fontSize: font.size.title, fontFamily: font.family.bold, color: colors.ink },
    statusLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.xs },
    semi: { fontSize: font.size.base, fontFamily: font.family.semi, color: colors.ink },
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
    dashed: {
      padding: space.md,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
      borderRadius: radius.md,
    },
    label: { marginTop: space.lg, fontSize: font.size.md, fontFamily: font.family.semi, color: colors.muted },
    runsScroll: { marginTop: space.sm, marginHorizontal: -space.lg },
    runsRow: { gap: space.sm, paddingHorizontal: space.lg },
    runChip: {
      gap: 2,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.sm,
      backgroundColor: colors.panel,
    },
    runChipOn: { borderColor: colors.ink, backgroundColor: colors.soft },
    runChipDate: { fontSize: font.size.md, fontFamily: font.family.semi, color: colors.ink },
    runChipStatus: { fontSize: font.size.sm, fontFamily: font.family.medium },
  });

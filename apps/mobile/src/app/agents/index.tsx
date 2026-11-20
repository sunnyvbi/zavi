import { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Screen } from "../../components/Screen";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";
import { ZaviTextField } from "../../components/ZaviTextField";
import {
  BackHeader,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import {
  BuildErrorState,
  BuildSkeleton,
} from "../../components/build/BuildStates";
import {
  Field,
  StatusPill,
  makeStyles as makeAbStyles,
  useToneColor,
} from "../../components/agentBuilder/AgentBuilderUI";
import { CardButton, ErrorLine, errorText } from "../../components/reply/ui";
import { Icon } from "../../components/Icon";
import { useOpenBillingScreen } from "../../features/agents/billingLink";
import { useCanManage } from "../../features/settings/api";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import {
  agentBuilderKeys,
  setAgentStatus,
  unarchiveAgent,
  useAgentList,
  useArchivedAgents,
  type AgentList,
} from "../../features/agentBuilder/api";
import {
  nextRun,
  pastWhen,
  pausedLine,
  runStatus,
  sendsResultsTo,
  whenItRuns,
  type BuilderAgent,
} from "../../features/agentBuilder/logic";
import { track } from "../../lib/analytics";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function AgentBuilder() {
  const styles = useStyles(makeStyles);
  const ab = useStyles(makeAbStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const tenant = useActiveTenant();
  const canManage = useCanManage();
  const openBilling = useOpenBillingScreen();
  const { archived: archivedName } = useLocalSearchParams<{
    archived?: string;
  }>();
  const q = useAgentList();
  const [showArchived, setShowArchived] = useState(false);
  const archivedQ = useArchivedAgents();
  const [ask, setAsk] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  const refusal = q.data?.refusal ?? null;
  const agents = q.data?.agents ?? [];
  const { refetch } = q;
  const { refetch: refetchArchived } = archivedQ;
  useFocusEffect(
    useCallback(() => {
      void refetch();
      void refetchArchived();
    }, [refetch, refetchArchived]),
  );

  const onPull = async () => {
    setPulling(true);
    await Promise.all([refetch(), refetchArchived()]).catch(() => {});
    setPulling(false);
  };

  const draft = () => {
    const text = ask.trim();
    if (!text || refusal) return;
    setAsk("");
    router.push({
      pathname: "/chat",
      params: { slug: "operator", prefill: text, send: "1", back: "1" },
    });
  };

  const toggle = async (a: BuilderAgent) => {
    setBusyId(a.id);
    setError(null);
    try {
      const next = await setAgentStatus(
        a.id,
        a.status === "paused" ? "active" : "paused",
      );
      track(a.status === "paused" ? "agent_resumed" : "agent_paused");
      queryClient.setQueryData<AgentList>(
        agentBuilderKeys.list(tenant),
        (old) =>
          old
            ? {
                ...old,
                agents: old.agents.map((x) =>
                  x.id === next.id ? { ...x, ...next } : x,
                ),
              }
            : old,
      );
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusyId(null);
    }
  };

  const unarchive = async (a: BuilderAgent) => {
    setBusyId(a.id);
    setError(null);
    try {
      await unarchiveAgent(a.id);
      router.setParams({ archived: undefined });
      void archivedQ.refetch();
      void refetch();
    } catch (e) {
      setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <BackHeader title="Agent Builder" />
      <KeyboardAvoider style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            settingsStyles.content,
            { paddingBottom: insets.bottom + 20 },
          ]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              onRefresh={() => void onPull()}
              tintColor={colors.muted}
              colors={[colors.ink]}
              progressBackgroundColor={colors.surfaceRaised}
            />
          }
        >
          <Text style={ab.small}>
            Agents you built. Each one runs on its own and reports back.
          </Text>

          {archivedName ? (
            <View style={ab.section} accessibilityLiveRegion="polite">
              <Text style={ab.sectionTitle}>Agent archived</Text>
              <Text style={ab.small}>
                {`"${archivedName}" stopped and moved to Archived. Its run history and receipts are kept.`}
              </Text>
            </View>
          ) : null}

          <View style={ab.section}>
            <Text style={ab.sectionTitle}>What should your agent do?</Text>
            <ZaviTextField
              value={ask}
              onChangeText={setAsk}
              placeholder="Every weekday at 9am, send me a standup of what you did"
              minLines={2}
              editable={!refusal}
              accessibilityLabel="What should your agent do?"
            />
            {refusal ? (
              <Text style={ab.body}>
                {refusal.message}
                {canManage ? "" : " Ask your workspace owner to upgrade."}
              </Text>
            ) : (
              <Text style={ab.small}>
                Zavi drafts the agent in chat. You check it, then create it.
              </Text>
            )}
            {refusal && canManage && openBilling ? (
              <PrimaryButton
                label="Upgrade plan"
                onPress={openBilling}
                style={styles.flat}
              />
            ) : (
              <PrimaryButton
                label="Draft agent"
                onPress={draft}
                disabled={!!refusal || !ask.trim()}
                style={styles.flat}
              />
            )}
          </View>

          <SectionLabel>
            {q.data ? `Your agents · ${agents.length}` : "Your agents"}
          </SectionLabel>
          <ErrorLine message={error} />
          {q.isLoading ? (
            <BuildSkeleton rows={2} label="Loading agents" />
          ) : q.isError ? (
            <BuildErrorState
              text="Couldn't load your agents."
              onRetry={() => void refetch()}
            />
          ) : agents.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyTitle}>No agents yet</Text>
              <Text style={ab.small}>
                Describe one above and Zavi drafts it in chat.
              </Text>
            </View>
          ) : (
            <View style={styles.agentList}>
              {agents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  busy={busyId === a.id}
                  blockResume={!!refusal}
                  onToggle={() => void toggle(a)}
                  onOpen={() =>
                    router.push({
                      pathname: "/agents/[id]",
                      params: { id: a.id },
                    })
                  }
                />
              ))}
            </View>
          )}

          <Pressable
            style={styles.archivedToggle}
            onPress={() => setShowArchived((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showArchived }}
          >
            <Text style={styles.archivedToggleText}>
              {archivedQ.data
                ? `Archived (${archivedQ.data.length})`
                : "Archived"}
            </Text>
            <View style={showArchived ? styles.chevronOpen : undefined}>
              <Icon
                name="chevronDown"
                size={16}
                color={colors.muted}
                strokeWidth={2}
              />
            </View>
          </Pressable>
          {showArchived ? (
            archivedQ.isLoading ? (
              <BuildSkeleton rows={1} label="Loading archived agents" />
            ) : archivedQ.isError ? (
              <BuildErrorState
                text="Couldn't load archived agents."
                onRetry={() => void archivedQ.refetch()}
              />
            ) : (archivedQ.data ?? []).length === 0 ? (
              <Text style={ab.small}>No archived agents</Text>
            ) : (
              <View style={styles.archivedList}>
                {(archivedQ.data ?? []).map((a, i) => (
                  <View
                    key={a.id}
                    style={[
                      styles.archivedRow,
                      i > 0 && styles.archivedDivider,
                    ]}
                  >
                    <Text
                      style={[styles.archivedName, styles.flex]}
                      numberOfLines={2}
                    >
                      {a.name}
                    </Text>
                    <CardButton
                      label="Unarchive"
                      variant="secondary"
                      onPress={() => void unarchive(a)}
                      disabled={busyId === a.id}
                    />
                  </View>
                ))}
              </View>
            )
          ) : null}
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}

function AgentCard({
  agent,
  busy,
  blockResume,
  onToggle,
  onOpen,
}: {
  agent: BuilderAgent;
  busy: boolean;
  blockResume: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const styles = useStyles(makeStyles);
  const ab = useStyles(makeAbStyles);
  const tone = useToneColor();
  const paused = agent.status === "paused";
  const run = agent.last_run ?? null;
  const rs = run ? runStatus(run) : null;
  const pausedText = paused ? pausedLine(agent) : null;
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${agent.name}`}
      >
        <View style={styles.head}>
          <Text style={[styles.name, styles.flex]}>{agent.name}</Text>
          <StatusPill paused={paused} />
        </View>
        {agent.role ? <Text style={ab.small}>{agent.role}</Text> : null}
        {pausedText ? <Text style={ab.small}>{pausedText}</Text> : null}
        <Field label="When it runs">{whenItRuns(agent.triggers)}</Field>
        <Field label="Sends results to">{sendsResultsTo(agent.deliver)}</Field>
        <Field label="Last run">
          {run && rs ? (
            <Text style={ab.body}>
              <Text style={[styles.status, { color: tone(rs.tone) }]}>
                {rs.label}
              </Text>
              {run.test ? <Text style={ab.small}> · Test run</Text> : null}
              <Text
                style={ab.small}
              >{`  ${pastWhen(run.finished_at ?? run.enqueued_at)}`}</Text>
            </Text>
          ) : (
            <Text style={ab.small}>Not run yet</Text>
          )}
        </Field>
        <Field label="Next run">{nextRun(agent)}</Field>
      </Pressable>
      <View style={styles.actions}>
        <SecondaryButton
          label={paused ? "Resume" : "Pause"}
          onPress={onToggle}
          disabled={busy || (paused && blockResume)}
          style={styles.action}
        />
        <SecondaryButton label="Open" onPress={onOpen} style={styles.action} />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    agentList: { gap: space.md },
    card: {
      padding: space.lg,
      gap: space.xs,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.panel,
    },
    head: { flexDirection: "row", alignItems: "center", gap: space.sm },
    flex: { flex: 1 },
    name: { fontSize: 16, fontFamily: font.family.semi, color: colors.ink },
    emptyTitle: {
      fontSize: font.size.base,
      fontFamily: font.family.semi,
      color: colors.muted,
    },
    status: { fontFamily: font.family.semi },
    actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
    action: { flex: 1, marginTop: 0 },
    flat: { marginTop: 0 },
    archivedToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      marginTop: space.lg,
      marginBottom: space.sm,
      paddingVertical: space.xs,
      alignSelf: "flex-start",
    },
    chevronOpen: { transform: [{ rotate: "180deg" }] },
    archivedToggleText: {
      fontSize: font.size.base,
      fontFamily: font.family.semi,
      color: colors.muted,
    },
    archivedList: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.lg,
      backgroundColor: colors.panel,
    },
    archivedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    archivedDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    archivedName: {
      fontSize: font.size.base,
      fontFamily: font.family.medium,
      color: colors.ink,
    },
  });

import { useMemo, useState } from "react";
import { Clipboard, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { adChangeHeadline, compareActions, isOpenAction } from "@zavi/shared";
import { useRouter } from "expo-router";
import { BackIcon, Icon } from "../components/Icon";
import { ChannelLogo } from "../components/channels/ChannelGlyph";
import { ActionStepsView } from "../components/growth/ActionStepsView";
import { ActionButton, Bars, ErrorLine, TextLink } from "../components/growth/StoryKit";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useSuccessToast } from "../components/channels/ChannelToast";
import { approveAction, dismissAction, fetchChannelActionRows, fetchChannelApprovals, fetchChannels } from "../features/channels/api";
import type { ChannelDecision, ChannelsResponse } from "../features/channels/types";
import { channelName } from "../features/channels/display";
import { useDecideMove } from "../features/growth/hooks";
import { MOVE_ERROR, SHIP_RED_CONFIRM } from "../features/growth/moves";
import { growthPending, isGrowthDecision } from "../features/growth/plan";
import { EFFORT_LABEL, arrangeReview, beforeYouDoIt, firstSentence, type ReviewAction } from "../features/growth/review";
import { useActiveTenant } from "../features/workspaces/useActiveTenant";
import { track } from "../lib/analytics";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

type Outcome = "Done" | "Approved" | "Rejected" | "Not now";

export default function GrowthReviewRoute() {
  const router = useRouter();
  return <GrowthReviewScreen onBack={() => router.back()} />;
}

function GrowthReviewScreen({ onBack }: { onBack: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  const { show, toast } = useSuccessToast();
  const [pulling, setPulling] = useState(false);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const decide = useDecideMove();

  const approvals = useQuery({
    queryKey: ["approvals", tenant],
    queryFn: () => fetchChannelApprovals(),
    enabled: tenant !== "none",
  });
  const channels = useQuery<ChannelsResponse>({
    queryKey: ["channels", tenant, "list"],
    queryFn: fetchChannels,
    enabled: tenant !== "none",
  });

  const slugSet = useMemo(() => new Set<string>((channels.data?.channels ?? []).map((c) => c.channel_slug)), [channels.data]);
  const pending = approvals.data ? growthPending(approvals.data, slugSet) : null;
  const slugs = Object.keys(pending?.inChannels ?? {}).sort();
  const decisions: ChannelDecision[] = (approvals.data?.decisions ?? []).filter((d) => isGrowthDecision(d, slugSet));

  const reads = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: ["growth-review", "actions", tenant, slug],
      queryFn: () => fetchChannelActionRows(slug),
      enabled: tenant !== "none",
    })),
  });
  const reading = approvals.isPending || reads.some((r) => r.isPending);
  const now = Date.now();
  const found: ReviewAction[] = reads.flatMap((r) => (r.data?.actions ?? []).filter((a) => isOpenAction(a as never, now)));
  const failed = slugs.filter((_, i) => reads[i]?.isError);
  const previews = slugs.map((slug, i) => [slug, reads[i]?.data?.lockedPreview ?? 0] as const).filter(([, n]) => n > 0);
  const { top, quick, longer } = arrangeReview(found, (a, b) => compareActions(a as never, b as never));

  function refreshAll() {
    void qc.invalidateQueries({ queryKey: ["approvals", tenant] });
    void qc.invalidateQueries({ queryKey: ["channels", tenant] });
    void qc.invalidateQueries({ queryKey: ["growth-review", "actions", tenant] });
  }

  function pull() {
    setPulling(true);
    void Promise.all([approvals.refetch(), channels.refetch(), ...reads.map((r) => r.refetch())]).finally(() => setPulling(false));
  }

  async function settle(id: string, done: Outcome, decision: string, write: () => Promise<unknown>) {
    setBusy(id);
    setRowError(null);
    try {
      const result = await write();
      if (result === null) return;
      setOutcome((o) => ({ ...o, [id]: done }));
      track("growth_review_decided", { decision });
      show(`${done}.`);
      refreshAll();
    } catch (e) {
      setRowError({ id, message: e instanceof Error && e.message ? e.message : "That did not go through. Try again." });
    } finally {
      setBusy(null);
    }
  }

  const didIt = (a: ReviewAction) => settle(a.id, "Done", "done", () => approveAction(a.id, undefined, "channel_action"));
  const notNow = (a: ReviewAction) => settle(a.id, "Not now", "not_now", () => dismissAction(a.id, { action: "snoozed" }));

  function decideMove(d: ChannelDecision, action: "approve" | "reject", shipAnyway = false) {
    void settle(d.id, action === "approve" ? "Approved" : "Rejected", action, async () => {
      try {
        const result = await decide.mutateAsync({ id: d.id, action, shipAnyway });
        if (result === "needs_confirm") {
          setAsking(d.id);
          return null;
        }
        return result;
      } catch {
        throw new Error(MOVE_ERROR[action]);
      }
    });
  }

  const openChannel = (slug: string) => router.push({ pathname: "/channels/actions/[slug]", params: { slug } });
  const ask = (text: string) => router.push({ pathname: "/chat", params: { prefill: text, back: "1" } });
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const openCount = (rows: Array<{ id: string }>) => rows.filter((r) => !outcome[r.id]).length;
  const nameOf = (slug: string) => channelName(slug);

  const actionButtons = (a: ReviewAction) => {
    if (outcome[a.id]) return <Text style={styles.done}>{outcome[a.id]}</Text>;
    if (a.executable) return <ActionButton compact label={`Review in ${nameOf(a.channel_slug)}`} variant="secondary" onPress={() => openChannel(a.channel_slug)} />;
    return (
      <View style={styles.buttons}>
        <ActionButton compact label="Did it" busy={busy === a.id} disabled={busy === a.id} onPress={() => void didIt(a)} />
        <ActionButton compact label="Not now" variant="secondary" disabled={busy === a.id} onPress={() => void notNow(a)} />
      </View>
    );
  };

  const decisionButtons = (d: ChannelDecision) => {
    if (outcome[d.id]) return <Text style={styles.done}>{outcome[d.id]}</Text>;
    return (
      <View style={styles.buttons}>
        <ActionButton compact label="Approve" busy={busy === d.id} disabled={busy === d.id} onPress={() => decideMove(d, "approve")} />
        <ActionButton compact label="Not now" variant="secondary" disabled={busy === d.id} onPress={() => decideMove(d, "reject")} />
      </View>
    );
  };

  const errorFor = (id: string) => (rowError?.id === id ? <ErrorLine>{rowError.message}</ErrorLine> : null);

  const actionDetail = (a: ReviewAction) => (
    <ActionDetail
      a={a}
      onAsk={() => ask(`About "${a.title}": what should I know before I do it?`)}
      onOpen={() => openChannel(a.channel_slug)}
    />
  );

  const actionRow = (a: ReviewAction) => (
    <ReviewRow
      key={a.id}
      slug={a.channel_slug}
      title={a.title}
      why={firstSentence(a.body?.step?.body)}
      chip={EFFORT_LABEL[a.body?.step?.effort ?? ""] ?? null}
      open={!!open[a.id] && !outcome[a.id]}
      onToggle={() => toggle(a.id)}
      buttons={actionButtons(a)}
      detail={actionDetail(a)}
      error={errorFor(a.id)}
    />
  );

  const decisionRow = (d: ChannelDecision) => {
    const step = d.body?.step;
    return (
      <ReviewRow
        key={d.id}
        slug={d.channel_slug ?? null}
        title={adChangeHeadline(d.decision_class, d.body) ?? (step?.title || decisionLabel(d.decision_class))}
        why={firstSentence(step?.body)}
        chip="You approve"
        open={!!open[d.id] && !outcome[d.id]}
        onToggle={() => toggle(d.id)}
        buttons={decisionButtons(d)}
        detail={
          <View style={styles.detail}>
            <ActionStepsView text={step?.body} />
            {d.channel_slug ? <TextLink label={`Open in ${nameOf(d.channel_slug)}`} onPress={() => openChannel(d.channel_slug as string)} /> : null}
          </View>
        }
        error={errorFor(d.id)}
      />
    );
  };

  const total = openCount(decisions) + openCount(found);
  const nothing = !pending?.capped && !top && decisions.length === 0 && failed.length === 0 && previews.length === 0;

  const group = (label: string, count: number | string, rows: React.ReactNode) => (
    <View>
      <Text style={styles.groupLabel}>{`${label} · ${count}`.toUpperCase()}</Text>
      {rows}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.back} accessibilityLabel="Go back" accessibilityRole="button" hitSlop={8}>
          <BackIcon color={colors.ink} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Review actions
        </Text>
        <View style={styles.backPlaceholder} />
      </View>

      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={pulling} onRefresh={pull} />}>
        {approvals.isError ? (
          <ErrorLine>Could not load actions. Pull down to try again.</ErrorLine>
        ) : reading ? (
          <Bars label="Loading actions" lines={4} height={18} />
        ) : (
          <>
            <Text style={styles.count}>
              {`${total}${pending?.capped ? "+" : ""} ${total === 1 && !pending?.capped ? "action" : "actions"} waiting for your OK`}
            </Text>

            {top ? (
              <View style={styles.topCard} accessibilityLabel="If you do one thing this week">
                <Text style={styles.groupLabelInline}>IF YOU DO ONE THING THIS WEEK</Text>
                <View style={styles.topHead}>
                  <ChannelLogo slug={top.channel_slug} size={24} />
                  <Text style={styles.topTitle}>{top.title}</Text>
                </View>
                <View style={styles.topMeta}>
                  {EFFORT_LABEL[top.body?.step?.effort ?? ""] ? <Text style={styles.chip}>{EFFORT_LABEL[top.body?.step?.effort ?? ""]}</Text> : null}
                  <Text style={styles.why}>{nameOf(top.channel_slug)}</Text>
                </View>
                {!outcome[top.id] ? actionDetail(top) : null}
                <View style={styles.topButtons}>{actionButtons(top)}</View>
                {errorFor(top.id)}
              </View>
            ) : null}

            {failed.map((slug) => (
              <View key={`f-${slug}`} style={styles.note}>
                <Text style={styles.noteWarn}>{`Couldn't load ${nameOf(slug)}. `}</Text>
                <TextLink label="Try again" onPress={pull} />
              </View>
            ))}
            {previews.map(([slug, n]) => (
              <View key={`p-${slug}`} style={styles.note}>
                <Text style={styles.why}>{`${n} ${n === 1 ? "preview" : "previews"} in ${nameOf(slug)} · `}</Text>
                <TextLink label={`Open ${nameOf(slug)}`} onPress={() => openChannel(slug)} />
              </View>
            ))}

            {nothing ? (
              <Text style={styles.empty}>Nothing is waiting in the list right now.</Text>
            ) : (
              <View style={styles.list}>
                {decisions.length > 0 || pending?.capped
                  ? group(
                      "To approve",
                      pending?.capped ? `${openCount(decisions)}+` : openCount(decisions),
                      <>
                        {decisions.map(decisionRow)}
                        {pending?.capped ? <Text style={styles.more}>More wait than this list shows. Open Home to see them.</Text> : null}
                      </>,
                    )
                  : null}
                {quick.length > 0 ? group("Quick wins", openCount(quick), quick.map(actionRow)) : null}
                {longer.length > 0 ? group("Takes longer", openCount(longer), longer.map(actionRow)) : null}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {toast}
      <ConfirmDialog
        visible={asking !== null}
        icon="alertCircle"
        title="Open the PR anyway?"
        message={SHIP_RED_CONFIRM}
        cancelLabel="Cancel"
        confirmLabel="Open the PR"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const d = decisions.find((x) => x.id === asking);
          setAsking(null);
          if (d) decideMove(d, "approve", true);
        }}
      />
    </SafeAreaView>
  );
}

function decisionLabel(cls: string): string {
  if (cls === "channel.recipe_step") return "Recipe step";
  if (cls === "bulk_outbound.send") return "Bulk email";
  if (cls.startsWith("social.publish.")) return "Post";
  if (cls.startsWith("meta_ads.")) return "Meta Ad";
  if (cls.startsWith("google_ads.")) return "Google Ad";
  if (cls.startsWith("x_ads.")) return "X Ad";
  return cls.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ActionDetail({ a, onAsk, onOpen }: { a: ReviewAction; onAsk: () => void; onOpen: () => void }) {
  const styles = useStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const paste = a.body?.step?.deliverable?.content?.trim();
  const before = beforeYouDoIt(a.body);
  return (
    <View style={styles.detail}>
      <ActionStepsView text={a.body?.step?.body?.trim()} />
      {paste ? (
        <View style={styles.block}>
          <Text style={styles.groupLabelInline}>READY TO PASTE</Text>
          <View style={styles.paste}>
            <Text style={styles.pasteText} selectable>
              {paste}
            </Text>
            <Pressable
              style={styles.copy}
              onPress={() => {
                Clipboard.setString(paste);
                setCopied(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Copy the text"
            >
              <Text style={styles.copyText}>{copied ? "Copied" : "Copy"}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {before.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.groupLabelInline}>BEFORE YOU DO IT</Text>
          {before.map(([k, v]) => (
            <View key={k} style={styles.kv}>
              <Text style={styles.kvKey}>{k}</Text>
              <Text style={styles.kvVal}>{v}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.links}>
        <TextLink label="Ask Zavi about this" onPress={onAsk} />
        <TextLink label={`Open in ${channelName(a.channel_slug)}`} onPress={onOpen} />
      </View>
    </View>
  );
}

function ReviewRow({
  slug,
  title,
  why,
  chip,
  open,
  onToggle,
  buttons,
  detail,
  error,
}: {
  slug: string | null;
  title: string;
  why: string;
  chip: string | null;
  open: boolean;
  onToggle: () => void;
  buttons: React.ReactNode;
  detail: React.ReactNode;
  error: React.ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <Pressable style={styles.rowHead} onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title}>
        {slug ? <ChannelLogo slug={slug} size={28} /> : <View style={styles.noLogo} />}
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
          {why ? (
            <Text style={styles.why} numberOfLines={open ? undefined : 1}>
              {why}
            </Text>
          ) : null}
          {chip ? <Text style={styles.chip}>{chip}</Text> : null}
        </View>
        <View style={open ? undefined : styles.chevClosed}>
          <Icon name="chevron" size={18} color={colors.muted} />
        </View>
      </Pressable>
      <View style={styles.rowButtons}>{buttons}</View>
      {open ? <View style={styles.rowDetail}>{detail}</View> : null}
      {error}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
    back: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    backPlaceholder: { width: 36 },
    title: { flex: 1, textAlign: "center", fontFamily: font.family.semi, fontSize: 16, lineHeight: 22, includeFontPadding: false, color: colors.ink },
    content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20, gap: space.md },
    count: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 18, includeFontPadding: false, color: colors.muted },
    empty: { paddingVertical: space.xl, textAlign: "center", fontFamily: font.family.regular, fontSize: 14, color: colors.muted },
    topCard: { gap: space.sm, padding: space.lg, borderWidth: 1.5, borderColor: colors.ink, borderRadius: radius.lg },
    topHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    topTitle: { flex: 1, fontFamily: font.family.semi, fontSize: 17, lineHeight: 23, color: colors.ink },
    topMeta: { flexDirection: "row", alignItems: "center", gap: space.sm },
    topButtons: { marginTop: space.xs },
    list: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg, overflow: "hidden" },
    groupLabel: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, backgroundColor: colors.soft, fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.6, color: colors.muted },
    groupLabelInline: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.6, color: colors.muted },
    row: { borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
    rowHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    noLogo: { width: 28, height: 28 },
    rowText: { flex: 1, minWidth: 0, gap: 3 },
    rowTitle: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 20, color: colors.ink },
    why: { fontFamily: font.family.regular, fontSize: 12.5, lineHeight: 18, color: colors.muted },
    chip: { alignSelf: "flex-start", overflow: "hidden", marginTop: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.soft, fontFamily: font.family.semi, fontSize: 11.5, color: colors.muted },
    chevClosed: { transform: [{ rotate: "-90deg" }] },
    rowButtons: { paddingLeft: 28 + space.md },
    buttons: { flexDirection: "row", gap: space.sm },
    done: { fontFamily: font.family.semi, fontSize: 12.5, color: colors.status.greenDot },
    rowDetail: { paddingLeft: 28 + space.md },
    detail: { gap: space.md },
    block: { gap: 6 },
    paste: { padding: space.md, gap: space.sm, borderRadius: radius.md, backgroundColor: colors.soft },
    pasteText: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    copy: { alignSelf: "flex-start", minHeight: 32, paddingHorizontal: 12, justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    copyText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    kv: { gap: 1 },
    kvKey: { fontFamily: font.family.semi, fontSize: 12.5, color: colors.muted },
    kvVal: { fontFamily: font.family.regular, fontSize: 12.5, lineHeight: 18, color: colors.ink },
    links: { flexDirection: "row", flexWrap: "wrap", gap: space.lg },
    note: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline" },
    noteWarn: { fontFamily: font.family.regular, fontSize: 13, color: colors.status.redText },
    more: { padding: space.lg, borderTopWidth: 1, borderTopColor: colors.line, fontFamily: font.family.regular, fontSize: 12.5, color: colors.muted },
  });

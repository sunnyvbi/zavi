import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Clipboard,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { BackIcon, Icon } from "../../components/Icon";
import { UnderlinedText } from "../../components/UnderlinedText";
import { ChannelIcon, ChannelLogo, type ChannelIconName } from "../../components/channels/ChannelGlyph";
import * as WebBrowser from "expo-web-browser";
import { adApproveConfirm, cardTag, deliverableCaption, detailExecNote, execLine, mayApproveOnPhone, phoneApproveNote, type PhoneRole } from "../../features/channels/channelPage";
import { AdApproveConfirm } from "../../components/channels/AdApproveConfirm";
import { useMyRole } from "../../features/settings/api";
import { getChannel } from "@zavi/shared";
import { emailCardUrl } from "../../features/channels/api";
import { Receipt } from "../../components/channels/ChannelActionCard";
import { CampaignAdReview } from "../../components/channels/CampaignAdReview";
import { CardBullets } from "../../components/channels/CardBullets";
import { ChannelActionsSkeleton } from "../../components/channels/ChannelStates";
import { useChannelToast } from "../../components/channels/ChannelToast";
import { WriterConfirm } from "../../components/channels/WriterConfirm";
import { WriterEdit } from "../../components/channels/WriterEdit";
import { WriterRewrite } from "../../components/channels/WriterRewrite";
import { useKeyboardReveal } from "../../components/useKeyboardReveal";
import {
  useApproveAction,
  useApproveChange,
  useChannelAction,
  useChannelKinds,
  useRedoAction,
  useSaveActionSteps,
} from "../../features/channels/hooks";
import type { ChannelAction } from "../../features/channels/types";
import { CHANNELS_ENABLED } from "../../lib/flags";
import { track } from "../../lib/analytics";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { KeyboardAvoider } from "../../components/KeyboardAvoider";

type Mode = "view" | "edit" | "rewrite" | "post" | "discard" | "approve";

const FALLBACK_ERROR = "Something went wrong. Try again.";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FALLBACK_ERROR;
}

function headingFor(action: ChannelAction): string {
  if (action.slug === "x_organic") return "X Writer";
  if (action.kind === "social") return `${action.channelName} · Writer`;
  return `${action.channelName} · Action`;
}

const MAILTO_MAX = 1800;

function usesStoredButton(action: ChannelAction, role: PhoneRole | null): boolean {
  if (action.cardKind === "executes" && isAdChange(action) && action.changeRows.length === 0) return false;
  if (action.cardKind === "executes") return mayApproveOnPhone(action, role) && action.status === "pending" && (!action.execStatus || action.execStatus === "failed");
  return action.cardKind !== null && action.cardKind !== "post";
}

function isAdChange(action: ChannelAction): boolean {
  return getChannel(action.slug)?.category === "paid";
}

function approveBody(action: ChannelAction): string {
  if (action.slug === "generated_video") return "Zavi makes the video and it plays on this card. You are charged only when it arrives; if it fails, nothing is charged.";
  return "Zavi's engineer opens a pull request on your repository with exactly these changes. Nothing goes live until you merge it on GitHub.";
}

function postLabelFor(_slug: string): string {
  return "Post";
}

export default function ChannelActionScreen() {
  if (!CHANNELS_ENABLED) return <Redirect href="/chat" />;
  return <ChannelActionDetail />;
}

function ChannelActionDetail() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const { id = "" } = useLocalSearchParams<{ id?: string }>();
  const { action, isLoading, isError, refetch } = useChannelAction(id);
  const role = useMyRole();
  const approve = useApproveAction();
  const approveChange = useApproveChange();
  const redo = useRedoAction();
  const saveSteps = useSaveActionSteps();
  const { show, toast } = useChannelToast();
  const { scrollRef, onScroll, reveal } = useKeyboardReveal();
  const editorBox = useRef<View>(null);
  const lastAction = useRef<ChannelAction | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<string | null>(null);
  const [primaryDone, setPrimaryDone] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ticks, setTicks] = useState<number[] | null>(null);
  const [stepsError, setStepsError] = useState<string | null>(null);

  if (action) lastAction.current = action;
  const busy = approve.isPending || redo.isPending || approveChange.isPending;
  const finished = approve.isSuccess || redo.isSuccess || approveChange.isSuccess;
  const current = action ?? (busy || finished ? lastAction.current : null);
  const kinds = useChannelKinds(current?.slug ?? "");

  const leave = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/channels");
  }, [router]);

  const requestLeave = useCallback(() => {
    if (mode === "edit") {
      Keyboard.dismiss();
      setMode("discard");
      return;
    }
    if (mode === "discard") {
      setMode("edit");
      return;
    }
    leave();
  }, [leave, mode]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy) return true;
      if (mode === "rewrite" || mode === "post" || mode === "approve") setMode("view");
      else requestLeave();
      return true;
    });
    return () => sub.remove();
  }, [busy, mode, requestLeave]);

  useEffect(() => {
    if (mode === "edit") reveal(editorBox.current);
  }, [mode, reveal]);

  if (!current) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <TopBar title="Review" onLeave={leave} />
        {isLoading ? (
          <View style={styles.content}>
            <ChannelActionsSkeleton count={1} />
          </View>
        ) : null}
        {!isLoading && isError ? (
          <View style={styles.state} accessibilityRole="alert">
            <Text style={styles.stateText}>Couldn't load this action.</Text>
            <Pressable
              style={styles.stateButton}
              onPress={() => void refetch()}
              accessibilityRole="button"
              accessibilityLabel="Retry loading this action"
            >
              <Text style={styles.stateButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {!isLoading && !isError ? (
          <View style={styles.state}>
            <Text style={styles.stateText}>This action is no longer waiting.</Text>
            <Pressable
              style={styles.stateButton}
              onPress={leave}
              accessibilityRole="button"
              accessibilityLabel="Back to channels"
            >
              <Text style={styles.stateButtonText}>Back to channels</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  const text = draft ?? current.text;
  const edited = draft !== null && draft !== current.text;
  const count = Array.from(text).length;
  const isSocial = current.kind === "social";

  function markComplete(target: ChannelAction) {
    approve.mutate(
      { id: target.id, source: target.action_source },
      {
        onSuccess: () => {
          track("channel_action_completed", { slug: target.slug });
          show("Marked done.");
          leave();
        },
        onError: (error) => show(errorMessage(error)),
      },
    );
  }

  function post(target: ChannelAction) {
    approve.mutate(
      { id: target.id, payloadText: edited ? text : undefined, source: target.action_source },
      {
        onSuccess: () => {
          track("channel_action_posted", { slug: target.slug });
          show("Approved. It publishes from your account now.");
          leave();
        },
        onError: (error) => show(errorMessage(error)),
      },
    );
  }

  function confirmApprove(target: ChannelAction) {
    if (!mayApproveOnPhone(target, role)) {
      setMode("view");
      show(phoneApproveNote(target, role) ?? "You can't approve this change from here.");
      return;
    }
    approveChange.mutate(target.id, {
      onSuccess: () => {
        track("channel_action_approved", { slug: target.slug });
        show(target.slug === "generated_video" ? "Approved. Zavi is making the video." : isAdChange(target) ? `Approved. Zavi is making the change in ${target.channelName}.` : "Approved. Zavi is opening the pull request.");
        leave();
      },
      onError: (error) => {
        setMode("view");
        show(errorMessage(error));
      },
    });
  }

  function openEmailCard(target: ChannelAction) {
    void WebBrowser.openBrowserAsync(emailCardUrl(target.id)).catch(() => show("Couldn't open the email card."));
  }

  function rewrite(target: ChannelAction, message: string) {
    redo.mutate(
      { id: target.id, message, source: target.action_source },
      {
        onSuccess: () => {
          track("channel_action_rewritten", { slug: target.slug });
          show("Zavi is rewriting this one.");
          leave();
        },
        onError: (error) => show(errorMessage(error)),
      },
    );
  }

  function copy() {
    Clipboard.setString(text);
    show("Draft copied.");
  }

  async function openEmail(target: ChannelAction) {
    const subject = `subject=${encodeURIComponent(target.deliverableLabel ?? target.title)}`;
    const full = `mailto:?${subject}&body=${encodeURIComponent(text)}`;
    const tooLong = full.length > MAILTO_MAX;
    try {
      if (tooLong) Clipboard.setString(text);
      await Linking.openURL(tooLong ? `mailto:?${subject}` : full);
      setNote(tooLong ? "Email body copied, paste it in" : null);
      setPrimaryDone(true);
    } catch {
      show("Couldn't open your mail app.");
    }
  }

  function pressPrimary(target: ChannelAction) {
    if (primaryDone) {
      markComplete(target);
      return;
    }
    switch (target.cardKind) {
      case "executes":
        setMode("approve");
        return;
      case "plan":
        markComplete(target);
        return;
      case "task":
        if (target.link) {
          void Linking.openURL(target.link)
            .then(() => setPrimaryDone(true))
            .catch(() => show("Couldn't open that link."));
          return;
        }
        setHowOpen(true);
        setPrimaryDone(true);
        return;
      case "message":
        if (target.primaryLabel === "Open email") {
          void openEmail(target);
          return;
        }
        break;
    }
    Clipboard.setString(text);
    show("Copied.");
    setPrimaryDone(true);
  }

  function toggleStep(target: ChannelAction, index: number) {
    const before = ticks ?? target.stepsDone;
    const next = before.includes(index)
      ? before.filter((i) => i !== index)
      : [...before, index].sort((a, b) => a - b);
    setTicks(next);
    setStepsError(null);
    saveSteps.mutate(
      { id: target.id, stepsDone: next },
      {
        onError: () => {
          setTicks(before);
          setStepsError("That step didn't save. Try again.");
        },
      },
    );
  }

  const editing = mode === "edit" || mode === "discard";
  const execNow = execLine(current.execStatus, current.channelName, current.execFixText);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <TopBar title={headingFor(current)} onLeave={requestLeave} disabled={busy} />
      <KeyboardAvoider style={styles.body}>
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {mode === "discard" ? (
            <WriterConfirm
              title="Discard your edits?"
              body="Your saved draft will stay unchanged."
              confirmLabel="Discard edits"
              cancelLabel="Keep editing"
              onConfirm={leave}
              onCancel={() => setMode("edit")}
              busy={false}
              destructive
            />
          ) : null}

          {editing ? (
            <View ref={editorBox} style={mode === "discard" && styles.hidden}>
              <WriterEdit
                initialText={text}
                charLimit={current.charLimit}
                onSave={(next) => {
                  setDraft(next);
                  setMode("view");
                  show("Draft saved.");
                }}
                onCancel={() => setMode("view")}
              />
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.statusRow}>
                <ChannelLogo slug={current.slug} size={16} />
                {current.blocking ? (
                  <View style={styles.blocking}>
                    <Text style={styles.blockingText}>Blocking</Text>
                  </View>
                ) : null}
                <Text style={styles.status} numberOfLines={1}>
                  {[
                    cardTag(kinds[current.id], current.intent),
                    current.rewritten ? "Rewritten" : null,
                    current.weeksOld ? `${current.weeksOld} wk old` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Text style={styles.title} accessibilityRole="header">
                {current.title}
              </Text>
              {(current.copy?.lead || current.why) && !editing ? <Text style={styles.whyBody}>{current.copy?.lead || current.why}</Text> : null}
              {current.copy && !editing ? <CardBullets copy={current.copy} executable={current.executable || current.cardKind === "executes"} /> : null}
              {current.why && text ? (
                <Text style={styles.caption}>{deliverableCaption(kinds[current.id], current.deliverableLabel)}</Text>
              ) : null}
              {current.copy && current.why === null && !draft ? null : (
                <Text style={styles.cardText} selectable>
                  {text}
                </Text>
              )}
              {current.slug === "chatgpt_ads" && current.executable && current.action_source === "channel_action" ? <CampaignAdReview actionId={current.id} actionStatus={current.status} execStatus={current.execStatus} /> : null}
              {isSocial ? (
                <View style={styles.cardFooter}>
                  <Text style={styles.meta}>
                    {count}/{current.charLimit}
                  </Text>
                </View>
              ) : null}
            </View>
          )}

          {mode === "view" && execNow ? (
            <View style={styles.execRow} accessibilityRole={execNow.tone === "failed" ? "alert" : undefined}>
              <Text style={styles.execText}>{execNow.text}</Text>
              {execNow.fix ? <Text style={styles.execText}>{execNow.fix}</Text> : null}
              {execNow.tone === "done" && current.execReceipt ? <Receipt receipt={current.execReceipt} /> : null}
            </View>
          ) : null}

          {mode === "view" && usesStoredButton(current, role) ? (
            <View style={styles.actions}>
              <ActionButton
                label={(primaryDone ? current.doneLabel : current.primaryLabel) ?? ""}
                icon={primaryDone ? "check" : undefined}
                onPress={() => pressPrimary(current)}
                disabled={busy}
                filled
              />
              {current.canEdit ? (
                <ActionButton label="Edit" icon="edit" onPress={() => setMode("edit")} disabled={busy} />
              ) : null}
              {current.cardKind === "plan" || current.cardKind === "task" ? (
                <ActionButton label="Copy" icon="copy" onPress={copy} disabled={busy} />
              ) : null}
              {current.canRewrite ? (
                <ActionButton
                  label="Rewrite"
                  icon="plus"
                  onPress={() => setMode("rewrite")}
                  disabled={busy}
                />
              ) : null}
            </View>
          ) : null}

          {mode === "view" && usesStoredButton(current, role) && note ? (
            <Text style={styles.note}>{note}</Text>
          ) : null}

          {mode === "view" && !usesStoredButton(current, role) ? (
            <View style={styles.actions}>
              {}
              {current.emailCard && current.status === "pending" && (!current.execStatus || current.execStatus === "failed") ? (
                <ActionButton label="Review and send" onPress={() => openEmailCard(current)} disabled={busy} filled />
              ) : current.executable || current.cardKind === "executes" ? (
                execNow ? null : (
                  <Text style={styles.note}>{detailExecNote(current, role)}</Text>
                )
              ) : (
                <ActionButton
                  label="I did this"
                  icon="check"
                  onPress={() => markComplete(current)}
                  disabled={busy}
                />
              )}
              {current.canPost ? (
                <ActionButton
                  label={postLabelFor(current.slug)}
                  onPress={() => setMode("post")}
                  disabled={busy}
                  filled
                />
              ) : null}
              {current.canEdit ? (
                <ActionButton label="Edit" icon="edit" onPress={() => setMode("edit")} disabled={busy} />
              ) : null}
              <ActionButton label="Copy" icon="copy" onPress={copy} disabled={busy} />
              {current.canRewrite ? (
                <ActionButton
                  label="Rewrite"
                  icon="plus"
                  onPress={() => setMode("rewrite")}
                  disabled={busy}
                />
              ) : null}
            </View>
          ) : null}

          {mode === "post" ? (
            <View style={styles.panel}>
              <WriterConfirm
                title={`Post to ${current.channelName}?`}
                body="This sends it from your connected account."
                previewText={text}
                confirmLabel="Post"
                cancelLabel="Cancel"
                onConfirm={() => post(current)}
                onCancel={() => setMode("view")}
                busy={busy}
              />
            </View>
          ) : null}

          {mode === "approve" && isAdChange(current) ? (
            <View style={styles.panel}>
              <AdApproveConfirm
                confirm={adApproveConfirm(current)}
                onConfirm={() => confirmApprove(current)}
                onCancel={() => setMode("view")}
                busy={busy}
              />
            </View>
          ) : mode === "approve" ? (
            <View style={styles.panel}>
              <WriterConfirm
                title={`${current.primaryLabel ?? "Approve"}?`}
                body={approveBody(current)}
                confirmLabel={current.primaryLabel ?? "Approve"}
                cancelLabel="Cancel"
                onConfirm={() => confirmApprove(current)}
                onCancel={() => setMode("view")}
                busy={busy}
              />
            </View>
          ) : null}

          {mode === "rewrite" ? (
            <View style={styles.panel}>
              <WriterRewrite
                onSubmit={(message) => rewrite(current, message)}
                onCancel={() => setMode("view")}
                busy={busy}
              />
            </View>
          ) : null}

          {mode === "view" && current.cardKind !== null && current.howTo.length > 0 ? (
            <View style={styles.how}>
              <Pressable
                style={styles.howToggleWrap}
                onPress={() => setHowOpen((open) => !open)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ expanded: howOpen }}
              >
                <View style={styles.howHead}>
                  <Text style={styles.howToggle}>HOW TO DO THIS</Text>
                  <View style={howOpen ? undefined : styles.howClosed}>
                    <ChannelIcon name="chevronDown" size={12} color={colors.muted} />
                  </View>
                </View>
              </Pressable>
              {howOpen
                ? current.howTo.map((step, index) =>
                    current.cardKind === "task" ? (
                      <Pressable
                        key={index}
                        style={styles.howRow}
                        onPress={() => toggleStep(current, index)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: (ticks ?? current.stepsDone).includes(index) }}
                      >
                        <View
                          style={[
                            styles.tick,
                            (ticks ?? current.stepsDone).includes(index) && styles.tickOn,
                          ]}
                        >
                          {(ticks ?? current.stepsDone).includes(index) ? (
                            <ChannelIcon name="check" size={10} color={colors.onInk} />
                          ) : null}
                        </View>
                        <View style={styles.flex}>
                          <Text style={styles.howLabel}>Step {index + 1}</Text>
                          <Text style={styles.howStep}>{step}</Text>
                        </View>
                      </Pressable>
                    ) : (
                      <View key={index} style={styles.howRow}>
                        <View style={styles.flex}>
                          <Text style={styles.howLabel}>Step {index + 1}</Text>
                          <Text style={styles.howStep}>{step}</Text>
                        </View>
                      </View>
                    ),
                  )
                : null}
              {howOpen && stepsError ? <Text style={styles.note}>{stepsError}</Text> : null}
            </View>
          ) : null}

        </ScrollView>
      </KeyboardAvoider>
      {toast}
    </SafeAreaView>
  );
}

function TopBar({ title, onLeave, disabled = false }: { title: string; onLeave: () => void; disabled?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.topBar}>
      <Pressable
        style={styles.headerButton}
        onPress={onLeave}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back to channel actions"
        accessibilityState={{ disabled }}
      >
        <BackIcon color={colors.ink} />
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.headerButton} />
    </View>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  disabled,
  filled = false,
}: {
  label: string;
  icon?: ChannelIconName;
  onPress: () => void;
  disabled: boolean;
  filled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const tint = filled ? colors.onInk : colors.ink;
  return (
    <Pressable
      style={[styles.actionButton, filled && styles.actionFilled, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
    >
      {icon ? <ChannelIcon name={icon} size={14} color={tint} /> : null}
      <Text style={[styles.actionText, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  topBar: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  headerTitle: {
    flex: 1,
    marginHorizontal: space.xs,
    includeFontPadding: false,
    fontFamily: font.family.semi,
    fontSize: 18,
    lineHeight: 24,
    textAlign: "center",
    color: colors.ink,
  },
  content: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  card: {
    marginTop: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.bg,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.green },
  status: { flexShrink: 1, includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.muted },
  title: { marginTop: 6, includeFontPadding: false, fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
  cardText: {
    marginTop: 6,
    includeFontPadding: false,
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 21,
    color: colors.ink,
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  meta: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 10, color: colors.muted },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    backgroundColor: colors.bg,
  },
  actionFilled: { backgroundColor: colors.ink, borderColor: colors.ink },
  actionText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11 },
  disabled: { opacity: 0.4 },
  panel: { marginTop: 12 },
  execRow: { marginTop: 12, gap: 4, padding: 10, borderRadius: 8, backgroundColor: colors.soft },
  execText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, lineHeight: 18, color: colors.ink },
  note: { marginTop: 8, includeFontPadding: false, fontFamily: font.family.regular, fontSize: 11, color: colors.muted },
  how: { marginTop: 12 },
  howToggleWrap: { alignSelf: "flex-start" },
  howToggle: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.5, color: colors.muted },
  howHead: { flexDirection: "row", alignItems: "center", gap: 4 },
  howClosed: { transform: [{ rotate: "-90deg" }] },
  howLabel: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11, color: colors.muted },
  caption: { marginTop: 10, includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.5, color: colors.muted },
  blocking: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: colors.status.amberBg },
  blockingText: { fontFamily: font.family.semi, fontSize: 11, color: colors.status.amberText },
  flex: { flex: 1 },
  howRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 },
  howStep: { flex: 1, includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, lineHeight: 19, color: colors.ink },
  tick: {
    width: 16,
    height: 16,
    marginTop: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  tickOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  hidden: { display: "none" },
  why: {
    marginTop: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 13,
    backgroundColor: colors.bg,
  },
  whyTitle: {
    includeFontPadding: false,
    fontFamily: font.family.semi,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: colors.muted,
  },
  whyBody: {
    marginTop: 6,
    includeFontPadding: false,
    fontFamily: font.family.regular,
    fontSize: 12,
    lineHeight: 21,
    color: colors.ink,
  },
  state: { alignItems: "center", paddingHorizontal: space.lg, paddingTop: 48, gap: 14 },
  stateText: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, lineHeight: 18, color: colors.muted, textAlign: "center" },
  stateButton: {
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    justifyContent: "center",
  },
  stateButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: 11, color: colors.ink },
});

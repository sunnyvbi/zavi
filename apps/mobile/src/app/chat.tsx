import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  BackHandler,
  Clipboard,
  FlatList,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import type { Session } from "@supabase/supabase-js";
import { useAuth } from "../auth/AuthProvider";
import { AutoScrollRow } from "../components/AutoScrollRow";
import { ChatBubble } from "../components/ChatBubble";
import { useToast } from "../components/Toast";
import { LinkCopiedContext } from "../components/Markdown";
import { takeFlash } from "../lib/flash";
import { track } from "../lib/analytics";
import { Composer } from "../components/Composer";
import { APPROVALS_ENTRY_ENABLED } from "../lib/flags";
import { ApprovalCard } from "../components/ApprovalCard";
import { ApprovalsSheet } from "../components/ApprovalsSheet";
import { ThreadDrawer } from "../components/ThreadDrawer";
import { ThreadActionsSheet } from "../components/ThreadActionsSheet";
import { AgentPickerSheet, type ChatTopic } from "../components/AgentPickerSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RunProgress } from "../components/RunProgress";
import { StrategyProgressCard } from "../components/setup/StrategyProgressCard";
import { StreamDraftBubble } from "../components/StreamDraftBubble";
import { CreditWallNotice } from "../components/CreditWallNotice";
import {
  cancelRun,
  chatTopicFields,
  fetchChannelThreads,
  fetchRunUnsettled,
  fetchThreadAgentSlug,
  markThreadSeen,
  sendChat,
} from "../features/agents/api";
import { creditWallFromError, type CreditWall } from "../features/agents/creditWall";
import { useRunArtifacts } from "../features/agents/runArtifacts";
import { useRunStreamDraft } from "../features/agents/useRunStreamDraft";
import { useThreadMessagesRealtime } from "../features/agents/useThreadMessagesRealtime";
import { setOpenThread } from "../lib/push";
import { heldAnswerFor, splitStreamDraft, withLiveRun } from "../features/agents/streamDraftState";
import { editableMessageIds, messageMenuTime, rowsFromMessage } from "../features/agents/editMessage";
import { GO_DEEPER_SLUGS, goDeeperPrompts } from "../features/agents/goDeeper";
import { readSuggestions } from "../features/agents/replyCards";
import { GoDeeperButton } from "../components/GoDeeperButton";
import {
  sentVideoPlayable,
  sentVideoUri,
  useRememberSentVideo,
  useSentVideos,
  type SentVideo,
} from "../features/agents/sentVideos";
import { BackIcon, Icon } from "../components/Icon";
import { ZaviGlance } from "../components/ZaviGlance";
import { useWorkspace } from "../features/workspaces/WorkspaceProvider";
import type { IconName } from "../components/Icon";
import { usePendingApprovals, usePendingCount } from "../features/approvals/hooks";
import {
  agentQueryKeys,
  NEW_THREAD_SLOT,
  OPERATOR_SLUG,
  useChatHistory,
  useRunDepths,
  useRunProgress,
  useRunStatus,
  useSendMessage,
  useAgents,
  useThreads,
} from "../features/agents/hooks";
import { GROWTH_SLUG, channelStarters, chatSlug, topicLabel } from "../features/agents/pickerAgents";
import { agentChannel, channelAgentSlug, channelName } from "../features/channels/display";
import { getChannel } from "@zavi/shared";
import { useDraft } from "../features/agents/useDraft";
import {
  AccessDeniedError,
  ImageAttachError,
  MAX_IMAGES_PER_TURN,
  pickImages,
  uploadChatFile,
  type PickedImage,
} from "../features/agents/uploadImage";
import {
  CameraUnavailableError,
  MAX_DOCS_PER_TURN,
  MAX_VIDEOS_PER_TURN,
  pickDocuments,
  pickVideo,
  takePhoto,
} from "../features/agents/attachPickers";
import { AttachSheet, type AttachChoice } from "../components/AttachSheet";
import { MentionMenu, SlashMenu, type MentionPick } from "../components/ComposerMenu";
import { ApprovalPickerSheet, LibraryFileSheet, RepoSheet } from "../components/PowerToolSheets";
import { repoChipLabel, savedRepoChip, useGithubRepos } from "../features/connectors/githubRepos";
import { ConnectorTile } from "../components/connections/ConnectorLogo";
import { ChannelLogo } from "../components/channels/ChannelGlyph";
import { attachArtifact, submitFeedback } from "../features/agents/api";
import {
  SLASH_COMMANDS,
  approvalSummary,
  composeMessage,
  emptyMentionHint,
  feedbackConfirmation,
  filterSlash,
  libraryAttachBlock,
  mentionQuery,
  parseSend,
  slashHint,
  slashQuery,
  stripMention,
  turnText,
  type ApprovalContext,
  type SlashCommand,
} from "../features/agents/composerTools";
import {
  NO_COMMANDS,
  filterTenantCommands,
  sendableTenantCommand,
  usableCommands,
  type TenantCommand,
} from "../features/agents/tenantCommands";
import { useTenantCommands } from "../features/agents/useTenantCommands";
import type { Artifact } from "../features/artifacts/types";
import { MediaViewer, inAppVideoAvailable, type MediaItem } from "../components/MediaViewer";
import {
  countOf,
  readyPaths,
  uploadsPending,
  type Attachment,
  type AttachmentKind,
} from "../features/agents/attachments";
import { isSettled } from "../lib/status";
import { useActiveTenant } from "../features/workspaces/useActiveTenant";
import { useOnboarding } from "../features/onboarding/OnboardingProvider";
import { useAiConsent } from "../features/consent/useAiConsent";
import { AiConsentGate } from "../components/AiConsentGate";
import { ChatSkeleton } from "../components/ChatSkeleton";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import type { ChatMessage } from "../features/agents/types";
import { KeyboardAvoider, useSteadyTopInset } from "../components/KeyboardAvoider";
import { friendlyError } from "../components/ErrorCard";

const HEADER_HEIGHT = 54;
const COPY_MENU_WIDTH = 220;
const COPY_MENU_ROW_HEIGHT = 48;
const COPY_MENU_TIME_HEIGHT = 36;
const COPY_MENU_PADDING = 8;
const COPY_MENU_GAP = 10;

type ChatTopicRef = { channel?: string; action?: string };
type ThreadBinding =
  | ({ kind: "bound"; id: string; slug: string } & ChatTopicRef)
  | ({ kind: "new"; slug: string } & ChatTopicRef);

type Unsent = {
  id: string;
  key: string;
  text: string;
  paths: { images: string[]; videos: string[]; docs: string[] };
  localVideo?: { uri: string; name: string };
  commandSlug?: string;
};

function carriesTopic(slug: string): boolean {
  return slug === OPERATOR_SLUG || !!agentChannel(slug);
}

function topicFromParams(channel: string | undefined, action: string | undefined): ChatTopicRef {
  if (!channel || !getChannel(channel)) return {};
  return action && /^[0-9a-z-]{1,64}$/i.test(action) ? { channel, action } : { channel };
}

let unsentSeq = 0;
let noteSeq = 0;

type SystemNote = { id: string; key: string; text: string };
const NOTE_TTL_MS = 30_000;
const HELD_ANSWER_MS = 8_000;

function noteMessage(n: SystemNote): ChatMessage {
  return { id: n.id, sender_role: "system", body: n.text, agent_run_id: null, created_at: "" };
}

function unsentMessage(u: Unsent): ChatMessage {
  return {
    id: u.id,
    sender_role: "user",
    body: u.text || (u.paths.videos.length ? "(video)" : ""),
    agent_run_id: null,
    created_at: "",
    attachments: [
      ...u.paths.images.map((path) => ({ path, kind: "image" as const })),
      ...u.paths.docs.map((path) => ({ path, kind: "doc" as const })),
    ],
  };
}

export default function Chat() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const {
    thread_id: threadIdParam,
    slug: slugParam,
    prefill,
    open_drawer: openDrawerParam,
    back: backParam,
    send: sendParam,
    channel: channelParam,
    channel_action: channelActionParam,
  } = useLocalSearchParams<{
    thread_id?: string;
    slug?: string;
    prefill?: string;
    open_drawer?: string;
    back?: string;
    send?: string;
    channel?: string;
    channel_action?: string;
  }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const steadyTop = useSteadyTopInset();
  const { width: winWidth } = useWindowDimensions();
  const { show: showCopyToast, toast: copyToast } = useToast(
    { bottom: insets.bottom + 90 },
    { fit: "content" },
  );
  useEffect(() => {
    if (!isFocused) return;
    const flash = takeFlash();
    if (flash) showCopyToast(flash);
  }, [isFocused, showCopyToast]);
  const [copyMenu, setCopyMenu] = useState<{
    body: string;
    x: number;
    y: number;
    editId?: string;
    time: string | null;
  } | null>(null);
  function onRequestCopy(body: string, position: { x: number; y: number }, messageId?: string) {
    const sent = messageId ? messages.find((m) => m.id === messageId) : undefined;
    setCopyMenu({
      body,
      ...position,
      editId: messageId && editableIds.has(messageId) ? messageId : undefined,
      time: sent ? messageMenuTime(sent.created_at) : null,
    });
  }
  function onCopyMenuConfirm() {
    if (!copyMenu) return;
    Clipboard.setString(copyMenu.body);
    setCopyMenu(null);
  }
  function onEditMenuConfirm() {
    const id = copyMenu?.editId;
    setCopyMenu(null);
    const message = id ? messages.find((m) => m.id === id) : undefined;
    if (!id || !message) return;
    setEditing((e) => ({ messageId: id, prevDraft: e ? e.prevDraft : draft.value }));
    setSendError(null);
    draft.update(message.body);
    setComposerFocusKey((k) => k + 1);
  }
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const { session } = useAuth();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const approvalsRef = useRef<BottomSheetModal>(null);
  const threadActionsRef = useRef<BottomSheetModal>(null);
  const agentPickerRef = useRef<BottomSheetModal>(null);
  const attachSheetRef = useRef<BottomSheetModal>(null);
  const librarySheetRef = useRef<BottomSheetModal>(null);
  const repoSheetRef = useRef<BottomSheetModal>(null);
  const approvalPickerRef = useRef<BottomSheetModal>(null);
  const [approvalContext, setApprovalContext] = useState<ApprovalContext | null>(null);
  const [repoChipShown, setRepoChipShown] = useState(false);
  const githubRepos = useGithubRepos();
  const tenantCommands = useTenantCommands();
  const [mention, setMention] = useState<MentionPick | null>(null);
  const [attachingFileId, setAttachingFileId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaItem | null>(null);

  const [binding, setBinding] = useState<ThreadBinding>(() => {
    const topic = topicFromParams(channelParam, channelActionParam);
    return threadIdParam && slugParam
      ? { kind: "bound", id: threadIdParam, slug: chatSlug(slugParam), ...(carriesTopic(chatSlug(slugParam)) ? topic : {}) }
      : { kind: "new", slug: topic.channel ? channelAgentSlug(topic.channel) : chatSlug(slugParam), ...topic };
  });
  const [resolvingTopic, setResolvingTopic] = useState<ChatTopicRef | null>(() => {
    const t = topicFromParams(channelParam, channelActionParam);
    return !threadIdParam && t.channel && (!prefill || t.action) ? t : null;
  });
  const [linkingThreadId, setLinkingThreadId] = useState<string | null>(() =>
    threadIdParam && !slugParam ? threadIdParam : null,
  );
  const slug = binding.slug;
  const repoMenuEnabled = slug === OPERATOR_SLUG || slug === "engineer";
  const repoLabel = repoMenuEnabled && repoChipShown ? repoChipLabel(savedRepoChip(githubRepos.data)) : null;
  const { data: threadRows } = useThreads(slug);
  const boundRow = binding.kind === "bound" ? threadRows?.find((t) => t.id === binding.id) : undefined;
  const boundChannel = binding.channel ?? boundRow?.channel_slug ?? agentChannel(slug);
  const boundAction = binding.action ?? (binding.channel ? undefined : boundRow?.channel_action_id ?? undefined);
  const topic: ChatTopicRef = carriesTopic(slug) ? { channel: boundChannel, action: boundAction } : {};
  const agentsQ = useAgents();
  const headerTitle =
    topicLabel(slug, topic.channel, {
      channel: channelName,
      agent: (s) => agentsQ.data?.find((a) => a.slug === s)?.name,
    }) ?? "Zavi";
  const answererName = carriesTopic(slug) || slug === GROWTH_SLUG ? "Zavi" : headerTitle;
  const [runBySlot, setRunBySlot] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmingStopRunId, setConfirmingStopRunId] = useState<string | null>(null);
  const [voiceResetCount, setVoiceResetCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [creditWall, setCreditWall] = useState<CreditWall | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [stopFailedRunId, setStopFailedRunId] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<Unsent[]>([]);
  const [notes, setNotes] = useState<SystemNote[]>([]);
  const [placeholderHint, setPlaceholderHint] = useState<string | null>(null);
  const [composerFocusKey, setComposerFocusKey] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mentionHint, setMentionHint] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ messageId: string; prevDraft: string } | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [confirmDeeper, setConfirmDeeper] = useState<{ messageId: string; prompt: string } | null>(null);
  const [deeper, setDeeper] = useState<{ messageId: string; busy: boolean; failure: unknown } | null>(null);

  const consent = useAiConsent();
  const [showConsentGate, setShowConsentGate] = useState(false);
  useEffect(() => {
    if (consent.needsGate && !consent.declined) setShowConsentGate(true);
  }, [consent.needsGate, consent.declined]);
  useEffect(() => {
    if (!showConsentGate) return;
    Keyboard.dismiss();
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setShowConsentGate(false);
      return true;
    });
    return () => sub.remove();
  }, [showConsentGate]);

  const boundId = binding.kind === "bound" ? binding.id : undefined;
  const slot = binding.kind === "new" ? NEW_THREAD_SLOT : binding.id;

  const activeRunId = runBySlot[`${tenant}:${slug}:${slot}`] ?? null;
  function setThreadRun(threadSlot: string, runId: string | null, threadSlug: string = slug) {
    const key = `${tenant}:${threadSlug}:${threadSlot}`;
    setRunBySlot((m) => {
      if (runId) return { ...m, [key]: runId };
      if (!(key in m)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  }

  const draft = useDraft(slug, slot);
  const [watchUntil, setWatchUntil] = useState(0);
  const { data: history, isLoading } = useChatHistory(slug, slot, watchUntil);
  useThreadMessagesRealtime(slug, slot);
  useEffect(() => {
    if (slot === NEW_THREAD_SLOT || !isFocused) return;
    setOpenThread(slot);
    return () => setOpenThread(null);
  }, [slot, isFocused]);
  const send = useSendMessage(slug, slot);
  const { data: run } = useRunStatus(activeRunId);
  const { data: progress } = useRunProgress(activeRunId);

  useEffect(() => {
    if (!threadIdParam) return;
    if (slugParam) onSelectThread(threadIdParam, chatSlug(slugParam), topicFromParams(channelParam, channelActionParam));
    else setLinkingThreadId(threadIdParam);
    router.setParams({ thread_id: undefined, slug: undefined, channel: undefined, channel_action: undefined });
  }, [threadIdParam, slugParam, router]);

  const resolveToken = useRef(0);
  useEffect(() => {
    if (!resolvingTopic?.channel || tenant === "none") return;
    let cancelled = false;
    const token = ++resolveToken.current;
    const wanted = resolvingTopic;
    void fetchChannelThreads(wanted.channel as string, wanted.action)
      .then((res) => {
        const latest = res.threads[0];
        if (cancelled || token !== resolveToken.current || !latest) return;
        onSelectThread(latest.id, channelAgentSlug(wanted.channel as string), {
          channel: wanted.channel,
          action: latest.channel_action_id ?? wanted.action,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setResolvingTopic(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvingTopic, tenant]);

  useEffect(() => {
    if (!linkingThreadId || tenant === "none") return;
    let cancelled = false;
    void fetchThreadAgentSlug(linkingThreadId, tenant).then((agentSlug) => {
      if (!cancelled) onSelectThread(linkingThreadId, chatSlug(agentSlug ?? undefined));
    });
    return () => {
      cancelled = true;
    };
  }, [linkingThreadId, tenant]);

  useEffect(() => {
    if (openDrawerParam !== "1") return;
    setDrawerOpen(true);
    router.setParams({ open_drawer: undefined });
  }, [openDrawerParam, router]);

  const { data: approvals } = usePendingApprovals();
  const { data: waitingCount } = usePendingCount();
  const pendingCount = waitingCount ?? approvals?.length ?? 0;
  const inlineApprovals = useMemo(
    () => (approvals ?? []).filter((d) => !!boundId && d.thread_id === boundId),
    [approvals, boundId],
  );

  const messages = useMemo(() => {
    const all = history?.messages ?? [];
    return hiddenIds.length ? all.filter((m) => !hiddenIds.includes(m.id)) : all;
  }, [history, hiddenIds]);
  const { tenants, activeTenantId } = useWorkspace();
  const companyName = tenants.find((t) => t.tenant_id === activeTenantId)?.display_name?.trim() || null;
  const unsentKey = `${tenant}:${slug}:${slot ?? ""}`;
  const unsentHere = unsent.filter((u) => u.key === unsentKey);
  const notesHere = notes.filter((n) => n.key === unsentKey);
  const listData =
    unsentHere.length || notesHere.length
      ? [...messages, ...unsentHere.map(unsentMessage), ...notesHere.map(noteMessage)]
      : messages;
  const { data: artifactsByRun } = useRunArtifacts(messages);
  const { data: sentVideos } = useSentVideos();
  const rememberSentVideo = useRememberSentVideo();
  const editableIds = useMemo(
    () => (boundId ? editableMessageIds(messages, (id) => !!sentVideos?.[id]) : new Set<string>()),
    [boundId, messages, sentVideos],
  );
  const { data: depthByRun } = useRunDepths(messages, GO_DEEPER_SLUGS.includes(slug));
  const deeperPrompts = useMemo(
    () => goDeeperPrompts(messages, depthByRun, slug, (m) => readSuggestions(m.meta).length > 0),
    [messages, depthByRun, slug],
  );
  const settled = isSettled(run);
  const working = !!activeRunId && !settled;
  const activeRunReplied = !!activeRunId && messages.some(
    (m) => m.agent_run_id === activeRunId && m.sender_role !== "user" && m.sender_role !== "system",
  );
  const trailingRunChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!boundId || isLoading || activeRunId) return;
    const last = messages[messages.length - 1];
    if (!last || last.sender_role !== "user" || !last.agent_run_id) return;
    const runId = last.agent_run_id;
    if (trailingRunChecked.current === runId) return;
    trailingRunChecked.current = runId;
    const threadSlot = slot;
    const threadSlug = slug;
    void fetchRunUnsettled(runId).then((going) => {
      if (going) setThreadRun(threadSlot, runId, threadSlug);
    });
  }, [boundId, isLoading, activeRunId, messages, slot, slug]);
  const lastReplyId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_role !== "user") return messages[i].id;
    }
    return null;
  }, [messages]);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => setAppActive(next === "active"));
    return () => sub.remove();
  }, []);
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (!boundId || isLoading || !isFocused || !appActive) return;
    const key = `${tenant}:${boundId}:${lastReplyId ?? ""}`;
    if (seenKey.current === key) return;
    seenKey.current = key;
    const threadSlug = slug;
    void markThreadSeen(boundId)
      .then(() => qc.invalidateQueries({ queryKey: agentQueryKeys.threads(tenant, threadSlug) }))
      .catch(() => {
        if (seenKey.current === key) seenKey.current = null;
      });
  }, [boundId, isLoading, isFocused, appActive, lastReplyId, tenant, slug, qc]);
  const ownCommands = usableCommands(tenantCommands, { editing: !!editing, channelPicked: !!mention });
  const ownList = ownCommands?.commands ?? NO_COMMANDS;
  const typedSlash = slashQuery(draft.value);
  const slashMatches =
    typedSlash !== null &&
    (filterSlash(typedSlash).length > 0 || filterTenantCommands(typedSlash, ownList).length > 0);
  const typedMention = typedSlash === null ? mentionQuery(draft.value) : null;
  const typedHint = slashMatches ? null : slashHint(draft.value, ownCommands);
  const typedParse = parseSend(draft.value);
  const typedCommand = typedParse.kind === "unknown_command" ? sendableTenantCommand(draft.value, ownList) : null;
  const composerMenu =
    slashMatches && typedSlash !== null ? (
      <SlashMenu
        query={typedSlash}
        tenantCommands={ownList}
        onPick={onPickSlash}
        onPickTenant={onPickTenantCommand}
      />
    ) : typedMention !== null ? (
      <MentionMenu query={typedMention} onPick={onPickMention} />
    ) : typedHint ? (
      <Text style={styles.slashHint}>{typedHint}</Text>
    ) : mention && mentionHint ? (
      <Text style={styles.slashHint}>{mentionHint}</Text>
    ) : null;
  const stopping = working && stoppingRunId === activeRunId;
  const stopFailed = working && !stopping && stopFailedRunId === activeRunId;
  const draftOn = working && !stopping && !activeRunReplied;
  const streamDraft = useRunStreamDraft(activeRunId, draftOn);
  const draftSplit = draftOn ? splitStreamDraft(streamDraft.text, streamDraft.status) : { narration: "", answer: "" };
  const [heldThought, setHeldThought] = useState("");
  useEffect(() => {
    if (draftSplit.narration) setHeldThought(draftSplit.narration);
  }, [draftSplit.narration]);
  useEffect(() => {
    setHeldThought("");
  }, [progress?.items.length, activeRunId]);
  const liveThought = draftSplit.narration || (draftSplit.answer ? "" : heldThought);
  const livePanel = withLiveRun(progress, { thought: liveThought, drafting: !!draftSplit.answer });
  const lastAnswer = useRef<{ runId: string; text: string } | null>(null);
  const [heldAnswer, setHeldAnswer] = useState<{ runId: string; slot: string; text: string } | null>(null);
  useEffect(() => {
    if (!draftOn || !activeRunId) return;
    lastAnswer.current = draftSplit.answer ? { runId: activeRunId, text: draftSplit.answer } : null;
  }, [draftOn, activeRunId, draftSplit.answer]);
  const heldReplied =
    !!heldAnswer &&
    messages.some(
      (m) => m.agent_run_id === heldAnswer.runId && m.sender_role !== "user" && m.sender_role !== "system",
    );
  useEffect(() => {
    if (heldAnswer && heldReplied) setHeldAnswer(null);
  }, [heldAnswer, heldReplied]);
  useEffect(() => {
    if (activeRunId) setHeldAnswer(null);
  }, [activeRunId]);
  useEffect(() => {
    if (!heldAnswer) return;
    const t = setTimeout(() => setHeldAnswer(null), HELD_ANSWER_MS);
    return () => clearTimeout(t);
  }, [heldAnswer]);

  const prefillApplied = useRef(false);
  useEffect(() => {
    if (prefillApplied.current) return;
    if (!prefill || !draft.hydrated || resolvingTopic) return;
    prefillApplied.current = true;
    if (channelParam && binding.kind === "bound") return;
    if (sendParam === "1" && binding.kind === "new") {
      void submit(prefill, { images: [], videos: [], docs: [] }, () => draft.update(prefill));
      return;
    }
    if (draft.value !== prefill) draft.update(prefill);
  }, [prefill, draft, resolvingTopic]);

  useEffect(() => {
    if (activeRunId && settled) {
      const held = heldAnswerFor({
        runStatus: run?.status,
        last: lastAnswer.current,
        runId: activeRunId,
        replied: activeRunReplied,
      });
      if (held) setHeldAnswer({ runId: activeRunId, slot, text: held });
      const key = agentQueryKeys.history(tenant, slug, slot);
      qc.invalidateQueries({ queryKey: key });
      setTimeout(() => qc.invalidateQueries({ queryKey: key }), 1_000);
      setTimeout(() => qc.invalidateQueries({ queryKey: key }), 3_000);
      setTimeout(() => qc.invalidateQueries({ queryKey: key }), 10_000);
      setWatchUntil(Date.now() + 180_000);
      setThreadRun(slot, null);
    }
  }, [settled, activeRunId, qc, tenant, slug, slot, run?.status, activeRunReplied]);

  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length, unsentHere.length, notesHere.length, working]);

  const listMetrics = useRef({ listHeight: 0, contentHeight: 0, offsetY: 0 });

  function measureAtBottom() {
    const { listHeight, contentHeight, offsetY } = listMetrics.current;
    if (contentHeight <= listHeight) return true;
    return contentHeight - listHeight - offsetY < 80;
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    listMetrics.current = {
      listHeight: layoutMeasurement.height,
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
    };
    setAtBottom(measureAtBottom());
  }

  useEffect(() => {
    listMetrics.current = { ...listMetrics.current, contentHeight: 0, offsetY: 0 };
    setAtBottom(true);
  }, [slug, slot]);

  const upload = useCallback((id: string, kind: AttachmentKind, uri: string, name: string) => {
    const request =
      kind === "image"
        ? uploadChatFile(uri, "/api/chat/upload-image", "image_path")
        : kind === "video"
          ? uploadChatFile(uri, "/api/chat/upload-video", "video_path")
          : uploadChatFile(uri, "/api/chat/upload-doc", "doc_path");
    void request
      .then((path) => {
        setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: "ready", path } : x)));
      })
      .catch((e: unknown) => {
        const message = friendlyError(e, "upload failed");
        setAttachments((a) =>
          a.map((x) => (x.id === id ? { ...x, status: "error", message } : x)),
        );
        Alert.alert(`Couldn't upload ${name}`, message);
      });
  }, []);

  const stage = useCallback(
    (kind: AttachmentKind, file: PickedImage) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      setAttachments((a) => [
        ...a,
        { id, kind, name: file.name, previewUri: file.uri, mime: file.mime, status: "uploading" },
      ]);
      upload(id, kind, file.uri, file.name);
    },
    [upload],
  );

  function onFailedAttachment(a: Attachment) {
    if (a.status !== "error") return;
    Alert.alert(`Couldn't upload ${a.name}`, a.message, [
      {
        text: "Remove",
        style: "destructive",
        onPress: () => setAttachments((list) => list.filter((x) => x.id !== a.id)),
      },
      {
        text: "Try again",
        onPress: () => {
          setAttachments((list) =>
            list.map((x) =>
              x.id === a.id
                ? { id: x.id, kind: x.kind, name: x.name, previewUri: x.previewUri, mime: x.mime, status: "uploading" }
                : x,
            ),
          );
          upload(a.id, a.kind, a.previewUri, a.name);
        },
      },
    ]);
  }

  function alertAfterPicker(
    title: string,
    message: string,
    buttons?: Parameters<typeof Alert.alert>[2],
  ) {
    setTimeout(() => Alert.alert(title, message, buttons), 600);
  }

  const onAttachChoice = useCallback(
    async (choice: AttachChoice) => {
      setPicking(true);
      const skipped: string[] = [];
      try {
        if (choice === "photos") {
          const slots = MAX_IMAGES_PER_TURN - countOf(attachments, "image");
          (await pickImages(slots, (m) => skipped.push(m))).forEach((f) => stage("image", f));
        } else if (choice === "camera") {
          if (countOf(attachments, "image") >= MAX_IMAGES_PER_TURN) {
            throw new ImageAttachError(`Max ${MAX_IMAGES_PER_TURN} images per message.`);
          }
          const photo = await takePhoto();
          if (photo) stage("image", photo);
        } else if (choice === "video") {
          if (countOf(attachments, "video") >= MAX_VIDEOS_PER_TURN) {
            throw new ImageAttachError("One video per message.");
          }
          const video = await pickVideo();
          if (video) stage("video", video);
        } else if (choice === "library") {
          librarySheetRef.current?.present();
        } else if (choice === "repo") {
          if (githubRepos.data && githubRepos.data.repos.length > 0) {
            setRepoChipShown(true);
            repoSheetRef.current?.present();
          } else if (githubRepos.data) onOpenConnectors();
          else repoSheetRef.current?.present();
        } else {
          const slots = MAX_DOCS_PER_TURN - countOf(attachments, "doc");
          (await pickDocuments(slots, (m) => skipped.push(m))).forEach((f) => stage("doc", f));
        }
        if (skipped.length > 0) alertAfterPicker("Some files were skipped", skipped.join("\n"));
      } catch (e) {
        if (e instanceof AccessDeniedError) {
          alertAfterPicker(e.title, e.message, [
            { text: "Not now", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => void Linking.openSettings().catch(() => {}),
            },
          ]);
          return;
        }
        if (e instanceof CameraUnavailableError) {
          alertAfterPicker("Camera not available", e.message);
          return;
        }
        alertAfterPicker(
          e instanceof ImageAttachError ? "Can't attach" : "Couldn't attach",
          (e as Error).message || "Something went wrong. Try again.",
        );
      } finally {
        setPicking(false);
      }
    },
    [attachments, stage, githubRepos.data],
  );

  function onPreviewSentVideo(video: SentVideo) {
    if (!sentVideoPlayable(video)) {
      Alert.alert("Video not on this phone", "This video was sent, but its copy is no longer on this device.");
      return;
    }
    if (!inAppVideoAvailable()) {
      Alert.alert("Video preview unavailable", "Update the app to preview videos.");
      return;
    }
    setPreview({ kind: "video", url: sentVideoUri(video), filename: video.name });
  }

  function onPreviewAttachment(a: Attachment) {
    if (a.kind === "doc") return;
    if (a.kind === "video" && !inAppVideoAvailable()) {
      Alert.alert("Video preview unavailable", "Update the app to preview videos. It will still send.");
      return;
    }
    setPreview({ kind: a.kind, url: a.previewUri, filename: a.name });
  }

  async function submit(
    text: string,
    paths: { images: string[]; videos: string[]; docs: string[] },
    restore: () => void,
    localVideo?: { uri: string; name: string },
    commandSlug?: string,
  ): Promise<boolean> {
    if (!consent.canSend()) {
      setShowConsentGate(true);
      restore();
      return false;
    }
    setHeldAnswer(null);
    if (resolvingTopic) {
      resolveToken.current += 1;
      setResolvingTopic(null);
    }
    try {
      const res = await send.mutateAsync({
        message: text,
        image_paths: paths.images.length ? paths.images : undefined,
        video_paths: paths.videos.length ? paths.videos : undefined,
        doc_paths: paths.docs.length ? paths.docs : undefined,
        command_slug: commandSlug,
        ...chatTopicFields(topic, slug),
      });
      if (localVideo) {
        rememberSentVideo.mutate({
          messageId: res.user_message_id,
          localUri: localVideo.uri,
          name: localVideo.name,
        });
      }
      const newThread = binding.kind !== "bound";
      track("chat_message_sent", { new_thread: newThread, edited: false });
      if (newThread) {
        setBinding({ kind: "bound", id: res.thread_id, slug, ...topic });
        qc.removeQueries({ queryKey: agentQueryKeys.history(tenant, slug, NEW_THREAD_SLOT) });
      }
      setThreadRun(res.thread_id, res.run_id);
      setCreditWall(null);
      setSendError(null);
      return true;
    } catch (e) {
      const wall = creditWallFromError(e);
      if (wall) {
        setCreditWall(wall);
        setUnsent((u) => [...u, { id: `unsent-${++unsentSeq}`, key: unsentKey, text, paths, localVideo, commandSlug }]);
      } else {
        restore();
        if ((e as { code?: unknown } | null)?.code === "not_chat_eligible") {
          setSendError(friendlyError(e, "This agent isn't available for chat."));
        }
        if (commandSlug && (e as { code?: unknown } | null)?.code === "invalid_command") {
          addSystemNote(
            `/${commandSlug} isn't available in this workspace. It may belong to another workspace.`,
          );
        }
      }
      return false;
    }
  }

  function onRetryUnsent(id: string) {
    const u = unsent.find((x) => x.id === id);
    if (!u || working || send.isPending) return;
    setUnsent((all) => all.filter((x) => x.id !== id));
    void submit(u.text, u.paths, () => setUnsent((all) => [...all, u]), u.localVideo, u.commandSlug);
  }

  function onRemoveUnsent(id: string) {
    setUnsent((all) => all.filter((x) => x.id !== id));
  }

  function onStop() {
    if (activeRunId) setConfirmingStopRunId(activeRunId);
  }

  function stopConfirmed() {
    const runId = confirmingStopRunId;
    setConfirmingStopRunId(null);
    if (!runId) return;
    setStopFailedRunId(null);
    setStoppingRunId(runId);
    cancelRun(runId)
      .then((r) => {
        track("chat_run_stopped");
        if (!r.cancelling) setStoppingRunId(null);
      })
      .catch(() => {
        setStoppingRunId(null);
        setStopFailedRunId(runId);
      });
  }

  function onSend() {
    const rawInput = draft.value;
    const parsed = parseSend(rawInput);
    const command = typedCommand;
    if (parsed.kind === "unknown_command" && !command) return;
    if (parsed.kind === "clear") {
      draft.clear();
      onNewChat();
      return;
    }
    if (parsed.kind === "help") {
      draft.clear();
      showShortcuts();
      return;
    }
    if (parsed.kind === "feedback") {
      void saveFeedback(parsed.body);
      return;
    }
    const typed = command ? command.body : (turnText(parsed) ?? "");
    const pickedMention = mention;
    const typedApproval =
      parsed.kind === "attach_decision"
        ? {
            id: parsed.decisionId,
            summary: approvalSummary(approvals?.find((d) => d.id === parsed.decisionId)?.body),
          }
        : null;
    const pickedApproval = approvalContext ?? typedApproval;
    const needsWords = emptyMentionHint(typed, pickedMention, pickedApproval);
    if (needsWords) {
      setMentionHint(needsWords);
      setComposerFocusKey((k) => k + 1);
      return;
    }
    const text =
      typed || pickedMention || pickedApproval ? composeMessage(typed, pickedMention, pickedApproval) : "";
    if (uploadsPending(attachments)) return;
    const paths = {
      images: readyPaths(attachments, "image"),
      videos: readyPaths(attachments, "video"),
      docs: readyPaths(attachments, "doc"),
    };
    if (!text && paths.images.length + paths.videos.length + paths.docs.length === 0) return;
    const staged = attachments;
    const video = attachments.find((a) => a.kind === "video" && a.status === "ready");
    draft.clear();
    setAttachments([]);
    setMention(null);
    setApprovalContext(null);
    void submit(
      text,
      paths,
      () => {
        draft.update(rawInput);
        setApprovalContext(approvalContext);
        setAttachments(staged);
        setMention(pickedMention);
      },
      video ? { uri: video.previewUri, name: video.name } : undefined,
      command?.slug,
    );
  }

  function addSystemNote(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `system-${++noteSeq}`;
    setNotes((all) => [...all, { id, key: unsentKey, text: trimmed }]);
    setTimeout(() => setNotes((all) => all.filter((n) => n.id !== id)), NOTE_TTL_MS);
  }

  function showShortcuts() {
    const lines = SLASH_COMMANDS.map((c) => `${c.command}${c.argHint ? ` ${c.argHint}` : ""} — ${c.description}`);
    const yours = ownList.map((c) => `/${c.slug} <message> — ${c.description || c.name}`);
    addSystemNote(
      `Available commands:\n${lines.join("\n")}${yours.length ? `\nYour commands:\n${yours.join("\n")}` : ""}\n@<channel> <message> — put this to a channel. The answer comes back here.`,
    );
  }

  const [savingFeedback, setSavingFeedback] = useState(false);
  async function saveFeedback(body: string) {
    if (savingFeedback) return;
    setSavingFeedback(true);
    draft.clear();
    try {
      const res = await submitFeedback(slug, body);
      addSystemNote(feedbackConfirmation(body, res.status));
      track("chat_feedback_given");
    } catch (e) {
      addSystemNote(`Rule not saved: ${friendlyError(e, "Could not save the rule.")}`);
    } finally {
      setSavingFeedback(false);
    }
  }

  function onPickSlash(c: SlashCommand) {
    if (c.kind === "decision") {
      draft.clear();
      Keyboard.dismiss();
      approvalPickerRef.current?.present();
      return;
    }
    draft.update(`${c.command} `);
    setComposerFocusKey((k) => k + 1);
  }

  function onPickTenantCommand(c: TenantCommand) {
    draft.update(`/${c.slug} `);
    setComposerFocusKey((k) => k + 1);
  }

  function onPickMention(c: MentionPick) {
    draft.update(stripMention(draft.value));
    setMention(c);
    setMentionHint(null);
    setComposerFocusKey((k) => k + 1);
  }

  async function onPickLibraryFile(file: Artifact) {
    if (attachingFileId) return;
    const full = libraryAttachBlock(
      file,
      { image: countOf(attachments, "image"), doc: countOf(attachments, "doc") },
      { image: MAX_IMAGES_PER_TURN, doc: MAX_DOCS_PER_TURN },
    );
    if (full) {
      librarySheetRef.current?.dismiss();
      addSystemNote(full);
      return;
    }
    setAttachingFileId(file.id);
    try {
      const res = await attachArtifact(file.id);
      const kind: AttachmentKind = res.kind === "image" ? "image" : "doc";
      const path = kind === "image" ? res.image_path : res.doc_path;
      if (!path) throw new Error(`Couldn't attach ${file.filename}.`);
      const cap = kind === "image" ? MAX_IMAGES_PER_TURN : MAX_DOCS_PER_TURN;
      if (countOf(attachments, kind) >= cap) {
        throw new ImageAttachError(
          kind === "image" ? `Max ${MAX_IMAGES_PER_TURN} images per message.` : `Max ${MAX_DOCS_PER_TURN} files per message.`,
        );
      }
      setAttachments((a) => [
        ...a,
        {
          id: `${Date.now()}-${file.id}`,
          kind,
          name: res.filename ?? file.filename,
          previewUri: kind === "image" ? file.preview_url ?? "" : "",
          mime: file.mime,
          status: "ready",
          path,
        },
      ]);
      librarySheetRef.current?.dismiss();
    } catch (e) {
      librarySheetRef.current?.dismiss();
      addSystemNote(friendlyError(e, `Couldn't attach ${file.filename}.`));
    } finally {
      setAttachingFileId(null);
    }
  }

  function onCancelEdit() {
    if (!editing) return;
    draft.update(editing.prevDraft);
    setEditing(null);
    setSendError(null);
  }

  async function onSendEdit() {
    if (!editing || !boundId || send.isPending) return;
    const text = draft.value.trim();
    if (!text) return;
    if (!consent.canSend()) {
      setShowConsentGate(true);
      return;
    }
    const { messageId, prevDraft } = editing;
    const hide = rowsFromMessage(messages, messageId);
    const runBefore = activeRunId;
    setHeldAnswer(null);
    setHiddenIds((h) => [...h, ...hide]);
    setThreadRun(boundId, null);
    setEditing(null);
    setSendError(null);
    draft.clear();
    try {
      const res = await send.mutateAsync({ message: text, edit_of_message_id: messageId });
      track("chat_message_sent", { new_thread: false, edited: true });
      setThreadRun(boundId, res.run_id);
      setCreditWall(null);
    } catch (e) {
      setHiddenIds((h) => h.filter((id) => !hide.includes(id)));
      setThreadRun(boundId, runBefore);
      draft.update(text);
      const wall = creditWallFromError(e);
      if (wall) {
        setCreditWall(wall);
        setEditing({ messageId, prevDraft });
      } else if ((e as { code?: unknown } | null)?.code === "invalid_edit_message") {
        setSendError(friendlyError(e, "This message can no longer be edited."));
      } else {
        setEditing({ messageId, prevDraft });
        setSendError(friendlyError(e, "Couldn't send your edit. Try again."));
      }
    }
  }

  async function onGoDeeperConfirmed() {
    const target = confirmDeeper;
    setConfirmDeeper(null);
    if (!target || deeper?.busy) return;
    if (!consent.canSend()) {
      setShowConsentGate(true);
      return;
    }
    const deeperSlug = slug;
    setDeeper({ messageId: target.messageId, busy: true, failure: null });
    try {
      const deeperTopic = topic;
      const res = await sendChat(deeperSlug, {
        message: target.prompt,
        thread_id: null,
        depth: "deep",
        ...chatTopicFields(deeperTopic, deeperSlug),
      });
      void qc.invalidateQueries({ queryKey: agentQueryKeys.threads(tenant, deeperSlug) });
      setDeeper(null);
      onSelectThread(res.thread_id, deeperSlug, deeperTopic);
      setThreadRun(res.thread_id, res.run_id, deeperSlug);
    } catch (e) {
      setDeeper({ messageId: target.messageId, busy: false, failure: e });
    }
  }

  function onPickPrompt(prompt: string) {
    if (send.isPending) return;
    void submit(prompt, { images: [], videos: [], docs: [] }, () => draft.update(prompt));
  }

  const cardStartingRef = useRef(false);
  const [cardStarting, setCardStarting] = useState(false);
  const cardActions = {
    threadId: boundId,
    busy: working || cardStarting,
    claimRun: () => {
      if (working || cardStartingRef.current || send.isPending) return false;
      if (!consent.canSend()) {
        setShowConsentGate(true);
        return false;
      }
      cardStartingRef.current = true;
      setCardStarting(true);
      return true;
    },
    releaseRun: () => {
      cardStartingRef.current = false;
      setCardStarting(false);
    },
    onQuickReply: async (text: string) => {
      if (working || cardStartingRef.current || send.isPending) return false;
      const hadDraft = draft.value.trim().length > 0;
      return submit(text, { images: [], videos: [], docs: [] }, () => {
        if (hadDraft) Alert.alert("Couldn't send", `"${text}" didn't go through. Try again.`);
        else draft.update(text);
      });
    },
    onRunStarted: (runId: string) => setThreadRun(slot, runId),
    onPrefill: (text: string, hint?: string) => {
      if (text && !draft.value.trim()) draft.update(text);
      if (hint) setPlaceholderHint(hint);
      setComposerFocusKey((k) => k + 1);
    },
  };

  function onComposerChange(text: string) {
    if (placeholderHint) setPlaceholderHint(null);
    if (mentionHint) setMentionHint(null);
    if (text === "/" && tenantCommands.failed) tenantCommands.refresh();
    draft.update(text);
  }

  function resetEdit() {
    if (editing) draft.update(editing.prevDraft);
    setEditing(null);
    setHiddenIds([]);
  }

  function onSelectThread(id: string, threadSlug: string, threadTopic: ChatTopicRef = {}) {
    setDrawerOpen(false);
    setLinkingThreadId(null);
    setResolvingTopic(null);
    const nextTopic = carriesTopic(threadSlug) ? threadTopic : {};
    if (id !== boundId || threadSlug !== slug) {
      resetEdit();
      setBinding({ kind: "bound", id, slug: threadSlug, ...nextTopic });
      setCreditWall(null);
      setSendError(null);
      setAttachments([]);
      setPlaceholderHint(null);
    }
  }

  function onNewChat() {
    track("chat_new_started");
    if (topic.channel) startNewChat(channelAgentSlug(topic.channel), { channel: topic.channel });
    else startNewChat(OPERATOR_SLUG);
  }

  function onPickTopic(picked: ChatTopic) {
    if (picked.channel) {
      startNewChat(channelAgentSlug(picked.channel), { channel: picked.channel });
      setResolvingTopic({ channel: picked.channel });
      return;
    }
    startNewChat(picked.slug);
  }

  function startNewChat(nextSlug: string, nextTopic: ChatTopicRef = {}) {
    setVoiceResetCount((count) => count + 1);
    setDrawerOpen(false);
    setLinkingThreadId(null);
    setResolvingTopic(null);
    resetEdit();
    qc.removeQueries({ queryKey: agentQueryKeys.history(tenant, nextSlug, NEW_THREAD_SLOT) });
    setBinding({ kind: "new", slug: nextSlug, ...(carriesTopic(nextSlug) ? nextTopic : {}) });
    setCreditWall(null);
    setSendError(null);
    setUnsent((all) => all.filter((u) => u.key !== `${tenant}:${nextSlug}:${NEW_THREAD_SLOT}`));
    setAttachments([]);
    setMention(null);
    setApprovalContext(null);
    setRepoChipShown(false);
    setPlaceholderHint(null);
  }

  const { startAddWorkspace } = useOnboarding();

  const threadTitle =
    (boundId ? threadRows?.find((t) => t.id === boundId)?.title?.trim() : "") || "Untitled chat";
  const copyMenuHeight =
    (copyMenu?.time ? COPY_MENU_TIME_HEIGHT : 0) +
    COPY_MENU_ROW_HEIGHT * (copyMenu?.editId ? 2 : 1) +
    COPY_MENU_PADDING * 2;

  function onAddWorkspace() {
    setDrawerOpen(false);
    startAddWorkspace();
    router.push("/(onboarding)/website");
  }

  function onOpenSettings() {
    setDrawerOpen(false);
    router.push("/settings");
  }

  function onOpenArtifacts() {
    setDrawerOpen(false);
    router.push("/artifacts");
  }

  function onOpenChannels() {
    setDrawerOpen(false);
    router.push("/channels");
  }

  function onOpenGrowth() {
    setDrawerOpen(false);
    router.push("/growth");
  }

  function onOpenAnalytics() {
    setDrawerOpen(false);
    router.push("/analytics");
  }

  function onOpenMessaging() {
    setDrawerOpen(false);
    router.push("/messaging");
  }

  function onOpenConnectors() {
    setDrawerOpen(false);
    router.push("/toolkit");
  }

  function onOpenAgentBuilder() {
    setDrawerOpen(false);
    router.push("/agents");
  }

  function onOpenBuild() {
    setDrawerOpen(false);
    router.push("/build");
  }

  function onOpenSearch() {
    setDrawerOpen(false);
    router.push("/search");
  }

  return (
    <LinkCopiedContext.Provider value={showCopyToast}>
    <View style={styles.safe}>
      <SafeAreaView style={[styles.flex, { paddingTop: steadyTop }]} edges={["bottom", "left", "right"]}>
        <KeyboardAvoider style={styles.flex}>
          {isLoading || linkingThreadId ? (
            <ChatSkeleton paddingTop={HEADER_HEIGHT + space.md} />
          ) : (
            <View style={styles.listWrap}>
              <FlatList
                ref={listRef}
                data={listData}
                keyExtractor={(m) => m.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={[styles.list, { paddingTop: HEADER_HEIGHT + 20 }]}
                scrollIndicatorInsets={{ top: HEADER_HEIGHT }}
                onScroll={onScroll}
                onContentSizeChange={(_w, h) => {
                  listMetrics.current.contentHeight = h;
                  if (atBottom) listRef.current?.scrollToEnd({ animated: false });
                  else if (measureAtBottom()) setAtBottom(true);
                }}
                onLayout={(e) => {
                  listMetrics.current.listHeight = e.nativeEvent.layout.height;
                  if (!atBottom && measureAtBottom()) setAtBottom(true);
                }}
                scrollEventThrottle={64}
                renderItem={({ item, index }) =>
                  item.id.startsWith("unsent-") ? (
                    <View>
                      <ChatBubble message={item} onRequestCopy={onRequestCopy} />
                      <View style={styles.unsentRow}>
                        <Text style={styles.unsentText}>Not sent</Text>
                        <Pressable onPress={() => onRetryUnsent(item.id)} hitSlop={8} accessibilityRole="button">
                          <Text style={styles.unsentAction}>Retry</Text>
                        </Pressable>
                        <Pressable onPress={() => onRemoveUnsent(item.id)} hitSlop={8} accessibilityRole="button">
                          <Text style={styles.unsentAction}>Remove</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <ChatBubble
                      message={item}
                      threadSlug={slug}
                      isLast={index === messages.length - 1}
                      cardActions={cardActions}
                      onPreviewImage={(url, filename) => setPreview({ kind: "image", url, filename })}
                      sentVideo={sentVideos?.[item.id]}
                      onPreviewVideo={onPreviewSentVideo}
                      artifacts={
                        item.agent_run_id ? artifactsByRun?.get(item.agent_run_id) : undefined
                      }
                      onRequestCopy={(body, position) => onRequestCopy(body, position, item.id)}
                      footer={
                        deeperPrompts.has(item.id) ? (
                          <GoDeeperButton
                            busy={deeper?.messageId === item.id && deeper.busy}
                            failure={deeper?.messageId === item.id ? deeper.failure : null}
                            onPress={() =>
                              setConfirmDeeper({ messageId: item.id, prompt: deeperPrompts.get(item.id) ?? "" })
                            }
                          />
                        ) : undefined
                      }
                    />
                  )
                }
                ListEmptyComponent={
                  <EmptyChat
                    name={greetingName(session)}
                    company={companyName}
                    channel={topic.channel ? headerTitle : null}
                    onPick={carriesTopic(slug) ? onPickPrompt : undefined}
                  />
                }
                ListFooterComponent={
                  <View>
                    {inlineApprovals.length > 0 ? (
                      <View style={styles.approvals}>
                        {inlineApprovals.map((d) => (
                          <ApprovalCard key={d.id} decision={d} variant="inline" />
                        ))}
                      </View>
                    ) : null}
                    {working || send.isPending ? (
                      <RunProgress status={run?.status} panel={livePanel} stopping={stopping} />
                    ) : null}
                    {draftSplit.answer ? (
                      <StreamDraftBubble text={draftSplit.answer} />
                    ) : heldAnswer && heldAnswer.slot === slot && !heldReplied ? (
                      <StreamDraftBubble text={heldAnswer.text} />
                    ) : null}
                  </View>
                }
              />
              {!atBottom && messages.length > 0 ? (
                <View style={styles.scrollDownWrap} pointerEvents="box-none">
                  <Pressable
                    style={styles.scrollDown}
                    onPress={() => listRef.current?.scrollToEnd({ animated: true })}
                    accessibilityLabel="Scroll to latest"
                  >
                    <Text style={styles.scrollDownText}>↓</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )}

          {creditWall ? (
            <CreditWallNotice wall={creditWall} onDismiss={() => setCreditWall(null)} />
          ) : null}
          {stopFailed ? (
            <Text style={styles.inlineError} accessibilityRole="alert">
              Couldn't stop, try again
            </Text>
          ) : null}
          {sendError ? (
            <Text style={styles.inlineError} accessibilityRole="alert">
              {sendError}
            </Text>
          ) : null}
          {consent.needsGate && !showConsentGate ? (
            <Pressable
              style={styles.consentBanner}
              onPress={() => setShowConsentGate(true)}
              accessibilityRole="button"
            >
              <Text style={styles.consentBannerText}>Turn on AI to send messages</Text>
            </Pressable>
          ) : null}
          {editing ? (
            <View style={styles.editBar}>
              <Icon name="edit" size={14} color={colors.muted} />
              <Text style={styles.editBarText} numberOfLines={1}>
                Editing your message. Sending replaces the reply.
              </Text>
              <Pressable onPress={onCancelEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel edit">
                <Icon name="close" size={16} color={colors.ink} strokeWidth={2} />
              </Pressable>
            </View>
          ) : null}
          <Composer
            voiceScopeKey={`${tenant}:${slot}:${voiceResetCount}`}
            voiceEnabled={isFocused && !drawerOpen && draft.hydrated}
            value={draft.value}
            onChangeText={onComposerChange}
            onSend={editing ? () => void onSendEdit() : onSend}
            sending={send.isPending}
            placeholder={
              approvalContext
                ? "Ask about this approval…"
                : placeholderHint ?? `Message ${answererName}… type / or @`
            }
            focusKey={composerFocusKey}
            menu={composerMenu}
            blocked={typedParse.kind === "unknown_command" && !typedCommand}
            contextChips={[
              ...(approvalContext
                ? [
                    {
                      key: "approval",
                      label: approvalContext.summary,
                      icon: <Icon name="check" size={14} color={colors.amber} />,
                      tone: "approval" as const,
                      sendable: true,
                      onPress: () => approvalPickerRef.current?.present(),
                      onRemove: () => setApprovalContext(null),
                    },
                  ]
                : []),
              ...(repoLabel
                ? [
                    {
                      key: "repo",
                      label: repoLabel,
                      icon: <ConnectorTile slug="github" label="GitHub" size={18} />,
                      onPress: () => {
                        Keyboard.dismiss();
                        repoSheetRef.current?.present();
                      },
                      onRemove: () => setRepoChipShown(false),
                    },
                  ]
                : []),
              ...(mention
                ? [
                    {
                      key: "mention",
                      label: mention.name,
                      icon: <ChannelLogo slug={mention.slug} size={18} />,
                      onRemove: () => {
                        setMention(null);
                        setMentionHint(null);
                      },
                    },
                  ]
                : []),
            ]}
            attachments={editing ? [] : attachments}
            onAttach={editing ? undefined : () => attachSheetRef.current?.present()}
            onPreviewAttachment={(a) =>
              a.status === "error" ? onFailedAttachment(a) : onPreviewAttachment(a)
            }
            onRemoveAttachment={(id) => setAttachments((a) => a.filter((x) => x.id !== id))}
            attaching={picking}
            uploading={!editing && uploadsPending(attachments)}
            working={working && !editing}
            stopping={stopping}
            onStop={onStop}
          />
        </KeyboardAvoider>
      </SafeAreaView>

      <View
        style={[styles.headerOverlay, { top: steadyTop }]}
        pointerEvents="box-none"
      >
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
          <Defs>
            <LinearGradient id="chatHeaderFade" x1="0%" y1="0%" x2="0%" y2="100%">
              {}
              <Stop offset="0" stopColor={colors.bg} stopOpacity={0.92} />
              <Stop offset="0.35" stopColor={colors.bg} stopOpacity={0.7} />
              <Stop offset="0.7" stopColor={colors.bg} stopOpacity={0.3} />
              <Stop offset="1" stopColor={colors.bg} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#chatHeaderFade)" />
        </Svg>
        <View
          style={[
            styles.header,
            { paddingLeft: insets.left + space.sm, paddingRight: insets.right + space.sm },
          ]}
          pointerEvents="box-none"
        >
          {}
          {backParam === "1" && router.canGoBack() ? (
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                router.back();
              }}
              hitSlop={10}
              style={styles.iconBtnOutlined}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <BackIcon />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                setDrawerOpen(true);
              }}
              hitSlop={10}
              style={styles.iconBtnOutlined}
              accessibilityLabel="Open menu"
            >
              <Icon name="hamburger" size={20} strokeWidth={2} />
            </Pressable>
          )}
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              agentPickerRef.current?.present();
            }}
            hitSlop={6}
            style={({ pressed }) => [styles.agentTitle, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Talking about ${headerTitle}. Change topic`}
          >
            {topic.channel ? <ChannelLogo slug={topic.channel} size={18} /> : null}
            <Text style={styles.agentTitleText} numberOfLines={1}>
              {headerTitle}
            </Text>
            <Icon name="chevronDown" size={16} color={colors.muted} strokeWidth={2} />
          </Pressable>
          <View style={[styles.headerRight, APPROVALS_ENTRY_ENABLED && pendingCount > 0 && styles.headerRightWithPill]}>
            {APPROVALS_ENTRY_ENABLED && pendingCount > 0 ? (
              <Pressable
                onPress={() => approvalsRef.current?.present()}
                hitSlop={6}
                style={({ pressed }) => [styles.approvePill, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Approvals, ${pendingCount} waiting for you`}
              >
                <View style={styles.approveBadge}>
                  <Text style={styles.approveBadgeText}>{pendingCount}</Text>
                </View>
                <Text style={styles.approveText}>to approve</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onNewChat}
              hitSlop={10}
              style={styles.iconBtn}
              accessibilityLabel="New chat"
            >
              <Icon name="compose" size={20} strokeWidth={2} />
            </Pressable>
            {}
            {boundId ? (
              <Pressable
                onPress={() => {
                  Keyboard.dismiss();
                  threadActionsRef.current?.present();
                }}
                hitSlop={10}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel="Chat options"
              >
                <Icon name="dots" size={20} strokeWidth={2} />
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      {copyToast}

      {copyMenu ? (
        <>
          {}
          <Pressable
            style={[StyleSheet.absoluteFill, styles.copyMenuScrim]}
            onPress={() => setCopyMenu(null)}
            accessibilityLabel="Dismiss"
          />
          <View
            style={[
              styles.copyMenu,
              {
                width: COPY_MENU_WIDTH,
                left: Math.min(
                  Math.max(copyMenu.x - COPY_MENU_WIDTH / 2, space.lg),
                  winWidth - space.lg - COPY_MENU_WIDTH,
                ),
                top:
                  copyMenu.y - COPY_MENU_GAP - copyMenuHeight > steadyTop + HEADER_HEIGHT
                    ? copyMenu.y - COPY_MENU_GAP - copyMenuHeight
                    : copyMenu.y + COPY_MENU_GAP,
              },
            ]}
          >
            {copyMenu.time ? (
              <Text style={styles.copyMenuTime} numberOfLines={1}>
                {copyMenu.time}
              </Text>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.copyMenuItem, pressed && styles.copyMenuItemPressed]}
              onPress={onCopyMenuConfirm}
              accessibilityRole="button"
              accessibilityLabel="Copy"
            >
              <Icon name="copy" size={18} color={colors.ink} />
              <Text style={styles.copyMenuText}>Copy</Text>
            </Pressable>
            {copyMenu.editId ? (
              <Pressable
                style={({ pressed }) => [styles.copyMenuItem, pressed && styles.copyMenuItemPressed]}
                onPress={onEditMenuConfirm}
                accessibilityRole="button"
                accessibilityLabel="Edit message"
              >
                <Icon name="edit" size={18} color={colors.ink} />
                <Text style={styles.copyMenuText}>Edit message</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}

      <AttachSheet
        ref={attachSheetRef}
        onChoose={(choice) => void onAttachChoice(choice)}
        disabled={{
          photos: countOf(attachments, "image") >= MAX_IMAGES_PER_TURN,
          camera: countOf(attachments, "image") >= MAX_IMAGES_PER_TURN,
          video: countOf(attachments, "video") >= MAX_VIDEOS_PER_TURN,
          files: countOf(attachments, "doc") >= MAX_DOCS_PER_TURN,
          library:
            countOf(attachments, "image") >= MAX_IMAGES_PER_TURN && countOf(attachments, "doc") >= MAX_DOCS_PER_TURN,
        }}
        hidden={{ repo: !repoMenuEnabled }}
        hints={{
          repo: githubRepos.isLoading
            ? "Loading…"
            : githubRepos.isError
              ? "Couldn't load repos"
              : !githubRepos.data?.connected
                ? "Not connected"
                : githubRepos.data.default ?? "No repo selected",
        }}
      />
      <ApprovalPickerSheet
        ref={approvalPickerRef}
        onPick={(d, summary) => {
          setApprovalContext({ id: d.id, summary });
          setComposerFocusKey((k) => k + 1);
        }}
      />
      <RepoSheet
        ref={repoSheetRef}
        onManage={onOpenConnectors}
        onPicked={() => setRepoChipShown(true)}
      />
      <LibraryFileSheet ref={librarySheetRef} busyId={attachingFileId} onPick={(f) => void onPickLibraryFile(f)} />


      <MediaViewer item={preview} onClose={() => setPreview(null)} />
      <ConfirmDialog
        visible={confirmingStopRunId !== null}
        icon="alertCircle"
        title="Stop this run?"
        message="Zavi will stop working on this reply."
        cancelLabel="Keep going"
        confirmLabel="Stop"
        destructive
        onCancel={() => setConfirmingStopRunId(null)}
        onConfirm={stopConfirmed}
      />
      <ConfirmDialog
        visible={confirmDeeper !== null}
        icon="search"
        title="Go deeper?"
        message="Research answers again with a stronger model, in a new chat. It uses more credits than this quick answer."
        cancelLabel="Cancel"
        confirmLabel="Go deeper"
        onCancel={() => setConfirmDeeper(null)}
        onConfirm={() => void onGoDeeperConfirmed()}
      />

      <ThreadActionsSheet
        ref={threadActionsRef}
        slug={slug}
        threadId={boundId}
        title={threadTitle}
        onDeleted={onNewChat}
      />

      <AgentPickerSheet ref={agentPickerRef} current={{ slug, channel: topic.channel }} onPick={onPickTopic} />

      <ThreadDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentThreadId={boundId}
        onSelectThread={(row) =>
          onSelectThread(row.id, row.slug, {
            channel: row.channel_slug ?? agentChannel(row.slug),
            action: row.channel_slug ? row.channel_action_id ?? undefined : undefined,
          })
        }
        onSelectBuild={(id) => {
          setDrawerOpen(false);
          router.push({ pathname: "/build/[id]", params: { id } });
        }}
        onNewChat={onNewChat}
        onOpenSettings={onOpenSettings}
        onOpenSearch={onOpenSearch}
        onAddWorkspace={onAddWorkspace}
        onOpenArtifacts={onOpenArtifacts}
        onOpenChannels={onOpenChannels}
        onOpenConnectors={onOpenConnectors}
        onOpenGrowth={onOpenGrowth}
        onOpenAnalytics={onOpenAnalytics}
        onOpenMessaging={onOpenMessaging}
        onOpenBuild={onOpenBuild}
        onOpenAgentBuilder={onOpenAgentBuilder}
        onOpenApprovals={
          APPROVALS_ENTRY_ENABLED
            ? () => {
                setDrawerOpen(false);
                approvalsRef.current?.present();
              }
            : undefined
        }
        pendingApprovals={pendingCount}
      />
      <ApprovalsSheet ref={approvalsRef} />

      {}
      {showConsentGate ? (
        <SafeAreaView style={styles.consentModal} edges={["top", "bottom", "left", "right"]}>
          <AiConsentGate
            onAgree={() => {
              consent.agree();
              setShowConsentGate(false);
            }}
            onDecline={() => {
              consent.decline();
              setShowConsentGate(false);
            }}
          />
        </SafeAreaView>
      ) : null}
    </View>
    </LinkCopiedContext.Provider>
  );
}

function greetingName(session: Session | null): string {
  const full = session?.user?.user_metadata?.full_name;
  if (typeof full === "string" && full.trim()) return full.trim().split(/\s+/)[0];
  const local = session?.user?.email?.split("@")[0];
  if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  return "there";
}

const STARTING_PROMPTS: { label: string; prompt: string; icon: IconName; accent: keyof Colors["accent"] }[] = [
  { label: "What needs attention", prompt: "What needs my attention right now?", icon: "alertCircle", accent: "rose" },
  { label: "30-day marketing plan", prompt: "What's my 30 day marketing strategy?", icon: "calendarList", accent: "blue" },
  {
    label: "Find my target customer",
    prompt: "Who's my target customer and what pain points should I lead with?",
    icon: "target",
    accent: "pink",
  },
  {
    label: "Size up a competitor",
    prompt: "Pick my closest competitor and tell me where they beat me",
    icon: "swords",
    accent: "orange",
  },
  {
    label: "Grow organic traffic",
    prompt: "How can we grow our organic traffic in the next 90 days?",
    icon: "sprout",
    accent: "green",
  },
  { label: "Design social posts", prompt: "Design a set of Instagram posts for my product", icon: "image", accent: "fuchsia" },
  { label: "Make a deck", prompt: "Make me a short deck that explains what we do", icon: "presentation", accent: "sky" },
];

const PROMPT_ROWS = [STARTING_PROMPTS.slice(0, 4), STARTING_PROMPTS.slice(4)];

function EmptyChat({
  name,
  company,
  channel = null,
  onPick,
}: {
  name: string;
  company: string | null;
  channel?: string | null;
  onPick?: (text: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return (
    <View style={styles.empty}>
      <View style={styles.mascot}>
        <ZaviGlance size={120} />
      </View>
      <Text style={styles.greeting}>{`Good ${part}, ${name}.`}</Text>
      <Text style={styles.greetingSub}>
        {channel
          ? `What do you want to know about ${channel}?`
          : company
            ? `What should we grow at ${company} today?`
            : "What should we grow today?"}
      </Text>
      {onPick && !channel ? <StrategyProgressCard /> : null}
      {onPick && channel ? (
        <View style={styles.channelStarters}>
          {channelStarters(channel).map((prompt) => (
            <Pressable
              key={prompt}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              onPress={() => onPick(prompt)}
              accessibilityRole="button"
              accessibilityLabel={prompt}
            >
              <Text style={styles.chipText}>{prompt}</Text>
            </Pressable>
          ))}
        </View>
      ) : onPick ? (
        <View style={styles.chips}>
          {PROMPT_ROWS.map((row, r) => (
            <AutoScrollRow key={r} gap={7} inset={space.lg}>
              {row.map((c) => (
                <Pressable
                  key={c.label}
                  style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                  onPress={() => onPick(c.prompt)}
                  accessibilityRole="button"
                  accessibilityLabel={c.prompt}
                >
                  <Icon name={c.icon} size={14} color={colors.accent[c.accent]} strokeWidth={2.2} />
                  <Text style={styles.chipText}>{c.label}</Text>
                </Pressable>
              ))}
            </AutoScrollRow>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  slashHint: {
    paddingHorizontal: space.lg + space.xs,
    paddingTop: space.xs,
    fontSize: font.size.sm,
    fontFamily: font.family.regular,
    color: colors.muted,
  },
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  headerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingBottom: space.xl * 1.5,
  },
  copyMenu: {
    position: "absolute",
    paddingVertical: COPY_MENU_PADDING,
    borderRadius: 18,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderRaised,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 8,
  },
  copyMenuItem: {
    height: COPY_MENU_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  copyMenuItemPressed: { backgroundColor: colors.soft },
  copyMenuScrim: { backgroundColor: colors.scrim },
  copyMenuTime: {
    paddingVertical: (COPY_MENU_TIME_HEIGHT - 18) / 2,
    paddingHorizontal: space.lg,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.muted,
  },
  copyMenuText: {
    fontFamily: font.family.medium,
    fontSize: 14,
    includeFontPadding: false,
    color: colors.ink,
  },
  header: {
    minHeight: HEADER_HEIGHT,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
  },
  headerRightWithPill: { paddingLeft: space.xs },
  agentTitle: {
    flexShrink: 1,
    minWidth: 0,
    marginRight: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 38,
    paddingHorizontal: space.md,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
  },
  agentTitleText: {
    flexShrink: 1,
    fontFamily: font.family.semi,
    fontSize: font.size.base,
    includeFontPadding: false,
    color: colors.ink,
  },
  iconBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  iconBtnOutlined: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.panel2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  approvePill: {
    height: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.approvalBg,
  },
  approveBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.amberFill,
    alignItems: "center",
    justifyContent: "center",
  },
  approveBadgeText: { fontFamily: font.family.extra, fontSize: 11, color: colors.onAccent, includeFontPadding: false },
  approveText: { fontFamily: font.family.semi, fontSize: 12.5, color: colors.amber, includeFontPadding: false },
  pressed: { opacity: 0.7 },
  listWrap: { flex: 1 },
  list: { paddingHorizontal: space.lg, paddingVertical: 20, flexGrow: 1 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: space.xl,
    paddingBottom: 96,
  },
  mascot: { marginBottom: 0 },
  greeting: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: 22,
    lineHeight: 33,
    letterSpacing: -0.5,
    color: colors.ink,
    textAlign: "center",
  },
  greetingSub: {
    marginTop: 8,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    textAlign: "center",
  },
  chips: {
    alignSelf: "stretch",
    marginHorizontal: -space.lg,
    gap: 7,
    marginTop: 20,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    backgroundColor: colors.bg,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  chipPressed: { backgroundColor: colors.soft },
  channelStarters: { alignItems: "center", gap: 8, marginTop: 20 },
  chipText: {
    includeFontPadding: false,
    fontFamily: font.family.medium,
    fontSize: 12.5,
    color: colors.ink,
  },
  scrollDownWrap: { position: "absolute", left: 0, right: 0, bottom: space.md, alignItems: "center" },
  scrollDown: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel2,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollDownText: { fontSize: font.size.lg, color: colors.ink, lineHeight: 19 },
  approvals: { gap: space.sm, paddingTop: space.sm },
  unsentRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space.md,
    marginTop: -space.xs,
    marginBottom: space.sm,
  },
  unsentText: { fontFamily: font.family.regular, fontSize: font.size.sm, color: colors.red, includeFontPadding: false },
  unsentAction: { fontFamily: font.family.semi, fontSize: font.size.sm, color: colors.ink, includeFontPadding: false },
  editBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
  },
  editBarText: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: colors.muted,
  },
  inlineError: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    color: colors.red,
    includeFontPadding: false,
    fontFamily: font.family.regular,
    fontSize: font.size.sm,
  },
  consentBanner: {
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
    alignItems: "center",
  },
  consentBannerText: {
    includeFontPadding: false,
    fontFamily: font.family.semi,
    fontSize: font.size.sm,
    color: colors.ink,
  },
  consentModal: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg },
});

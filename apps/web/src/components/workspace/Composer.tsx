"use client";

import { isPlanUpgradeRefusal, planUpgradeMessage } from "@/lib/workspace/planUpgrade";
import { wallBillingTarget } from "@/lib/workspace/openBilling";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import {
  useAgentRun,
  type ChatSendResult,
  type ChatSendError,
} from "@/lib/workspace/useAgentRun";
import { parseInput } from "@/lib/workspace/slashCommands";
import { splitChannelMention } from "@/lib/workspace/channelMention";
import { isBargeInEnabled } from "@/lib/workspace/bargeInFlag";
import {
  filterCommands,
  SLASH_COMMANDS,
  type SlashCommand,
} from "@/lib/workspace/slashCommandRegistry";
import {
  useTenantCommands,
  filterTenantCommands,
  matchTenantInvocation,
  tenantCommandHint,
  toSlashEntry,
  type TenantSlashEntry,
} from "@/lib/workspace/tenantCommands";
import { feedbackConfirmation, submitFeedback } from "@/lib/workspace/useFeedback";
import { apiFetch } from "@/lib/api";
import { ChatImageThumb } from "./ChatImageThumb";
import { uploadErrorMessage } from "@/lib/workspace/uploadErrorMessage";
import { normalizeAttachmentFile } from "@/lib/workspace/attachmentType";
import { agentDisplayName, GROWTH_OFFICER_SLUG } from "@/lib/agentRegistry";
import { primeChatImageUrl } from "./ChatImageThumb";
import { SlashMenu, type SlashSelection } from "./SlashMenu";
import { MentionMenu, MentionTargetIcon, useConnectedSlugs } from "./MentionMenu";
import {
  channelOnlySections,
  channelTarget,
  flattenSections,
  homeMentionSections,
  matchHomeAgentMention,
  readRecentMentions,
  recentStorageKey,
  rememberRecentMention,
  teamFromTree,
  type MentionTarget,
} from "./composer/mentionTargets";
import { customAgentRows } from "./layout/agentPages";
import {
  getActiveComposerMention,
  removeActiveComposerMention,
  replaceActiveComposerMention,
  shouldShowComposerHint,
} from "./composerMention";
import {
  MentionComposerInput,
  type MentionComposerInputHandle,
} from "./composer/MentionComposerInput";
import { handleTextareaPaste } from "./composer/paste";
import { matchChannelMention } from "@zavi/shared";
import { ModeComposer, SendCircle } from "./ModeComposer";
import { useWorkspace } from "./WorkspaceShell";
import { notifyThreadsChanged } from "./useAgentThreads";
import { RepoChip } from "./RepoChip";
import { cn as cx } from "@/lib/cn";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { MicButton } from "@/components/voice/MicButton";
import { AtSign, RotateCw } from "lucide-react";
import { appendDictatedText } from "@/lib/voice/useDictation";
import {
  shouldBlockSend,
  shouldTransparentlyHealThread,
  resolveSeedDrain,
  sendFailureInputPolicy,
  mayReplaceWithSeed,
} from "./composerGuards";
import { cannedQuestionsFor } from "@/lib/workspace/cannedQuestions";
import { claimComposerSeed } from "@/lib/workspace/composerSeedGuard";
import { appendFileRefs, mergeFileRefs, sameFileRefs, splitFileRefs, type FileRef } from "@/lib/workspace/fileRefs";
import { FileRefChips } from "./FileRefChips";
import { isMember, isViewer } from "@/lib/members";
import { notifyWorkspaceFilesChanged } from "@/lib/workspace/useWorkspaceFiles";
import { reportTrouble, useServiceHealth } from "@/lib/serviceHealth";
import { HOME_SCOPE, ownGithubRepo, repoHintFor, resolveRepoChip, type RepoChipScope } from "@/lib/workspace/siteRepoChip";
import { readGithubRepos } from "@/lib/workspace/useGithubRepos";
import { readBuildSessions } from "@/lib/workspace/useBuildSessions";
import { pageOriginExtras } from "@/lib/workspace/chatSendBody";

const ZAVI_COMPOSER_HINTS = [
  "Ask Zavi what's holding your growth back",
  "Type @ to bring a channel into the chat",
  "Plan my next month of marketing",
  "Type / to see what Zavi can run",
  "Which channel deserves my next dollar?",
  "Switch to Build to ship a landing page",
];

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 4;

const ALLOWED_DOC_EXTS = new Set(["pdf", "docx", "csv", "txt", "md", "markdown"]);
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCS_PER_TURN = 4;

export type ExternalStopControl = {
  ariaLabel: string;
  stopping?: boolean;
  allowSend?: boolean;
  onStop: () => Promise<string | null>;
};

export type ExternalRetryControl = {
  ariaLabel: string;
  retrying?: boolean;
  onRetry: () => Promise<void>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ComposerMentionState = {
  selected: { target: MentionTarget; position: number } | null;
  caret: number | null;
};

type ComposerMentionAction =
  | { type: "select"; target: MentionTarget; position: number }
  | { type: "position"; position: number }
  | { type: "caret"; caret: number }
  | { type: "clear"; caret?: number };

function composerMentionReducer(
  state: ComposerMentionState,
  action: ComposerMentionAction,
): ComposerMentionState {
  if (action.type === "select") {
    return {
      selected: { target: action.target, position: action.position },
      caret: null,
    };
  }
  if (action.type === "position") {
    return {
      ...state,
      selected: state.selected
        ? { ...state.selected, position: action.position }
        : null,
    };
  }
  if (action.type === "caret") return { ...state, caret: action.caret };
  return { selected: null, caret: action.caret ?? state.caret };
}

const ALLOWED_VIDEO_MIMES = new Set(["video/mp4"]);
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEOS_PER_TURN = 1;

const consumedDrops = new WeakSet<object>();

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export type ComposerDraft = {
  text: string;
  inFlight: Promise<unknown> | null;
  restore:
    | ((text: string, attachments?: Attachment[], showRetryBanner?: boolean) => void)
    | null;
  boundThread: { current: string | null };
  queuedSends: { current: QueuedSend[] };
};

export type QueuedSend = { text: string; optId: string | undefined; consumed: boolean };

function joinRestoredTexts(parts: string[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  return kept.join("\n");
}

export function createComposerDraft(): ComposerDraft {
  return {
    text: "",
    inFlight: null,
    restore: null,
    boundThread: { current: null },
    queuedSends: { current: [] },
  };
}

type AttachmentKind = "image" | "doc" | "video";
export type Attachment =
  | {
      id: string;
      kind: AttachmentKind;
      name: string;
      status: "uploading";
      previewUrl: string;
      mime: string;
    }
  | {
      id: string;
      kind: AttachmentKind;
      name: string;
      status: "ready";
      previewUrl: string;
      mime: string;
      path: string;
    }
  | {
      id: string;
      kind: AttachmentKind;
      name: string;
      status: "error";
      previewUrl: string;
      mime: string;
      message: string;
    };

const MENU_OPEN_RE = /^\s*\/\S*$/;

const UNAVAILABLE_AGENT_CODES = new Set<string>([
  "not_chat_eligible",
  "default_disabled",
  "global_override_hide",
  "tenant_hidden_override",
  "staff_locked_hide",
  "unknown_agent",
  "not_found",
]);

export function Composer({
  agentSlug,
  tabId,
  threadId,
  stopRunId,
  onStopRun,
  externalStop,
  externalRetry,
  onSent,
  onCreditWall,
  onNonRunHandled,
  onOptimistic,
  onOptimisticSettled,
  draft,
  onSystem,
  attachments: controlledAttachments,
  onAttachmentsChange,
  onThreadBound,
  seed,
  droppedFiles,
  previewSessionId,
  buildSessionId,
  channelActionId,
  pageChannel,
  repoChipScope = HOME_SCOPE,
  hideStarterChips,
  starterChips,
  ignoreTabSeeds,
  placeholder,
  placeholderHints: hintsOverride,
  ariaLabel,
  onBeforeSend,
  beforeSendTakesImages = false,
  stickyChannels,
  embedded = false,
  disabled = false,
  homeMentions = false,
}: {
  embedded?: boolean;
  homeMentions?: boolean;
  disabled?: boolean;
  agentSlug: string;
  tabId: string;
  ignoreTabSeeds?: boolean;
  threadId?: string | null;
  latestRunId?: string | null;
  stopRunId?: string | null;
  onStopRun?: (runId: string) => void | (() => void);
  externalStop?: ExternalStopControl;
  externalRetry?: ExternalRetryControl;
  onSent?: (runId: string) => void;
  onCreditWall?: (
    wall: { message: string; kind: "credits" | "plan"; tier?: string | null } | null,
  ) => void;
  onNonRunHandled?: (action: string) => void;
  onOptimistic?: (
    text: string,
    attachments?: { path: string; kind?: "image" | "doc" }[],
  ) => string | undefined;
  onOptimisticSettled?: (
    id: string,
    accepted: { userMessageId: string | null } | null,
  ) => void;
  draft?: ComposerDraft;
  onSystem?: (text: string) => void;
  attachments?: Attachment[];
  onAttachmentsChange?: (next: React.SetStateAction<Attachment[]>) => void;
  onThreadBound?: (threadId: string | null) => void;
  seed?: {
    text: string;
    nonce: number;
    autoSend?: boolean;
    files?: FileRef[];
    onStarted?: () => void;
  };
  droppedFiles?: { files: File[]; nonce: number };
  previewSessionId?: string | null;
  repoChipScope?: RepoChipScope;
  buildSessionId?: string | null;
  channelActionId?: string | null;
  pageChannel?: string;
  hideStarterChips?: boolean;
  starterChips?: readonly string[];
  onBeforeSend?: (
    message: string,
    imagePaths?: string[],
  ) => Promise<{ handled: boolean; system?: string; creditWall?: string; consumed?: boolean }>;
  beforeSendTakesImages?: boolean;
  stickyChannels?: string[];
  placeholder?: string;
  placeholderHints?: string[];
  ariaLabel?: string;
}) {
  const {
    setTabDirty,
    setTabThreadId,
    role,
    composerSeeds,
    consumeComposerSeed,
    closeTab,
    openTab,
    treeAgents,
    supplyDemandEligible,
    currentUserId,
    tenantId,
  } = useWorkspace();
  const canManageBilling = !isMember(role);
  const readOnlyRole = isViewer(role);
  const { inflight, error, send } = useAgentRun();
  const [sending, setSending] = useState(false);
  const searchParams = useSearchParams();
  const {
    commands: tenantCommands,
    loaded: tenantCommandsLoaded,
    error: tenantCommandsError,
  } = useTenantCommands();
  const [value, setValueState] = useState(() => draft?.text ?? "");
  const setValue = useCallback(
    (next: SetStateAction<string>) => {
      if (typeof next === "function") {
        setValueState((prev) => {
          const resolved = next(prev);
          if (draft) draft.text = resolved;
          return resolved;
        });
        return;
      }
      if (draft) draft.text = next;
      setValueState(next);
    },
    [draft],
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const valueRef = useRef(value);
  valueRef.current = value;
  const ownQueuedSendsRef = useRef<QueuedSend[]>([]);
  const queuedSendsRef = draft?.queuedSends ?? ownQueuedSendsRef;
  const [queuedSendTick, setQueuedSendTick] = useState(0);
  const ownBoundThreadRef = useRef<string | null>(null);
  const lastBoundThreadRef = draft?.boundThread ?? ownBoundThreadRef;
  const dropQueuedSends = useCallback((): string[] => {
    const dropped = queuedSendsRef.current.splice(0);
    for (const q of dropped) {
      if (q.optId) onOptimisticSettled?.(q.optId, null);
    }
    return dropped.map((q) => q.text);
  }, [queuedSendsRef, onOptimisticSettled]);
  const scopeThreadId = threadId ?? null;
  const queueScopeRef = useRef({ threadId: scopeThreadId, agentSlug, tabId });
  useEffect(() => {
    const prev = queueScopeRef.current;
    queueScopeRef.current = { threadId: scopeThreadId, agentSlug, tabId };
    if (prev.agentSlug === agentSlug && prev.tabId === tabId) {
      if (prev.threadId === scopeThreadId) return;
      if (
        prev.threadId === null &&
        scopeThreadId !== null &&
        scopeThreadId === lastBoundThreadRef.current
      ) {
        return;
      }
    }
    lastBoundThreadRef.current = null;
    const texts = dropQueuedSends();
    if (texts.length === 0) return;
    setValue((current) => [...texts, current].filter((t) => t.trim()).join("\n"));
  }, [scopeThreadId, agentSlug, tabId, lastBoundThreadRef, dropQueuedSends, setValue]);
  const lastExternalSeedRef = useRef<string | null>(null);
  const [parseHint, setParseHintState] = useState<string | null>(null);
  const parseHintRef = useRef<string | null>(null);
  const setParseHint = useCallback((next: string | null) => {
    if (parseHintRef.current === next) return;
    parseHintRef.current = next;
    setParseHintState(next);
  }, []);
  const [menuCursor, setMenuCursor] = useState(0);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([]);
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const controlledTray = controlledAttachments !== undefined && !!onAttachmentsChange;
  const attachments = controlledTray ? controlledAttachments : localAttachments;
  const setAttachments = controlledTray ? onAttachmentsChange : setLocalAttachments;
  const [isDragOver, setIsDragOver] = useState(false);
  const [restoredAfterFail, setRestoredAfterFail] = useState(false);
  const serviceHealth = useServiceHealth();
  const [creditError, setCreditError] = useState<string | null>(null);
  const liftCreditWall = onCreditWall !== undefined;
  const [creditErrorKind, setCreditErrorKind] = useState<"credits" | "plan">("credits");
  const [creditWallTier, setCreditWallTier] = useState<string | null>(null);
  const [dictationActive, setDictationActive] = useState(false);
  const [seededPlaceholder, setSeededPlaceholder] = useState<string | null>(
    null,
  );
  const [editBaseline, setEditBaseline] = useState<string | null>(null);
  const [editOfMessageId, setEditOfMessageId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const typed = taRef.current?.value ?? "";
    if (!typed.trim()) return;
    setValue((current) => (current ? current : typed));
  }, [setValue]);
  const mentionInputRef = useRef<MentionComposerInputHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyDictation = useCallback((transcript: string) => {
    setValue((current) => appendDictatedText(current, transcript));
    setRestoredAfterFail(false);
    setCreditError(null);
    setSeededPlaceholder(null);
    requestAnimationFrame(() => {
      const textarea = taRef.current;
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }, []);
  const firedSeedRef = useRef<object | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `praxis:refine-seed:${agentSlug}`;
    let seed: string | null = null;
    try {
      seed = sessionStorage.getItem(key);
    } catch {
      return;
    }
    if (!seed) return;
    if (value.trim().length > 0) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
    }
    setValue(seed);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [searchParams, agentSlug, value]);

  const pendingSeed = ignoreTabSeeds ? undefined : composerSeeds[tabId];
  useEffect(() => {
    if (!pendingSeed) return;
    consumeComposerSeed(tabId);
    if (pendingSeed.placeholderHint)
      setSeededPlaceholder(pendingSeed.placeholderHint);

    const action = resolveSeedDrain({
      seed: pendingSeed,
      hasTypedText: value.trim().length > 0,
      alreadyFired: firedSeedRef.current === pendingSeed,
    });

    if (action.kind === "focus_only") {
      taRef.current?.focus();
      return;
    }
    if (action.kind === "autosend") {
      firedSeedRef.current = pendingSeed;
      void fire(action.text);
      return;
    }
    if (action.kind !== "prefill") return;
    const isEditSeed = pendingSeed.origin === "edit";
    const withPhotos = splitFileRefs(action.text);
    setEditBaseline(isEditSeed ? appendFileRefs(withPhotos.body, withPhotos.files).trim() : null);
    setEditOfMessageId(
      isEditSeed && UUID_RE.test(pendingSeed.editMessageId ?? "")
        ? (pendingSeed.editMessageId as string)
        : null,
    );
    if (isEditSeed) setFileRefs((prev) => (sameFileRefs(prev, withPhotos.files) ? prev : withPhotos.files));
    else if (withPhotos.files.length > 0) setFileRefs((prev) => mergeFileRefs(prev, withPhotos.files));
    const seeded = splitChannelMention(withPhotos.body);
    if (seeded.channel) {
      dispatchMention({ type: "select", target: channelTarget(seeded.channel), position: 0 });
    } else {
      dispatchMention({ type: "clear", caret: withPhotos.body.length });
    }
    setValue(seeded.channel ? seeded.body : withPhotos.body);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.scrollIntoView({ block: "nearest" });
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSeed, tabId, value, consumeComposerSeed]);

  useEffect(() => {
    if (!seed) return;
    if (seed.autoSend) {
      const busy =
        sending || Boolean(externalStop && !externalStop.allowSend) || (Boolean(stopRunId) && !bargeInOn);
      if (value.trim() || busy) {
        if (busy && !value.trim()) {
          onSystem?.("Wait for the current run to finish (or press Stop) before sending another message.");
        }
        claimComposerSeed(seed);
        taRef.current?.focus();
        return;
      }
    }
    if (!claimComposerSeed(seed)) return;
    const split = splitFileRefs(seed.text);
    const incoming = [...split.files, ...(seed.files ?? [])];
    const text = split.body.trim();
    if (!text && incoming.length === 0) return;
    if (seed.autoSend) {
      void fire(appendFileRefs(text, incoming));
      seed.onStarted?.();
      return;
    }
    if (incoming.length > 0) setFileRefs((prev) => mergeFileRefs(prev, incoming));
    if (text && mayReplaceWithSeed({ current: value, lastSeeded: lastExternalSeedRef.current })) {
      setValue(text);
      lastExternalSeedRef.current = text;
    }
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const uploadsPending = attachments.some((a) => a.status === "uploading");
  const readyImagePaths = attachments
    .filter(
      (a): a is Extract<Attachment, { status: "ready" }> =>
        a.status === "ready" && a.kind === "image",
    )
    .map((a) => a.path);
  const readyDocPaths = attachments
    .filter(
      (a): a is Extract<Attachment, { status: "ready" }> =>
        a.status === "ready" && a.kind === "doc",
    )
    .map((a) => a.path);
  const readyVideoPaths = attachments
    .filter(
      (a): a is Extract<Attachment, { status: "ready" }> =>
        a.status === "ready" && a.kind === "video",
    )
    .map((a) => a.path);

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const ownsBlobs = !controlledTray;
  const ownsBlobsRef = useRef(ownsBlobs);
  ownsBlobsRef.current = ownsBlobs;
  useEffect(() => {
    return () => {
      if (!ownsBlobsRef.current) return;
      attachmentsRef.current.forEach((a) => {
        if (a.previewUrl.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
      });
    };
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a && a.previewUrl.startsWith("blob:"))
        URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const uploadImageFile = async (file: File) => {
    if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
      onSystem?.(`Skipping ${file.name}: only PNG/JPEG/WebP allowed.`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      onSystem?.(`Skipping ${file.name}: max 5MB per image.`);
      return;
    }
    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const name = file.name;
    setAttachments((prev) => [
      ...prev,
      {
        id,
        kind: "image",
        name,
        status: "uploading",
        previewUrl,
        mime: file.type,
      },
    ]);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/chat/upload-image?save_to_files=1", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const message = uploadErrorMessage(name, MAX_IMAGE_BYTES / 1024 / 1024, {
          kind: "http",
          status: res.status,
          body: text,
        });
        onSystem?.(message);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  id,
                  kind: "image",
                  name,
                  status: "error",
                  previewUrl,
                  mime: file.type,
                  message,
                }
              : a,
          ),
        );
        return;
      }
      const data = (await res.json()) as { image_path: string; saved_to_files?: boolean };
      if (data.saved_to_files) notifyWorkspaceFilesChanged();
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "image",
                name,
                status: "ready",
                previewUrl,
                mime: file.type,
                path: data.image_path,
              }
            : a,
        ),
      );
    } catch (e) {
      const message = uploadErrorMessage(name, MAX_IMAGE_BYTES / 1024 / 1024, {
        kind: "thrown",
        error: e,
        sizeBytes: file.size,
      });
      onSystem?.(message);
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "image",
                name,
                status: "error",
                previewUrl,
                mime: file.type,
                message,
              }
            : a,
        ),
      );
    }
  };

  const uploadVideoFile = async (file: File) => {
    if (!ALLOWED_VIDEO_MIMES.has(file.type)) {
      onSystem?.(`Skipping ${file.name}: only MP4 video allowed.`);
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      onSystem?.(`Skipping ${file.name}: max 50MB per video.`);
      return;
    }
    const id = crypto.randomUUID();
    const name = file.name;
    setAttachments((prev) => [
      ...prev,
      {
        id,
        kind: "video",
        name,
        status: "uploading",
        previewUrl: "",
        mime: file.type,
      },
    ]);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/chat/upload-video", {
        method: "POST",
        body: form,
        retryOnNetworkError: false,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const message = uploadErrorMessage(name, MAX_VIDEO_BYTES / 1024 / 1024, {
          kind: "http",
          status: res.status,
          body: text,
        });
        onSystem?.(message);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  id,
                  kind: "video",
                  name,
                  status: "error",
                  previewUrl: "",
                  mime: file.type,
                  message,
                }
              : a,
          ),
        );
        return;
      }
      const data = (await res.json()) as { video_path: string };
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "video",
                name,
                status: "ready",
                previewUrl: "",
                mime: file.type,
                path: data.video_path,
              }
            : a,
        ),
      );
    } catch (e) {
      const message = uploadErrorMessage(name, MAX_VIDEO_BYTES / 1024 / 1024, {
        kind: "thrown",
        error: e,
        sizeBytes: file.size,
      });
      onSystem?.(message);
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "video",
                name,
                status: "error",
                previewUrl: "",
                mime: file.type,
                message,
              }
            : a,
        ),
      );
    }
  };

  const uploadDocFile = async (file: File) => {
    const ext = fileExt(file.name);
    if (!ALLOWED_DOC_EXTS.has(ext)) {
      onSystem?.(`Skipping ${file.name}: only PDF/DOCX/CSV/TXT/MD allowed.`);
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      onSystem?.(`Skipping ${file.name}: max 10MB per document.`);
      return;
    }
    const id = crypto.randomUUID();
    const name = file.name;
    setAttachments((prev) => [
      ...prev,
      {
        id,
        kind: "doc",
        name,
        status: "uploading",
        previewUrl: "",
        mime: file.type,
      },
    ]);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/chat/upload-doc", {
        method: "POST",
        body: form,
        retryOnNetworkError: false,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const message = uploadErrorMessage(name, MAX_DOC_BYTES / 1024 / 1024, {
          kind: "http",
          status: res.status,
          body: text,
        });
        onSystem?.(message);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  id,
                  kind: "doc",
                  name,
                  status: "error",
                  previewUrl: "",
                  mime: file.type,
                  message,
                }
              : a,
          ),
        );
        return;
      }
      const data = (await res.json()) as { doc_path: string };
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "doc",
                name,
                status: "ready",
                previewUrl: "",
                mime: file.type,
                path: data.doc_path,
              }
            : a,
        ),
      );
    } catch (e) {
      const message = uploadErrorMessage(name, MAX_DOC_BYTES / 1024 / 1024, {
        kind: "thrown",
        error: e,
        sizeBytes: file.size,
      });
      onSystem?.(message);
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                id,
                kind: "doc",
                name,
                status: "error",
                previewUrl: "",
                mime: file.type,
                message,
              }
            : a,
        ),
      );
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    const images: File[] = [];
    const docs: File[] = [];
    const videos: File[] = [];
    const unsupported: string[] = [];
    for (const f of Array.from(files).map(normalizeAttachmentFile)) {
      if (f.type.startsWith("image/")) {
        if (!ALLOWED_IMAGE_MIMES.has(f.type)) {
          onSystem?.(`Skipping ${f.name}: only PNG/JPEG/WebP allowed.`);
        } else if (f.size > MAX_IMAGE_BYTES) {
          onSystem?.(`Skipping ${f.name}: max 5MB per image.`);
        } else {
          images.push(f);
        }
      } else if (f.type.startsWith("video/")) {
        if (!ALLOWED_VIDEO_MIMES.has(f.type)) {
          onSystem?.(`Skipping ${f.name}: only MP4 video allowed.`);
        } else if (f.size > MAX_VIDEO_BYTES) {
          onSystem?.(`Skipping ${f.name}: max 50MB per video.`);
        } else {
          videos.push(f);
        }
      } else if (ALLOWED_DOC_EXTS.has(fileExt(f.name))) {
        if (f.size > MAX_DOC_BYTES) {
          onSystem?.(`Skipping ${f.name}: max 10MB per document.`);
        } else {
          docs.push(f);
        }
      } else {
        unsupported.push(f.name);
      }
    }
    if (unsupported.length > 0) {
      const accepted = "Attach PNG, JPEG, WebP, MP4, PDF, DOCX, CSV, TXT or MD.";
      onSystem?.(
        unsupported.length === 1
          ? `Skipping ${unsupported[0]}: unsupported file type. ${accepted}`
          : `Skipped ${unsupported.length} unsupported files. ${accepted}`,
      );
    }

    const imgUsed = attachments.filter((a) => a.kind === "image").length;
    const docUsed = attachments.filter((a) => a.kind === "doc").length;
    const imgSlots = Math.max(0, MAX_IMAGES_PER_TURN - imgUsed);
    const docSlots = Math.max(0, MAX_DOCS_PER_TURN - docUsed);

    if (images.length > 0 && imgSlots <= 0) {
      onSystem?.(`Max ${MAX_IMAGES_PER_TURN} images per turn.`);
    }
    if (docs.length > 0 && docSlots <= 0) {
      onSystem?.(`Max ${MAX_DOCS_PER_TURN} documents per turn.`);
    }
    if (images.length > imgSlots) {
      onSystem?.(
        `Max ${MAX_IMAGES_PER_TURN} images per turn; skipped ${images.length - imgSlots}.`,
      );
    }
    if (docs.length > docSlots) {
      onSystem?.(
        `Max ${MAX_DOCS_PER_TURN} documents per turn; skipped ${docs.length - docSlots}.`,
      );
    }

    for (const f of images.slice(0, imgSlots)) void uploadImageFile(f);
    for (const f of docs.slice(0, docSlots)) void uploadDocFile(f);

    const videoUsed = attachments.filter((a) => a.kind === "video").length;
    const videoSlots = Math.max(0, MAX_VIDEOS_PER_TURN - videoUsed);
    if (videos.length > videoSlots) {
      onSystem?.(`One video per message; skipped ${videos.length - videoSlots}.`);
    }
    for (const f of videos.slice(0, videoSlots)) void uploadVideoFile(f);
  };

  const [attachingArtifact, setAttachingArtifact] = useState<string | null>(null);
  const [pickedChannels, setPickedChannels] = useState<string[]>(
    () => stickyChannels ?? [],
  );
  const channelPickIsSticky = stickyChannels !== undefined;
  const attachExistingArtifact = async (artifactId: string, filename: string) => {
    const imgUsed = attachments.filter((a) => a.kind === "image").length;
    const docUsed = attachments.filter((a) => a.kind === "doc").length;
    if (imgUsed >= MAX_IMAGES_PER_TURN && docUsed >= MAX_DOCS_PER_TURN) {
      onSystem?.("This message is already full of attachments.");
      return;
    }
    setAttachingArtifact(filename);
    try {
      const res = await apiFetch("/api/chat/attach-artifact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifact_id: artifactId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        onSystem?.(body?.error?.message ?? `Couldn’t attach ${filename}.`);
        return;
      }
      const body = (await res.json()) as {
        kind?: "image" | "doc";
        image_path?: string;
        doc_path?: string;
        filename?: string;
      };
      const path = body.kind === "image" ? body.image_path : body.doc_path;
      const kind: AttachmentKind = body.kind === "image" ? "image" : "doc";
      if (!path) {
        onSystem?.(`Couldn’t attach ${filename}.`);
        return;
      }
      const used = kind === "image" ? imgUsed : docUsed;
      const cap = kind === "image" ? MAX_IMAGES_PER_TURN : MAX_DOCS_PER_TURN;
      if (used >= cap) {
        onSystem?.(
          kind === "image"
            ? `Max ${MAX_IMAGES_PER_TURN} images per turn.`
            : `Max ${MAX_DOCS_PER_TURN} documents per turn.`,
        );
        return;
      }
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind,
          name: body.filename ?? filename,
          status: "ready",
          previewUrl: "",
          mime: kind === "image" ? "image/jpeg" : "application/octet-stream",
          path,
        },
      ]);
    } catch {
      onSystem?.(`Couldn’t attach ${filename}.`);
    } finally {
      setAttachingArtifact(null);
    }
  };

  useEffect(() => {
    if (!droppedFiles || droppedFiles.files.length === 0) return;
    if (consumedDrops.has(droppedFiles)) return;
    consumedDrops.add(droppedFiles);
    handleFiles(droppedFiles.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFiles]);

  const menuOpen = MENU_OPEN_RE.test(value);
  const menuQuery = menuOpen ? value.trimStart().slice(1) : "";
  const menuMatches: SlashCommand[] = useMemo(
    () => (menuOpen ? filterCommands(menuQuery) : []),
    [menuOpen, menuQuery],
  );
  const menuTenantMatches: TenantSlashEntry[] = useMemo(() => {
    if (!menuOpen) return [];
    return filterTenantCommands(menuQuery, tenantCommands).map(toSlashEntry);
  }, [menuOpen, menuQuery, tenantCommands]);
  const totalMenuMatches = menuMatches.length + menuTenantMatches.length;

  const [mentionState, dispatchMention] = useReducer(composerMentionReducer, {
    selected: null,
    caret: null,
  });
  const selectedMention = mentionState.selected;
  const mentionChip = selectedMention?.target ?? null;
  const mentionPosition = selectedMention?.position ?? 0;
  const textareaCaret = mentionState.caret ?? value.length;
  const activeMention = useMemo(
    () =>
      mentionChip || pageChannel ? null : getActiveComposerMention(value, textareaCaret),
    [mentionChip, pageChannel, textareaCaret, value],
  );
  const mentionOpen = activeMention !== null;
  const mentionQuery = activeMention?.query ?? "";
  const mentionBody = value;
  const connectedSlugs = useConnectedSlugs(mentionOpen);
  const homeTeam = useMemo(
    () => (homeMentions ? teamFromTree(treeAgents ?? [], supplyDemandEligible === true) : []),
    [homeMentions, treeAgents, supplyDemandEligible],
  );
  const homeCustomAgents = useMemo(
    () =>
      homeMentions
        ? customAgentRows(treeAgents ?? []).map((a) => ({ slug: a.slug, name: a.name as string }))
        : [],
    [homeMentions, treeAgents],
  );
  const recentKey = homeMentions ? recentStorageKey(currentUserId, tenantId) : null;
  const mentionSections = useMemo(() => {
    if (!mentionOpen) return [];
    if (!homeMentions) return channelOnlySections(mentionQuery);
    return homeMentionSections({
      query: mentionQuery,
      connected: connectedSlugs,
      team: homeTeam,
      recent: readRecentMentions(recentKey),
    });
  }, [mentionOpen, homeMentions, mentionQuery, connectedSlugs, homeTeam, recentKey]);
  const mentionMatches: MentionTarget[] = useMemo(
    () => flattenSections(mentionSections),
    [mentionSections],
  );

  useEffect(() => {
    setMenuCursor(0);
  }, [menuQuery]);
  useEffect(() => {
    setMenuCursor(0);
  }, [mentionQuery]);

  const prevDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    const nextDirty = value.trim().length > 0;
    if (prevDirtyRef.current === nextDirty) return;
    prevDirtyRef.current = nextDirty;
    setTabDirty(tabId, nextDirty);
  }, [value, tabId, setTabDirty]);

  useEffect(() => {
    const showParseHint = (next: string | null) => {
      if (parseHintRef.current !== next) setParseHint(next);
    };
    if (mentionChip) {
      showParseHint(null);
      return;
    }
    if (!value.trim().startsWith("/") && !value.trim().startsWith("@")) {
      showParseHint(null);
      return;
    }
    const channelAddress =
      (agentSlug === "operator" ? matchChannelMention(value) : null) ??
      (homeMentions ? matchHomeAgentMention(value, homeCustomAgents) : null);
    if (channelAddress) {
      showParseHint(
        channelAddress.rest
          ? `⏎ to put this to ${channelAddress.name}. The answer comes back here.`
          : `Add your question for ${channelAddress.name}.`,
      );
      return;
    }
    const p = parseInput(value);
    if (p.kind === "unknown_command") {
      showParseHint(
        tenantCommandHint(
          value,
          tenantCommands,
          tenantCommandsLoaded,
          tenantCommandsError != null,
        ),
      );
    } else if (p.kind === "feedback") {
      showParseHint(`⏎ to send feedback to ${agentDisplayName(agentSlug)}.`);
    } else if (p.kind === "clear") {
      showParseHint(`⏎ to start a fresh thread.`);
    } else if (p.kind === "help") {
      showParseHint(`⏎ to list every command.`);
    } else if (p.kind === "force_run") {
      showParseHint("⏎ to dispatch a structured run (no thread context).");
    } else if (p.kind === "route_to_agent") {
      showParseHint(pageChannel ? null : `⏎ to route this turn to @${p.agent}.`);
    } else if (p.kind === "attach_decision") {
      showParseHint(
        `⏎ to attach decision ${p.decisionId.slice(0, 8)}… as context.`,
      );
    } else {
      showParseHint(null);
    }
  }, [
    value,
    agentSlug,
    homeMentions,
    homeCustomAgents,
    pageChannel,
    mentionChip,
    tenantCommands,
    tenantCommandsLoaded,
    tenantCommandsError,
  ]);

  const selectCommand = (selection: SlashSelection) => {
    const name =
      selection.kind === "builtin" ? selection.cmd.name : selection.entry.slug;
    setValue(`/${name} `);
    setMenuCursor(0);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  };

  const selectMention = (target: MentionTarget) => {
    const replacement = replaceActiveComposerMention(value, textareaCaret);
    if (homeMentions) rememberRecentMention(recentKey, target.key);
    dispatchMention({
      type: "select",
      target,
      position: replacement.caret,
    });
    setValue(replacement.value);
    setMenuCursor(0);
    requestAnimationFrame(() => {
      mentionInputRef.current?.focus(replacement.caret);
    });
  };

  const restoreFailedSend = useCallback(
    (
      text: string,
      attachmentsToRestore?: Attachment[],
      showRetryBanner = true,
    ) => {
      const split = splitFileRefs(text);
      setValue(split.body);
      if (split.files.length > 0) setFileRefs((prev) => mergeFileRefs(split.files, prev));
      if (attachmentsToRestore && attachmentsToRestore.length > 0) {
        setAttachments(attachmentsToRestore);
      }
      if (showRetryBanner) {
        setRestoredAfterFail(true);
        reportTrouble();
      }
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    },
    [],
  );

  useEffect(() => {
    if (!draft) return;
    draft.restore = restoreFailedSend;
    return () => {
      if (draft.restore === restoreFailedSend) draft.restore = null;
    };
  }, [draft, restoreFailedSend]);

  const restoreInLiveComposer = (
    text: string,
    attachmentsToRestore?: Attachment[],
    showRetryBanner = true,
  ) => {
    const restore =
      !mountedRef.current && draft?.restore ? draft.restore : restoreFailedSend;
    restore(text, attachmentsToRestore, showRetryBanner);
  };

  const returnQueuedToBox = (sentText = "") => {
    const texts = dropQueuedSends();
    if (texts.length === 0 && !sentText.trim()) return;
    const typed = draft ? draft.text : valueRef.current;
    restoreInLiveComposer(joinRestoredTexts([sentText, ...texts, typed]), undefined, false);
  };

  const goUpgrade = useCallback(() => {
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings" },
      dirty: false,
      pinned: false,
    });
    if (typeof window !== "undefined") {
      const target = wallBillingTarget(creditErrorKind, creditWallTier);
      window.setTimeout(() => {
        window.location.hash = target;
      }, 80);
    }
  }, [openTab, creditErrorKind, creditWallTier]);

  const repoMenuEnabled = agentSlug === "engineer" || agentSlug === "operator";

  const goRepoSettings = useCallback(() => {
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings", section: "connectors" },
      dirty: false,
      pinned: false,
    });
  }, [openTab]);

  const isSendFailure = (
    result: ChatSendResult | ChatSendError | null,
  ): result is ChatSendError | null =>
    result === null || result.kind === "error";

  const applySendSuccess = useCallback(
    (result: ChatSendResult, targetSlug: string) => {
      if (result.thread_id) {
        notifyThreadsChanged();
        if (targetSlug === agentSlug) {
          lastBoundThreadRef.current = result.thread_id;
          setTabThreadId(tabId, result.thread_id);
          onThreadBound?.(result.thread_id);
        }
      }
      if (result.kind === "non_run") onNonRunHandled?.(result.action);
      else onSent?.(result.run_id);
    },
    [
      agentSlug,
      tabId,
      setTabThreadId,
      onThreadBound,
      onNonRunHandled,
      onSent,
    ],
  );

  const finishSend = useCallback(
    async (
      result: ChatSendResult | ChatSendError | null,
      targetSlug: string,
      sendThreadId: string | null,
      message: string,
      retryExtras?: {
        command_slug?: string;
        image_paths?: string[];
        doc_paths?: string[];
        video_paths?: string[];
        preview_session_id?: string;
        build_session_id?: string;
        channel_action_id?: string;
        page_channel?: string;
        page_channel_action_id?: string;
      },
    ): Promise<"handled" | "failed" | "credits" | "invalid_command"> => {
      const claimInsufficientCredits = (
        r: ChatSendResult | ChatSendError | null,
      ): boolean => {
        if (
          r?.kind === "error" &&
          r.status === 402 &&
          r.code === "insufficient_credits"
        ) {
          const text =
            r.message ??
            "You're out of credits for now. Your free daily credits come back at midnight UTC, or top up or upgrade in Billing to keep going today.";
          setCreditErrorKind("credits");
          setCreditWallTier(null);
          setCreditError(text);
          onCreditWall?.({ message: text, kind: "credits" });
          return true;
        }
        if (r?.kind === "error" && isPlanUpgradeRefusal(r.status, r.code)) {
          const tier = r.required_tier ?? null;
          const text = planUpgradeMessage(r.message, null);
          setCreditErrorKind("plan");
          setCreditWallTier(tier);
          setCreditError(text);
          onCreditWall?.({ message: text, kind: "plan", tier });
          return true;
        }
        return false;
      };
      const isInvalidCommand = (
        r: ChatSendResult | ChatSendError | null,
      ): boolean => r?.kind === "error" && r.code === "invalid_command";
      if (
        isSendFailure(result) &&
        shouldTransparentlyHealThread({
          errorCode: result?.code,
          targetSlug,
          agentSlug,
          sentThreadId: sendThreadId,
        })
      ) {
        setTabThreadId(tabId, null);
        onThreadBound?.(null);
        const healed = await send(targetSlug, message, null, retryExtras);
        if (!isSendFailure(healed)) {
          applySendSuccess(healed, targetSlug);
          return "handled";
        }
        if (claimInsufficientCredits(healed)) return "credits";
        if (isInvalidCommand(healed)) return "invalid_command";
        return "failed";
      }
      if (isSendFailure(result)) {
        if (claimInsufficientCredits(result)) return "credits";
        if (isInvalidCommand(result)) return "invalid_command";
        if (result?.code === "thread_not_found" && targetSlug === agentSlug) {
          setTabThreadId(tabId, null);
          onThreadBound?.(null);
        }
        return "failed";
      }
      applySendSuccess(result, targetSlug);
      return "handled";
    },
    [agentSlug, tabId, send, setTabThreadId, onThreadBound, applySendSuccess, onCreditWall],
  );

  const handleUnavailableAgent = useCallback(
    (
      result: ChatSendResult | ChatSendError | null,
      targetSlug: string,
    ): boolean => {
      if (!result || result.kind !== "error" || !result.code) return false;
      if (!UNAVAILABLE_AGENT_CODES.has(result.code)) return false;
      if (targetSlug === agentSlug) {
        closeTab(tabId, { toHome: true });
      } else {
        onSystem?.(`@${targetSlug} isn't available for chat.`);
      }
      return true;
    },
    [agentSlug, tabId, closeTab, onSystem],
  );

  const bargeInOn = isBargeInEnabled();
  const blockNewTurnWhileRunning = (): boolean => {
    if (externalStop && !externalStop.allowSend) {
      onSystem?.(
        "Wait for the current build change to finish (or press Stop) before sending another message.",
      );
      return true;
    }
    if (!stopRunId) return false;
    if (bargeInOn) return false;
    onSystem?.(
      "Wait for the current run to finish (or press Stop) before sending another message.",
    );
    return true;
  };

  const queueWhileSending = (): void => {
    const pendingText = value;
    const queueable =
      bargeInOn &&
      !externalStop &&
      !readOnlyRole &&
      !mentionChip &&
      editBaseline === null &&
      fileRefs.length === 0 &&
      attachments.length === 0 &&
      pickedChannels.length === 0 &&
      !pendingText.trimStart().startsWith("/") &&
      !pendingText.trimStart().startsWith("@") &&
      !shouldBlockSend({
        value: pendingText,
        readyImagePathsCount: 0,
        inflight: false,
        submittingFeedback,
      });
    if (!queueable) {
      if (pendingText.trim()) {
        setParseHint("Your last message is still sending. Press Enter again in a moment.");
      }
      return;
    }
    const optId = onOptimistic?.(pendingText.trim());
    setValue("");
    queuedSendsRef.current.push({ text: pendingText, optId, consumed: false });
    setQueuedSendTick((n) => n + 1);
  };

  const fire = async (
    overrideText?: string,
    queued?: { optId: string | undefined; consumed: boolean },
  ) => {
    if (disabled) return;
    const sharedInFlight =
      overrideText === undefined ? (draft?.inFlight ?? null) : null;
    if (sending || inflight || sharedInFlight) {
      if (overrideText === undefined) {
        queueWhileSending();
        if (sharedInFlight && !sending && !inflight) {
          const wake = () => setQueuedSendTick((n) => n + 1);
          sharedInFlight.then(wake, wake);
        }
      }
      return;
    }
    const typed =
      overrideText ??
      (mentionChip ? `@${mentionChip.sendSlug} ${mentionBody}` : value);
    const src =
      !overrideText && fileRefs.length > 0 && !typed.trimStart().startsWith("/")
        ? appendFileRefs(typed, fileRefs)
        : typed;
    const isEditingForSend = !overrideText && editBaseline !== null;
    if (!overrideText && mentionChip && !value.trim()) {
      setParseHint(`Add your question for ${mentionChip.name}.`);
      return;
    }
    if (!overrideText && editBaseline !== null) {
      if (src.trim() === editBaseline) {
        setParseHint("Change the message before sending it again.");
        return;
      }
    }
    if (
      shouldBlockSend({
        value: src,
        readyImagePathsCount: readyImagePaths.length,
        readyDocPathsCount: readyDocPaths.length,
        readyVideoPathsCount: readyVideoPaths.length,
        inflight,
        submittingFeedback,
      })
    ) {
      return;
    }
    const parsedRaw = parseInput(src);
    const parsed =
      (agentSlug === "operator" && matchChannelMention(src)) ||
      (homeMentions && matchHomeAgentMention(src, homeCustomAgents)) ||
      (pageChannel && parsedRaw.kind === "route_to_agent")
        ? ({ kind: "chat", body: src.trim() } as const)
        : parsedRaw;
    const rawInput = src;
    if (!overrideText && mentionChip) dispatchMention({ type: "clear" });
    setRestoredAfterFail(false);
    setCreditError(null);

    if (parsed.kind === "unknown_command") {
      const m = matchTenantInvocation(src.trim());
      if (m) {
        const found = tenantCommands.find((c) => c.slug === m.slug);
        if (found) {
          if (m.body.length === 0) {
            onSystem?.(`Command /${m.slug} needs a message.`);
            return;
          }
          if (blockNewTurnWhileRunning()) return;
          const commandOptId = onOptimistic?.(m.body);
          setValue("");
          setFileRefs([]);
          const result: ChatSendResult | ChatSendError | null = await send(
            agentSlug,
            m.body,
            threadId ?? null,
            {
              command_slug: m.slug,
              ...(buildSessionId ? { build_session_id: buildSessionId } : {}),
              ...(channelActionId ? { channel_action_id: channelActionId } : {}),
              ...pageOriginExtras(pageChannel, channelActionId),
            },
          );
          if (handleUnavailableAgent(result, agentSlug)) {
            if (commandOptId) onOptimisticSettled?.(commandOptId, null);
            return;
          }
          const outcome = await finishSend(
            result,
            agentSlug,
            threadId ?? null,
            m.body,
            {
              command_slug: m.slug,
              ...(buildSessionId ? { build_session_id: buildSessionId } : {}),
              ...(channelActionId ? { channel_action_id: channelActionId } : {}),
              ...pageOriginExtras(pageChannel, channelActionId),
            },
          );
          if (commandOptId) {
            onOptimisticSettled?.(
              commandOptId,
              outcome === "handled" && result?.kind !== "non_run"
                ? {
                    userMessageId:
                      result?.kind === "queued" && result.user_message_id
                        ? result.user_message_id
                        : null,
                  }
                : null,
            );
          }
          if (outcome === "credits") {
            return;
          }
          if (outcome === "invalid_command") {
            onSystem?.(
              `/${m.slug} isn't available in this workspace. It may belong to another. Switch workspaces or check Settings → Commands.`,
            );
            restoreInLiveComposer(rawInput, undefined, false);
            return;
          }
          if (outcome === "failed") {
            restoreInLiveComposer(rawInput);
            return;
          }
          return;
        }
        if (!SLASH_COMMANDS.some((c) => c.name === m.slug)) {
          onSystem?.(`/${m.slug} isn't a command in this workspace.`);
        }
        return;
      }
      return;
    }

    if (parsed.kind === "clear") {
      setValue("");
      setTabThreadId(tabId, null);
      onThreadBound?.(null);
      return;
    }

    if (parsed.kind === "help") {
      setValue("");
      const lines = SLASH_COMMANDS.map(
        (c) =>
          `/${c.name}${c.argHint ? " " + c.argHint : ""}: ${c.description}`,
      );
      onSystem?.(
        `Available commands:\n${lines.join("\n")}\n@<agent> <message>: route this turn to another agent.`,
      );
      return;
    }

    if (parsed.kind === "feedback") {
      setSubmittingFeedback(true);
      const body = parsed.body;
      setValue("");
      const result = await submitFeedback({ agent_slug: agentSlug, body });
      setSubmittingFeedback(false);
      if (!result.ok) {
        onSystem?.(`Rule not saved: ${result.error}`);
        return;
      }
      onSystem?.(feedbackConfirmation(body, result.status));
      return;
    }

    if (blockNewTurnWhileRunning()) return;

    const message =
      parsed.kind === "chat"
        ? parsed.body
        : parsed.kind === "force_run"
          ? parsed.body || "(forced run)"
          : parsed.kind === "route_to_agent"
            ? parsed.body
            : parsed.body;
    const targetSlug =
      parsed.kind === "route_to_agent" ? parsed.agent : agentSlug;
    const hasReadyImages = readyImagePaths.length > 0;
    const hasReadyDocs = readyDocPaths.length > 0;
    const hasReadyVideos = readyVideoPaths.length > 0;
    if (!message.trim() && !hasReadyImages && !hasReadyDocs && !hasReadyVideos) return;
    const onChatPath = parsed.kind === "chat";
    const imagePathsForSend =
      onChatPath && hasReadyImages ? readyImagePaths : undefined;
    const docPathsForSend =
      onChatPath && hasReadyDocs ? readyDocPaths : undefined;
    const videoPathsForSend =
      onChatPath && hasReadyVideos ? readyVideoPaths : undefined;
    const hasAttachmentsForSend = Boolean(
      imagePathsForSend || docPathsForSend || videoPathsForSend,
    );

    const sendThreadId =
      targetSlug !== agentSlug
        ? null
        : (threadId ?? (queued ? lastBoundThreadRef.current : null) ?? null);

    const previewSessionForSend =
      onChatPath && targetSlug === agentSlug && previewSessionId
        ? previewSessionId
        : undefined;

    const editOfMessageIdForSend =
      onChatPath && targetSlug === agentSlug && sendThreadId && editOfMessageId
        ? editOfMessageId
        : undefined;

    const channelsForSend =
      onChatPath && targetSlug === agentSlug && pickedChannels.length > 0
        ? pickedChannels
        : undefined;

    const buildSessionForSend = buildSessionId ? buildSessionId : undefined;
    const channelActionForSend = channelActionId ? channelActionId : undefined;
    const pageOriginForSend =
      targetSlug === agentSlug ? pageOriginExtras(pageChannel, channelActionId) : {};
    const githubForSend = readGithubRepos();
    const repoHintForSend =
      (onChatPath || parsed.kind === "route_to_agent") &&
      targetSlug === "engineer" &&
      !(repoChipScope.kind === "home" && githubForSend.status === "loading")
        ? repoHintFor(resolveRepoChip(repoChipScope, readBuildSessions(), null, !!ownGithubRepo(githubForSend)))
        : undefined;

    const attachmentExtras =
      hasAttachmentsForSend ||
      previewSessionForSend ||
      editOfMessageIdForSend ||
      channelsForSend ||
      buildSessionForSend ||
      channelActionForSend ||
      pageOriginForSend.page_channel ||
      repoHintForSend
        ? {
            ...(hasAttachmentsForSend
              ? {
                  image_paths: imagePathsForSend,
                  doc_paths: docPathsForSend,
                  video_paths: videoPathsForSend,
                }
              : {}),
            ...(previewSessionForSend
              ? { preview_session_id: previewSessionForSend }
              : {}),
            ...(editOfMessageIdForSend
              ? { edit_of_message_id: editOfMessageIdForSend }
              : {}),
            ...(channelsForSend ? { channels: channelsForSend } : {}),
            ...(buildSessionForSend ? { build_session_id: buildSessionForSend } : {}),
            ...(channelActionForSend ? { channel_action_id: channelActionForSend } : {}),
            ...pageOriginForSend,
            ...(repoHintForSend ? { repo_hint: repoHintForSend } : {}),
          }
        : undefined;
    const clearPickedChannels = () => setPickedChannels([]);

    const paintOptimistic = (): {
      optId: string | undefined;
      clearedAttachments: typeof attachments | undefined;
    } => {
      if (queued) {
        queued.consumed = true;
        return { optId: queued.optId, clearedAttachments: undefined };
      }
      const optimisticAttachments = onChatPath
        ? attachments.flatMap((a) => {
            if (a.status !== "ready") return [];
            if (a.kind !== "image" && a.kind !== "doc") return [];
            if (a.kind === "image" && a.previewUrl)
              primeChatImageUrl(a.path, a.previewUrl);
            return [{ path: a.path, kind: a.kind }];
          })
        : [];
      const optId = onOptimistic?.(
        message ||
          (optimisticAttachments.length > 0
            ? ""
            : imagePathsForSend
              ? "(image)"
              : videoPathsForSend
                ? "(video)"
                : "(document)"),
        optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
      );
      const clearedAttachments = hasAttachmentsForSend
        ? attachments
        : undefined;
      setValue("");
      setFileRefs([]);
      if (hasAttachmentsForSend) setAttachments([]);
      if (channelsForSend && !channelPickIsSticky) clearPickedChannels();
      return { optId, clearedAttachments };
    };

    const sendNow = async (
      clearedAttachments: typeof attachments | undefined,
      optId: string | undefined,
    ) => {
      const result: ChatSendResult | ChatSendError | null = await send(
        targetSlug,
        message,
        sendThreadId,
        attachmentExtras,
      );
      if (handleUnavailableAgent(result, targetSlug)) {
        if (optId) onOptimisticSettled?.(optId, null);
        returnQueuedToBox();
        return;
      }
      const outcome = await finishSend(
        result,
        targetSlug,
        sendThreadId,
        message,
        attachmentExtras,
      );
      if (optId) {
        onOptimisticSettled?.(
          optId,
          outcome === "handled" && result?.kind !== "non_run"
            ? {
                userMessageId:
                  result?.kind === "queued" && result.user_message_id
                    ? result.user_message_id
                    : null,
              }
            : null,
        );
      }
      const unsentQueued = outcome === "handled" ? [] : dropQueuedSends();
      const typedSince = draft ? draft.text : valueRef.current;
      const restoreTextWith = (sentText: string) =>
        joinRestoredTexts([sentText, ...unsentQueued, typedSince]);
      if (outcome === "credits" || outcome === "invalid_command") {
        const policy = sendFailureInputPolicy(outcome);
        const restoreText = restoreTextWith(policy.restoreInput ? rawInput : "");
        if (restoreText) {
          restoreInLiveComposer(
            restoreText,
            policy.restoreInput ? clearedAttachments : undefined,
            policy.retryBanner,
          );
        }
      } else if (outcome === "failed") {
        restoreInLiveComposer(restoreTextWith(rawInput), clearedAttachments);
      } else if (isEditingForSend) {
        setEditBaseline(null);
        setEditOfMessageId(null);
      }
    };

    const { optId, clearedAttachments } = paintOptimistic();
    setSending(true);

    const imagesOnlyForHost =
      beforeSendTakesImages && !!imagePathsForSend && !docPathsForSend && !videoPathsForSend;
    if (
      onBeforeSend &&
      onChatPath &&
      message.trim() &&
      (!hasAttachmentsForSend || imagesOnlyForHost)
    ) {
      let intercept: { handled: boolean; system?: string; creditWall?: string; consumed?: boolean };
      try {
        intercept = imagesOnlyForHost ? await onBeforeSend(message, imagePathsForSend) : await onBeforeSend(message);
      } catch {
        intercept = { handled: false };
      }
      if (intercept.handled) {
        if (isEditingForSend) {
          setEditBaseline(null);
          setEditOfMessageId(null);
        }
        if (intercept.creditWall) {
          setCreditErrorKind("credits");
          setCreditWallTier(null);
          setCreditError(intercept.creditWall);
          onCreditWall?.({ message: intercept.creditWall, kind: "credits" });
        } else if (intercept.system) onSystem?.(intercept.system);
        if (imagesOnlyForHost && !intercept.consumed) restoreInLiveComposer(rawInput, clearedAttachments, false);
        if (optId) onOptimisticSettled?.(optId, null);
        setSending(false);
        return;
      }
    }

    const pending = sendNow(clearedAttachments, optId)
      .catch((e: unknown) => {
        if (optId) onOptimisticSettled?.(optId, null);
        returnQueuedToBox(rawInput);
        throw e;
      })
      .finally(() => setSending(false));
    if (draft) {
      draft.inFlight = pending;
      const release = () => {
        if (draft.inFlight === pending) draft.inFlight = null;
      };
      pending.then(release, release);
    }
    await pending;
  };

  const fireRef = useRef(fire);
  fireRef.current = fire;
  useEffect(() => {
    if (sending || inflight || draft?.inFlight) return;
    const next = queuedSendsRef.current.shift();
    if (!next) return;
    const settleUnsent = () => {
      if (next.consumed) return;
      if (next.optId) onOptimisticSettled?.(next.optId, null);
      setValue((current) => (current.trim() ? `${next.text}\n${current}` : next.text));
    };
    fireRef.current(next.text, next).then(settleUnsent, settleUnsent);
  }, [sending, inflight, queuedSendTick, onOptimisticSettled, setValue]);

  const typedForSend = mentionChip
    ? `@${mentionChip.sendSlug} ${mentionBody}`
    : value;
  const composedForSend =
    fileRefs.length > 0 && !typedForSend.trimStart().startsWith("/")
      ? appendFileRefs(typedForSend, fileRefs)
      : typedForSend;
  const sendDisabled =
    disabled ||
    readOnlyRole ||
    uploadsPending ||
    (editBaseline !== null && composedForSend.trim() === editBaseline) ||
    shouldBlockSend({
      value: fileRefs.length > 0 && !value.trimStart().startsWith("/") ? appendFileRefs(value, fileRefs) : value,
      readyImagePathsCount: readyImagePaths.length,
      readyDocPathsCount: readyDocPaths.length,
      readyVideoPathsCount: readyVideoPaths.length,
      inflight,
      submittingFeedback,
    });

  const composerAriaLabel =
    ariaLabel ?? `Send a message to ${agentDisplayName(agentSlug)}`;
  const handleComposerChange = (next: string, caret?: number) => {
    setValue(next);
    if (caret !== undefined) dispatchMention({ type: "caret", caret });
    if (restoredAfterFail) setRestoredAfterFail(false);
    if (creditError) {
      setCreditError(null);
      onCreditWall?.(null);
    }
    if (seededPlaceholder) setSeededPlaceholder(null);
  };
  const toggleAskMenu = () => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? value.length;
    if (mentionOpen) {
      const removed = removeActiveComposerMention(value, textareaCaret);
      setValue(removed.value);
      dispatchMention({ type: "caret", caret: removed.caret });
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(removed.caret, removed.caret);
      });
      return;
    }
    const before = value.slice(0, caret);
    const insert = before.length === 0 || /\s$/.test(before) ? "@" : " @";
    const next = before + insert + value.slice(caret);
    const at = caret + insert.length;
    setValue(next);
    dispatchMention({ type: "caret", caret: at });
    setMenuCursor(0);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(at, at);
    });
  };
  const removeMention = (next = value, caret = mentionPosition) => {
    dispatchMention({ type: "clear", caret });
    setValue(next);
    requestAnimationFrame(() => {
      const textarea = taRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  return (
    <div
      className={
        embedded ? "w-full bg-transparent" : "bg-transparent px-4 pb-4 pt-3"
      }
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files.length > 0) {
          handleFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className={embedded ? "w-full" : "mx-auto w-full max-w-[42rem]"}>
        {agentSlug === "engineer" && <RepoChip role={role} scope={repoChipScope} />}
        {}
        {!hideStarterChips &&
          (starterChips === undefined || starterChips.length > 0) &&
          !threadId &&
          value.trim() === "" &&
          attachments.length === 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {(starterChips ?? cannedQuestionsFor(agentSlug)).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setValue(q);
                    requestAnimationFrame(() => {
                      const el = taRef.current;
                      if (!el) return;
                      el.focus();
                      const end = el.value.length;
                      el.setSelectionRange(end, end);
                    });
                  }}
                  className="rounded-full border border-rule bg-cream px-3 py-1 text-[13px] text-inkSoft transition-colors hover:bg-creamDeep hover:text-ink"
                >
                  {q}
                </button>
              ))}
              {}
              {agentSlug !== GROWTH_OFFICER_SLUG && starterChips === undefined && (
                <a
                  href="/tools"
                  className="rounded-full border border-dashed border-rule px-3 py-1 text-[13px] text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink"
                >
                  More things to ask
                </a>
              )}
            </div>
          )}
        {}
        <FileRefChips
          files={fileRefs}
          onRemove={(url) => setFileRefs((prev) => prev.filter((f) => f.url !== url))}
          className="mb-2"
        />
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="relative h-16 w-16 overflow-hidden rounded-md border border-ink/10 bg-white"
                title={
                  a.status === "error"
                    ? a.message
                    : a.status === "uploading"
                      ? `uploading ${a.name}…`
                      : a.name
                }
              >
                {a.kind === "image" && !a.previewUrl && a.status === "ready" ? (
                  <ChatImageThumb path={a.path} className="h-full w-full rounded-none" zoomable={false} />
                ) : a.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.previewUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-ink">
                    <svg
                      aria-hidden
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path
                        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
                        strokeLinejoin="round"
                      />
                      <path d="M14 3v5h5" strokeLinejoin="round" />
                    </svg>
                    <span className="w-full truncate text-center text-[8.5px] font-semibold uppercase leading-none">
                      {fileExt(a.name) || "doc"}
                    </span>
                  </div>
                )}
                {a.status === "uploading" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                    <svg
                      aria-hidden
                      viewBox="0 0 24 24"
                      className="h-5 w-5 animate-spin text-ink"
                      fill="none"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeOpacity="0.3"
                      />
                      <path
                        d="M21 12a9 9 0 0 0-9-9"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                )}
                {a.status === "error" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-red-500/40 text-[11px] font-medium text-white">
                    failed
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label="Remove attachment"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink/70 text-white hover:bg-ink"
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M6 18L18 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,video/mp4,.mp4,application/pdf,.pdf,.docx,.csv,.txt,.md,.markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,text/plain,text/markdown"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <ModeComposer
          borderless={agentSlug === "engineer" && !embedded}
          textareaRef={taRef}
          textareaProps={
            {
              "data-composer-input": "",
            } as never
          }
          disabled={dictationActive || disabled}
          dragOver={isDragOver}
          overlay={
            <>
              {menuOpen && totalMenuMatches > 0 ? (
                <SlashMenu
                  matches={menuMatches}
                  tenantMatches={menuTenantMatches}
                  cursor={menuCursor}
                  onSelect={selectCommand}
                />
              ) : mentionOpen && mentionMatches.length > 0 ? (
                <MentionMenu
                  sections={mentionSections}
                  cursor={menuCursor}
                  onSelect={selectMention}
                  connected={connectedSlugs}
                  hint={homeMentions && !mentionQuery ? "Type to filter, e.g. @meta" : undefined}
                />
              ) : null}
            </>
          }
          editor={
            mentionChip ? (
              <MentionComposerInput
                ref={mentionInputRef}
                value={value}
                position={mentionPosition}
                channel={mentionChip.kind === "channel" ? mentionChip.channel : undefined}
                label={mentionChip.name}
                icon={<MentionTargetIcon target={mentionChip} />}
                ariaLabel={composerAriaLabel}
                disabled={dictationActive || disabled}
                onChange={(next, position) => {
                  dispatchMention({ type: "position", position });
                  handleComposerChange(next);
                }}
                onRemove={removeMention}
                onSubmit={() => void fire()}
                onPasteFiles={handleFiles}
              />
            ) : undefined
          }
          value={value}
          onChange={handleComposerChange}
          onPaste={(e) => handleTextareaPaste(e, handleFiles)}
          onKeyDown={(e) => {
            const isComposing = (
              e.nativeEvent as KeyboardEvent & { isComposing?: boolean }
            ).isComposing;
            if (isComposing) return;

            if (menuOpen && totalMenuMatches > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuCursor((c) => Math.min(c + 1, totalMenuMatches - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuCursor((c) => Math.max(c - 1, 0));
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                if (menuCursor < menuMatches.length) {
                  const cmd = menuMatches[menuCursor];
                  if (cmd) selectCommand({ kind: "builtin", cmd });
                } else {
                  const idx = menuCursor - menuMatches.length;
                  const entry = menuTenantMatches[idx];
                  if (entry) selectCommand({ kind: "tenant", entry });
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setValue("");
                return;
              }
            }

            if (mentionOpen && mentionMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuCursor((c) =>
                  Math.min(c + 1, mentionMatches.length - 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuCursor((c) => Math.max(c - 1, 0));
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const picked = mentionMatches[menuCursor];
                if (picked) selectMention(picked);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const picked = mentionMatches[menuCursor];
                if (picked) selectMention(picked);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                const removed = removeActiveComposerMention(
                  value,
                  e.currentTarget.selectionStart,
                );
                setValue(removed.value);
                dispatchMention({ type: "caret", caret: removed.caret });
                requestAnimationFrame(() => {
                  taRef.current?.setSelectionRange(
                    removed.caret,
                    removed.caret,
                  );
                });
                return;
              }
            }

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void fire();
            }
          }}
          placeholder={
            (readOnlyRole ? "View-only access. Ask an admin to make you a member." : null) ??
            seededPlaceholder ??
            (mentionChip ? "" : null) ??
            placeholder ??
            `Message ${agentDisplayName(agentSlug)}…`
          }
          placeholderHints={
            !threadId &&
            !readOnlyRole &&
            !seededPlaceholder &&
            !mentionChip &&
            placeholder === undefined &&
            (agentSlug === "operator" || agentSlug === GROWTH_OFFICER_SLUG)
              ? (hintsOverride ?? ZAVI_COMPOSER_HINTS)
              : undefined
          }
          ariaLabel={
            composerAriaLabel
          }
          leading={
            !dictationActive ? (
              <>
                <ComposerPlusMenu
                  onAttach={() => fileInputRef.current?.click()}
                  onPickArtifact={(id, filename) => {
                    void attachExistingArtifact(id, filename);
                  }}
                  attaching={attachingArtifact}
                  repoEnabled={repoMenuEnabled}
                  role={role}
                  onManageRepos={goRepoSettings}
                  repoChipScope={repoChipScope}
                />
                {homeMentions && !mentionChip && !readOnlyRole && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={toggleAskMenu}
                    disabled={disabled}
                    aria-expanded={mentionOpen}
                    aria-label="Ask Your CGO, a channel or your team"
                    title="Bring in Your CGO, a channel or your team"
                    className={`ml-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[13px] font-normal transition-colors disabled:opacity-50 ${
                      mentionOpen
                        ? "border-ink text-ink"
                        : "border-rule text-inkMuted hover:border-ink/25 hover:text-ink"
                    }`}
                  >
                    <AtSign className="h-3.5 w-3.5" aria-hidden />
                    Ask
                  </button>
                )}
              </>
            ) : null
          }
          trailing={
            <>
              <MicButton
                onTranscript={applyDictation}
                onActiveChange={setDictationActive}
                compact
              />
              {!dictationActive &&
                (stopRunId ? (
                  <>
                    <StopComposerButton runId={stopRunId} onStop={onStopRun} />
                    {}
                    {bargeInOn && !sendDisabled && (
                      <SendButton fire={fire} disabled={sendDisabled} />
                    )}
                  </>
                ) : externalStop && !(externalStop.allowSend && (!sendDisabled || sending || inflight)) ? (
                  <ExternalStopComposerButton control={externalStop} />
                ) : externalRetry && !readOnlyRole && !value.trim() && attachments.length === 0 && fileRefs.length === 0 && !sending && !inflight ? (
                  <ExternalRetryComposerButton control={externalRetry} />
                ) : (
                  <SendButton
                    fire={fire}
                    disabled={sendDisabled}
                    busy={sending || inflight}
                  />
                ))}
            </>
          }
        />

        {}
        {}
        {homeMentions &&
          !threadId &&
          !shouldShowComposerHint(parseHint, mentionChip !== null) && (
            <p className="mt-2 pl-1 text-[12.5px] text-inkMuted">
              Growth questions go to Your CGO. It knows your plan.
            </p>
          )}
        {shouldShowComposerHint(parseHint, mentionChip !== null) && (
          <div className="mt-2.5 pl-1 text-[13px] font-medium tracking-[0.13px]">
            <span className="text-inkSoft">{parseHint}</span>
          </div>
        )}

        {}
        {creditError && !liftCreditWall && (
          <div
            role="alert"
            className="mt-2 flex items-center justify-between gap-3 pl-1 text-[13px] text-coral"
          >
            {}
            <span>
              {creditError}
              {!canManageBilling &&
                (creditErrorKind === "plan"
                  ? " Ask your workspace owner to upgrade the plan."
                  : " Ask your workspace owner to add credits.")}
            </span>
            {canManageBilling && (
              <button
                type="button"
                onClick={goUpgrade}
                className="shrink-0 rounded-cta border border-coral/40 px-2 py-1 font-sans text-[11px] font-semibold text-coral transition-colors hover:bg-coral/10"
              >
                {creditErrorKind === "plan" ? "See plans" : "Buy Credits"}
              </button>
            )}
          </div>
        )}
        {!creditError && (restoredAfterFail || error) && (
          <div role="alert" className="mt-2 pl-1 text-[13px] text-coral">
            {restoredAfterFail && serviceHealth === "down" ? (
              <>Zavi is having trouble right now. Your message is safe here, send it once Zavi is back.</>
            ) : restoredAfterFail && serviceHealth === "recovered" ? (
              <>
                Zavi is back. Press{" "}
                <kbd className="rounded border border-coral/40 px-1 py-px font-sans text-[11px]">
                  ⏎
                </kbd>{" "}
                to send your message.
              </>
            ) : restoredAfterFail ? (
              <>
                Couldn&apos;t send. Your message was restored below. Press{" "}
                <kbd className="rounded border border-coral/40 px-1 py-px font-sans text-[11px]">
                  ⏎
                </kbd>{" "}
                to try again.
                {error && error.trim() !== "" && (
                  <span className="ml-1 text-coral/70">({error})</span>
                )}
              </>
            ) : (
              error
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SendButton({
  fire,
  disabled,
  busy = false,
}: {
  fire: () => void;
  disabled: boolean;
  busy?: boolean;
}) {
  return (
    <SendCircle
      onClick={() => fire()}
      disabled={disabled}
      busy={busy}
      ariaLabel="Send message"
    />
  );
}

function StopComposerButton({
  runId,
  onStop,
}: {
  runId: string;
  onStop?: (runId: string) => void | (() => void);
}) {
  const [stopping, setStopping] = useState(false);
  function stop() {
    if (stopping) return;
    setStopping(true);
    const rollback = onStop?.(runId);
    void apiFetch(`/api/agents/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    }).catch(() => {
      if (typeof rollback === "function") rollback();
      setStopping(false);
    });
  }
  return (
    <SendCircle onClick={stop} disabled={stopping} ariaLabel="Stop this run">
      <span
        aria-hidden
        className="inline-block h-[13px] w-[13px] rounded-[3px] bg-current"
      />
    </SendCircle>
  );
}

function ExternalStopComposerButton({
  control,
}: {
  control: ExternalStopControl;
}) {
  const [stopping, setStopping] = useState(false);
  const busy = stopping || control.stopping === true;
  const stop = () => {
    if (busy) return;
    setStopping(true);
    void control.onStop().finally(() => setStopping(false));
  };
  return (
    <SendCircle onClick={stop} disabled={busy} ariaLabel={control.ariaLabel}>
      <span
        aria-hidden
        className="inline-block h-[13px] w-[13px] rounded-[3px] bg-current"
      />
    </SendCircle>
  );
}

function ExternalRetryComposerButton({
  control,
}: {
  control: ExternalRetryControl;
}) {
  const [retrying, setRetrying] = useState(false);
  const busy = retrying || control.retrying === true;
  const retry = () => {
    if (busy) return;
    setRetrying(true);
    void control
      .onRetry()
      .catch(() => undefined)
      .finally(() => setRetrying(false));
  };
  return (
    <SendCircle onClick={retry} busy={busy} ariaLabel={control.ariaLabel}>
      <RotateCw className="h-4 w-4 compact:h-5 compact:w-5" strokeWidth={2.5} aria-hidden />
    </SendCircle>
  );
}

"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Download, File, Lock, RotateCw, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { highlightCode, type CodeToken } from "@/lib/workspace/codeHighlight";
import { BUILD_REFINE_FINISHED_EVENT, type BuildRefineFinishedDetail } from "@/lib/workspace/useBuildSession";
import {
  hasCachedTokens,
  readCachedFile,
  readCachedTokens,
  readCachedTree,
  readCachedView,
  sameEntries,
  writeCachedFile,
  writeCachedTokens,
  writeCachedTree,
  writeCachedView,
  type CachedFile,
  type CachedTree,
  type CodeEntry,
} from "@/lib/workspace/appCodeCache";
import { cx, FOCUS_RING } from "../layout/shared";
import { CodeFileIcon, CodeFolderIcon } from "./codeFileIcon";

type Entry = CodeEntry;

type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | (CachedFile & { sha?: string });

type TreeState =
  | { status: "loading" }
  | { status: "empty"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; entries: Entry[]; truncated: boolean; branch: string; name: string };

const DEFAULT_FILES = [
  "README.md",
  "src/app/page.tsx",
  "src/routes/index.tsx",
  "src/App.tsx",
  "src/main.tsx",
  "app/page.tsx",
  "index.html",
  "package.json",
];

export function pickDefaultFile(entries: Entry[]): string | null {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
  return DEFAULT_FILES.find((path) => files.has(path)) ?? null;
}

export function parentDirs(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-[#f5d565]/60 text-ink">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export type CodeNode = { name: string; path: string; type: "file" | "dir"; children: CodeNode[] };

export function buildCodeTree(entries: Entry[]): CodeNode[] {
  const root: CodeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, CodeNode>([["", root]]);
  const ensureDir = (path: string): CodeNode => {
    const found = dirs.get(path);
    if (found) return found;
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut === -1 ? "" : path.slice(0, cut));
    const node: CodeNode = { name: path.slice(cut + 1), path, type: "dir", children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };
  for (const entry of entries) {
    if (entry.type === "dir") ensureDir(entry.path);
  }
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const cut = entry.path.lastIndexOf("/");
    const parent = ensureDir(cut === -1 ? "" : entry.path.slice(0, cut));
    parent.children.push({ name: entry.path.slice(cut + 1), path: entry.path, type: "file", children: [] });
  }
  const sort = (node: CodeNode) => {
    node.children.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export function closeTab(open: string[], active: string | null, path: string): { open: string[]; active: string | null } {
  const index = open.indexOf(path);
  if (index === -1) return { open, active };
  const next = open.filter((p) => p !== path);
  if (active !== path) return { open: next, active };
  return { open: next, active: next[Math.min(index, next.length - 1)] ?? null };
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function downloadText(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "file.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onOpen,
}: {
  node: CodeNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const open = expanded.has(node.path);
  const isDir = node.type === "dir";
  const active = node.path === selected;
  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={active}>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(node.path) : onOpen(node.path))}
        style={{ paddingLeft: 6 + depth * 12 }}
        className={cx(
          "relative flex h-[22px] w-full items-center gap-2 pr-2 text-left text-[13px] leading-[22px]",
          active ? "bg-bone text-ink" : "text-inkSoft hover:bg-bone/60 hover:text-ink",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink/40",
        )}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute inset-y-0 w-px bg-rule"
            style={{ left: 13 + i * 12 }}
          />
        ))}
        {isDir ? (
          <ChevronRight
            aria-hidden
            className={cx("h-3.5 w-3.5 shrink-0 text-inkMuted transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")}
          />
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden />
        )}
        {isDir ? <CodeFolderIcon open={open} /> : <CodeFileIcon path={node.path} />}
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {isDir && open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CodeView({
  path,
  sha,
  content,
  activeLine,
  onLine,
}: {
  path: string;
  sha?: string;
  content: string;
  activeLine: number;
  onLine: (line: number) => void;
}) {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(() => readCachedTokens(path, sha));
  useEffect(() => {
    if (hasCachedTokens(path, sha)) {
      setTokens(readCachedTokens(path, sha));
      return;
    }
    let live = true;
    setTokens(null);
    void highlightCode(content, path).then((result) => {
      if (result) writeCachedTokens(path, sha, result);
      if (live) setTokens(result);
    });
    return () => {
      live = false;
    };
  }, [content, path, sha]);
  const lines = useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);
  const gutter = String(lines.length).length;

  return (
    <div className="ws-scroll h-full overflow-auto bg-cream animate-code-fade motion-reduce:animate-none">
      <pre className="min-w-max py-1 font-mono text-[13px] leading-[20px] text-ink [tab-size:2]">
        {lines.map((line, index) => (
          <CodeLine
            key={index}
            number={index + 1}
            text={line}
            tokens={tokens?.[index]}
            current={index + 1 === activeLine}
            gutter={gutter}
            onLine={onLine}
          />
        ))}
      </pre>
    </div>
  );
}

const CodeLine = memo(function CodeLine({
  number,
  text,
  tokens,
  current,
  gutter,
  onLine,
}: {
  number: number;
  text: string;
  tokens: CodeToken[] | undefined;
  current: boolean;
  gutter: number;
  onLine: (line: number) => void;
}) {
  return (
    <div
      onMouseDown={() => onLine(number)}
      className={cx("flex", current && "bg-bone/60 shadow-[inset_0_1px_0_rgb(var(--c-rule)),inset_0_-1px_0_rgb(var(--c-rule))]")}
    >
      <span
        aria-hidden
        className={cx(
          "sticky left-0 shrink-0 select-none bg-cream pl-5 pr-6 text-right",
          current ? "text-ink" : "text-inkLight",
        )}
        style={{ minWidth: `${gutter + 5}ch` }}
      >
        {number}
      </span>
      <code className="pr-8">
        {tokens
          ? tokens.map((token, i) => (
              <span
                key={i}
                className="code-token"
                style={{ "--tok-light": token.light, "--tok-dark": token.dark } as CSSProperties}
              >
                {token.content}
              </span>
            ))
          : text || " "}
        {tokens && tokens.length === 0 ? " " : null}
      </code>
    </div>
  );
});

function Notice({ children, alert }: { children: React.ReactNode; alert?: boolean }) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className="flex h-full items-center justify-center bg-cream px-6 text-center text-[13px] text-inkMuted"
    >
      {children}
    </div>
  );
}

function shaIn(tree: TreeState, path: string): string | undefined {
  return tree.status === "ready" ? tree.entries.find((e) => e.path === path)?.sha : undefined;
}

function restoredFiles(scope: string | null | undefined, tabs: string[]): Record<string, FileState> {
  const cachedTree = readCachedTree(scope);
  const out: Record<string, FileState> = {};
  if (!cachedTree) return out;
  for (const path of tabs) {
    const sha = cachedTree.entries.find((e) => e.path === path)?.sha;
    const cached = readCachedFile(sha);
    if (cached) out[path] = { ...cached, sha };
  }
  return out;
}

export function ReadOnlyBadge() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const noteId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-describedby={open ? noteId : undefined}
        className={cx(
          "inline-flex shrink-0 items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[12px] font-medium text-inkMuted transition-colors hover:text-ink",
          FOCUS_RING,
        )}
      >
        <Lock className="h-3 w-3" aria-hidden />
        Read only
      </button>
      {open && (
        <span
          id={noteId}
          role="tooltip"
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-[280px] rounded-xl border border-rule bg-cream p-3 text-left shadow-pop animate-code-fade motion-reduce:animate-none"
        >
          <span className="block text-[13px] font-semibold text-ink">Why can&apos;t I edit here?</span>
          <span className="mt-1 block text-[13px] leading-5 text-inkMuted">
            This is your app&apos;s code exactly as it runs. Changes go through Zavi so every edit is
            checked, saved and kept in sync with your live app. Describe what you want in the chat
            and Zavi updates the code for you.
          </span>
        </span>
      )}
    </span>
  );
}

function readyTree(tree: TreeState): CachedTree | null {
  return tree.status === "ready"
    ? { entries: tree.entries, truncated: tree.truncated, branch: tree.branch, name: tree.name }
    : null;
}

export function codeSessionQuery(sessionId: string | null | undefined): string {
  return sessionId ? `build_session_id=${encodeURIComponent(sessionId)}` : "app=workspace";
}

export function AppCodePane({
  scope,
  active: paneActive = true,
  sessionId = null,
}: { scope?: string | null; active?: boolean; sessionId?: string | null } = {}) {
  const sessionQuery = codeSessionQuery(sessionId);
  const sessionQueryRef = useRef(sessionQuery);
  sessionQueryRef.current = sessionQuery;
  const [tree, setTree] = useState<TreeState>(() => {
    const cached = readCachedTree(scope);
    return cached ? { status: "ready", ...cached } : { status: "loading" };
  });
  const [attempt, setAttempt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const paneActiveRef = useRef(paneActive);
  paneActiveRef.current = paneActive;
  const staleRef = useRef(false);
  const seenRefinesRef = useRef(new Set<string>());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readCachedView(scope)?.expanded ?? []));
  const [query, setQuery] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>(() => readCachedView(scope)?.openTabs ?? []);
  const [active, setActive] = useState<string | null>(() => readCachedView(scope)?.active ?? null);
  const [files, setFiles] = useState<Record<string, FileState>>(() =>
    restoredFiles(scope, readCachedView(scope)?.openTabs ?? []),
  );
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const filesRef = useRef(files);
  filesRef.current = files;
  const [activeLine, setActiveLine] = useState(1);
  const [pendingDefault, setPendingDefault] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requests = useRef(new Map<string, AbortController>());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const cached = attempt === 0 ? readCachedTree(scope) ?? readyTree(treeRef.current) : null;
    if (!cached) setTree({ status: "loading" });
    void (async () => {
      try {
        const res = await apiFetch(`/api/workspace/app-code/tree${sessionQuery ? `?${sessionQuery}` : ""}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.status === 409) {
          setTree({ status: "empty", message: await errorMessage(res, "No app code yet.") });
          return;
        }
        if (!res.ok) {
          if (!cached) setTree({ status: "error", message: await errorMessage(res, "Could not load the code.") });
          return;
        }
        const body = (await res.json()) as { entries?: Entry[]; truncated?: boolean; branch?: string; name?: string };
        if (controller.signal.aborted) return;
        const next = {
          entries: body.entries ?? [],
          truncated: !!body.truncated,
          branch: body.branch ?? "main",
          name: body.name ?? "",
        };
        writeCachedTree(scope, next);
        if (
          cached &&
          sameEntries(cached.entries, next.entries) &&
          cached.truncated === next.truncated &&
          cached.branch === next.branch &&
          cached.name === next.name
        ) {
          return;
        }
        setTree({ status: "ready", ...next });
        if (cached) return;
        setExpanded(new Set(next.entries.filter((e) => e.type === "dir" && !e.path.includes("/")).map((e) => e.path)));
        setPendingDefault(pickDefaultFile(next.entries));
      } catch {
        if (!controller.signal.aborted && !cached) setTree({ status: "error", message: "Could not load the code." });
      }
    })();
    return () => controller.abort();
  }, [attempt, scope, refresh, sessionQuery]);

  useEffect(() => {
    const onFinished = (event: Event) => {
      const refineId = (event as CustomEvent<BuildRefineFinishedDetail>).detail?.refineId;
      if (!refineId || seenRefinesRef.current.has(refineId)) return;
      seenRefinesRef.current.add(refineId);
      if (paneActiveRef.current) setRefresh((n) => n + 1);
      else staleRef.current = true;
    };
    window.addEventListener(BUILD_REFINE_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(BUILD_REFINE_FINISHED_EVENT, onFinished);
  }, []);

  useEffect(() => {
    if (!paneActive || !staleRef.current) return;
    staleRef.current = false;
    setRefresh((n) => n + 1);
  }, [paneActive]);

  useEffect(() => {
    writeCachedView(scope, { openTabs, active, expanded: [...expanded] });
  }, [scope, openTabs, active, expanded]);

  useEffect(() => {
    const pending = requests.current;
    return () => {
      pending.forEach((controller) => controller.abort());
      pending.clear();
    };
  }, []);

  const load = useCallback(async (path: string) => {
    const sha = shaIn(treeRef.current, path);
    const cached = readCachedFile(sha);
    if (cached) {
      requests.current.get(path)?.abort();
      requests.current.delete(path);
      setFiles((prev) => ({ ...prev, [path]: { ...cached, sha } }));
      return;
    }
    const controller = new AbortController();
    requests.current.set(path, controller);
    setFiles((prev) => ({ ...prev, [path]: { status: "loading" } }));
    const settle = (state: FileState) => {
      if (controller.signal.aborted || requests.current.get(path) !== controller) return;
      requests.current.delete(path);
      setFiles((prev) => ({ ...prev, [path]: state }));
    };
    try {
      const sq = sessionQueryRef.current;
      const res = await apiFetch(`/api/workspace/app-code/file?path=${encodeURIComponent(path)}${sq ? `&${sq}` : ""}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        settle({ status: "error", message: await errorMessage(res, "Could not open this file.") });
        return;
      }
      const body = (await res.json()) as { kind: "text" | "binary" | "too_large"; content?: string };
      const loaded: CachedFile =
        body.kind === "text" ? { status: "text", content: body.content ?? "" } : { status: body.kind };
      if (!controller.signal.aborted && requests.current.get(path) === controller) writeCachedFile(sha, loaded);
      settle({ ...loaded, sha });
    } catch {
      settle({ status: "error", message: "Could not open this file." });
    }
  }, []);

  const openFile = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const dirs = parentDirs(path).filter((dir) => !prev.has(dir));
        return dirs.length === 0 ? prev : new Set([...prev, ...dirs]);
      });
      setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setActive(path);
      setActiveLine(1);
      const state = files[path];
      if (!state || state.status === "error") void load(path);
    },
    [files, load],
  );

  const close = useCallback(
    (path: string) => {
      requests.current.get(path)?.abort();
      requests.current.delete(path);
      const next = closeTab(openTabs, active, path);
      setOpenTabs(next.open);
      setActive(next.active);
      setActiveLine(1);
      setFiles((prev) => {
        const { [path]: _gone, ...rest } = prev;
        return rest;
      });
    },
    [openTabs, active],
  );

  useEffect(() => {
    if (tree.status !== "ready" || tree.truncated) return;
    const present = new Set(tree.entries.filter((e) => e.type === "file").map((e) => e.path));
    const gone = openTabs.filter((path) => !present.has(path));
    if (gone.length === 0) return;
    for (const path of gone) {
      requests.current.get(path)?.abort();
      requests.current.delete(path);
    }
    const next = gone.reduce((acc, path) => closeTab(acc.open, acc.active, path), { open: openTabs, active });
    setOpenTabs(next.open);
    if (next.active !== active) {
      setActive(next.active);
      setActiveLine(1);
    }
    setFiles((prev) => {
      const rest = { ...prev };
      for (const path of gone) delete rest[path];
      return rest;
    });
  }, [tree, openTabs, active]);

  useEffect(() => {
    if (tree.status !== "ready") return;
    const present = tree.truncated ? null : new Set(tree.entries.map((e) => e.path));
    for (const path of openTabs) {
      if (present && !present.has(path)) continue;
      const state = filesRef.current[path];
      const sha = tree.entries.find((e) => e.path === path)?.sha;
      if (!state) {
        void load(path);
      } else if (sha && state.status !== "loading" && state.status !== "error" && state.sha !== sha) {
        void load(path);
      }
    }
  }, [tree, openTabs, load]);

  useEffect(() => {
    if (!pendingDefault) return;
    setPendingDefault(null);
    openFile(pendingDefault);
  }, [pendingDefault, openFile]);

  useEffect(() => {
    if (!paneActive) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneActive]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const nodes = useMemo(() => (tree.status === "ready" ? buildCodeTree(tree.entries) : []), [tree]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || tree.status !== "ready") return null;
    return tree.entries.filter((e) => e.type === "file" && e.path.toLowerCase().includes(q));
  }, [query, tree]);

  if (tree.status === "loading") {
    return (
      <div role="status" aria-busy="true" className="flex h-full bg-cream">
        <div className="w-[248px] shrink-0 space-y-2 border-r border-rule bg-creamDeep p-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-3.5 animate-pulse rounded bg-bone" style={{ width: `${50 + ((i * 17) % 40)}%` }} />
          ))}
        </div>
        <span className="sr-only">Loading code…</span>
      </div>
    );
  }

  if (tree.status !== "ready") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-cream px-6 text-center">
        <File className="h-8 w-8 text-inkMuted" strokeWidth={1.5} aria-hidden />
        <p className="text-[14px] font-semibold text-ink">
          {tree.status === "empty" ? "No code yet" : "Could not load the code"}
        </p>
        <p className="max-w-sm text-[13px] leading-5 text-inkMuted">{tree.message}</p>
        {tree.status === "error" && (
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className={cx(
              "inline-flex h-8 items-center gap-2 rounded-cta border border-rule px-3 text-[13px] font-medium text-ink hover:bg-bone",
              FOCUS_RING,
            )}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
        )}
      </div>
    );
  }

  const file = active ? files[active] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream">
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Explorer"
          className="flex max-h-56 shrink-0 flex-col border-b border-rule bg-creamDeep md:max-h-none md:w-[248px] md:border-b-0 md:border-r"
        >
          <div className="flex shrink-0 items-center gap-2 p-2">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Search code</span>
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkMuted" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                  if (e.key === "Enter" && matches && matches[0]) {
                    openFile(matches[0].path);
                    setQuery("");
                  }
                }}
                placeholder="Search code"
                className="h-8 w-full rounded-full border border-rule bg-cream pl-7 pr-9 text-[13px] text-ink placeholder:text-inkLight focus:border-ink/40 focus:outline-none"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-[11px] text-inkLight">
                ⌘P
              </kbd>
            </label>
            <button
              type="button"
              onClick={() =>
                setExpanded(
                  expanded.size > 0
                    ? new Set()
                    : new Set(tree.entries.filter((e) => e.type === "dir").map((e) => e.path)),
                )
              }
              aria-label={expanded.size > 0 ? "Collapse folders" : "Expand folders"}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/40"
            >
              {expanded.size > 0 ? (
                <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          </div>
          <div className="ws-scroll min-h-0 flex-1 overflow-y-auto pb-2">
            {matches ? (
              matches.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-inkMuted">No files match.</p>
              ) : (
                <ul role="listbox" aria-label="Matching files">
                  {matches.map((m) => (
                    <li key={m.path}>
                      <button
                        type="button"
                        onClick={() => openFile(m.path)}
                        aria-label={m.path}
                        className={cx(
                          "flex h-[22px] w-full items-center gap-2 px-3 text-left text-[13px]",
                          m.path === active ? "bg-bone text-ink" : "text-inkSoft hover:bg-bone/60 hover:text-ink",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink/40",
                        )}
                      >
                        <CodeFileIcon path={m.path} />
                        <span className="min-w-0 truncate">
                          <Highlighted text={m.path} query={query.trim()} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ul role="tree" aria-label="App files">
                {nodes.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    expanded={expanded}
                    selected={active}
                    onToggle={toggle}
                    onOpen={openFile}
                  />
                ))}
              </ul>
            )}
            {tree.truncated && (
              <p className="px-4 pt-2 text-[12px] text-inkMuted">Large repo: some files are not listed.</p>
            )}
          </div>
        </nav>

        <section aria-label={active ?? "Editor"} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {openTabs.length > 0 && (
            <div className="flex h-10 shrink-0 items-stretch border-b border-rule bg-creamDeep">
            <div role="tablist" aria-label="Open files" className="ws-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto">
              {openTabs.map((path) => {
                const selected = path === active;
                return (
                  <div
                    key={path}
                    className={cx(
                      "group relative flex shrink-0 items-center border-r border-rule",
                      selected ? "bg-cream text-ink" : "text-inkMuted hover:bg-cream/60",
                    )}
                  >
                    {selected && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-ink" />}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => {
                        setActive(path);
                        setActiveLine(1);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) close(path);
                      }}
                      className="flex h-full items-center gap-2 pl-3 pr-1 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink/40"
                    >
                      <CodeFileIcon path={path} />
                      <span className="max-w-[240px] truncate">{path}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => close(path)}
                      aria-label={`Close ${path}`}
                      className={cx(
                        "mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-inkMuted hover:bg-bone hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/40",
                        selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center gap-1 border-l border-rule px-2">
              {file?.status === "text" && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(file.content).then(() => setCopied(true));
                    }}
                    aria-label={copied ? "Copied" : "Copy file"}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/40"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadText(active ?? "file.txt", file.content)}
                    aria-label="Download file"
                    title="Download file"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/40"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </>
              )}
            </div>
            </div>
          )}

          <div className="min-h-0 flex-1">
            {!active || !file ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 bg-cream px-6 text-center">
                <p className="text-[13px] text-inkMuted">Pick a file in the Explorer to read its code.</p>
                <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-2 text-[13px] text-inkMuted">
                  <dt className="text-right">Go to file</dt>
                  <dd className="text-left">
                    <kbd className="rounded border border-rule bg-creamDeep px-1.5 py-0.5 font-sans text-[11px]">⌘ P</kbd>
                  </dd>
                  <dt className="text-right">Close tab</dt>
                  <dd className="text-left">
                    <kbd className="rounded border border-rule bg-creamDeep px-1.5 py-0.5 font-sans text-[11px]">Middle click</kbd>
                  </dd>
                </dl>
              </div>
            ) : file.status === "loading" ? (
              <div role="status" className="h-full space-y-2 bg-cream p-4">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="h-3 animate-pulse rounded bg-bone" style={{ width: `${30 + ((i * 23) % 55)}%` }} />
                ))}
                <span className="sr-only">Loading file…</span>
              </div>
            ) : file.status === "text" ? (
              <CodeView key={active} path={active} sha={file.sha} content={file.content} activeLine={activeLine} onLine={setActiveLine} />
            ) : file.status === "error" ? (
              <Notice alert>{file.message}</Notice>
            ) : (
              <Notice>
                {file.status === "binary"
                  ? "This is a binary file, so there is no code to show."
                  : "This file is too large to show here."}
              </Notice>
            )}
          </div>
        </section>
      </div>

    </div>
  );
}

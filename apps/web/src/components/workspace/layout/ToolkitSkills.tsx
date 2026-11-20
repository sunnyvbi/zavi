"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { BadgeCheck, Plus, Search, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { SkeletonSkillGrid } from "../Skeleton";
import { useWorkspace } from "../WorkspaceShell";
import { useIsCompact } from "@/lib/responsive";
import { cx, FOCUS_RING } from "./shared";
import { UploadSkillDialog } from "./UploadSkillDialog";
import {
  checkSkillFile,
  parseSkillFile,
  normalizeTagInput,
  SKILL_FILE_ACCEPT,
  SKILL_MAX_TITLE_CHARS,
  type ParsedSkill,
} from "./skillFile";

type SkillRow = {
  id: string;
  title: string;
  body_markdown: string;
  source: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};

type SkillDraft = {
  id: string | null;
  title: string;
  body_markdown: string;
  tags: string;
  baseline: { title: string; body: string; tags: string[] } | null;
};

const field =
  "w-full rounded-xl border border-rule bg-creamDeep px-3.5 py-2.5 text-[16px] text-ink outline-none transition-colors placeholder:text-inkLight focus:border-ink";

function previewOf(body: string): string {
  const text = body.replace(/\r\n/g, "\n").replace(/^[ \t\n]*/, "");
  const withoutFrontmatter = text.replace(
    /^---[ \t]*\n[\s\S]*?\n---[ \t]*(\n|$)/,
    "",
  );
  return withoutFrontmatter
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join("\n")
    .replace(/^[\s]+/, "")
    .trim();
}

export type ToolkitSkillsHandle = {
  startCreate: () => void;
  startUpload: () => void;
};

export const ToolkitSkills = forwardRef<ToolkitSkillsHandle>(
  function ToolkitSkills(_props, ref) {
    const { role } = useWorkspace();
    const canEdit = role !== "member";
    const [rows, setRows] = useState<SkillRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<SkillRow | null>(null);
    const [draft, setDraft] = useState<SkillDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState<string | null>(null);
    const [dialog, setDialog] = useState<"upload" | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const compact = useIsCompact();

    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setErrorMsg(null);
      apiFetch("/api/memory/notes?note_type=skill&authored=operator")
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          if (j.error) setErrorMsg(j.error.message ?? "load failed");
          else setRows((j.notes ?? []) as SkillRow[]);
          setLoading(false);
        })
        .catch((e) => {
          if (!cancelled) {
            setErrorMsg((e as Error).message);
            setLoading(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }, [reloadKey]);

    const draftRef = useRef<SkillDraft | null>(draft);
    draftRef.current = draft;

    const closeDraft = useCallback(() => {
      setDraft(null);
      setSaveErr(null);
    }, []);

    const savingRef = useRef(saving);
    savingRef.current = saving;

    const isDraftOpen = draft !== null;

    useEffect(() => {
      if (!isDraftOpen) return;
      const returnFocusTo = document.activeElement as HTMLElement | null;
      const dialog = dialogRef.current;

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          if (!savingRef.current) closeDraft();
          return;
        }
        if (e.key !== "Tab" || !dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeInside = dialog.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !activeInside)) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || !activeInside)
        ) {
          e.preventDefault();
          first.focus();
        }
      };

      document.addEventListener("keydown", onKeyDown);
      titleInputRef.current?.focus();
      return () => {
        document.removeEventListener("keydown", onKeyDown);
        returnFocusTo?.focus?.();
      };
    }, [isDraftOpen, closeDraft]);

    const isDirty = useMemo(() => {
      if (!draft) return false;
      if (!draft.baseline) return true;
      const tags = normalizeTagInput(draft.tags);
      return (
        draft.title.trim() !== draft.baseline.title ||
        draft.body_markdown.trim() !== draft.baseline.body ||
        tags.length !== draft.baseline.tags.length ||
        tags.some((t, i) => t !== draft.baseline!.tags[i])
      );
    }, [draft]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body_markdown.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }, [rows, query]);

    const listed = useMemo(
      () =>
        open && !draft ? filtered.filter((n) => n.id !== open.id) : filtered,
      [filtered, open, draft],
    );

    const patchDraft = useCallback((patch: Partial<SkillDraft>) => {
      setSaveErr(null);
      setDraft((d) => (d ? { ...d, ...patch } : d));
    }, []);

    const startCreate = useCallback(() => {
      setDialog(null);
      setOpen(null);
      setSaveErr(null);
      setDraft({
        id: null,
        title: "",
        body_markdown: "",
        tags: "",
        baseline: null,
      });
    }, []);

    const startUpload = useCallback(() => {
      setOpen(null);
      setSaveErr(null);
      setDraft(null);
      setDialog("upload");
    }, []);

    useImperativeHandle(
      ref,
      () => ({ startCreate, startUpload }),
      [startCreate, startUpload],
    );

    const fillFromFile = useCallback(async (file: File) => {
      const fileErr = checkSkillFile({ name: file.name, size: file.size });
      if (fileErr) {
        setSaveErr(fileErr);
        return;
      }
      let raw: string;
      try {
        raw = await file.text();
      } catch (e) {
        setSaveErr(`Couldn't read that file: ${(e as Error).message}`);
        return;
      }
      const parsed = parseSkillFile(file.name, raw);
      if (!parsed.ok) {
        setSaveErr(parsed.error);
        return;
      }
      const typed = draftRef.current;
      const hasTypedWork = Boolean(
        typed?.title.trim() ||
        typed?.body_markdown.trim() ||
        typed?.tags.trim(),
      );
      if (
        hasTypedWork &&
        !confirm("Replace what's in the form with this file?")
      )
        return;
      setSaveErr(null);
      setDraft((d) => ({
        id: d?.id ?? null,
        baseline: d?.baseline ?? null,
        title: parsed.skill.title,
        body_markdown: parsed.skill.body_markdown,
        tags: parsed.skill.tags.join(", "),
      }));
    }, []);

    const handleSave = useCallback(async () => {
      if (!draft || savingRef.current) return;
      const body = draft.body_markdown.trim();
      if (!body) {
        setSaveErr(
          "A skill needs a description. Describe how the company does this.",
        );
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setSaveErr(null);
      const tags = normalizeTagInput(draft.tags);
      try {
        const res = await apiFetch("/api/memory/notes", {
          method: "POST",
          body: JSON.stringify({
            ...(draft.id ? { id: draft.id } : {}),
            note_type: "skill",
            title: draft.title.trim(),
            body_markdown: body,
            tags,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setSaveErr(j?.error?.message ?? res.statusText);
          savingRef.current = false;
          setSaving(false);
          return;
        }
        setDraft(null);
        setOpen(null);
        savingRef.current = false;
        setSaving(false);
        setReloadKey((k) => k + 1);
      } catch (e) {
        setSaveErr((e as Error).message);
        savingRef.current = false;
        setSaving(false);
      }
    }, [draft]);

    const commitParsedSkill = useCallback(
      async (
        skill: ParsedSkill,
      ): Promise<{ ok: true } | { ok: false; error: string }> => {
        try {
          const res = await apiFetch("/api/memory/notes", {
            method: "POST",
            body: JSON.stringify({
              note_type: "skill",
              title: skill.title.trim(),
              body_markdown: skill.body_markdown,
              tags: skill.tags,
            }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            return { ok: false, error: j?.error?.message ?? res.statusText };
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      [],
    );

    const handleDelete = useCallback(async (id: string) => {
      if (!confirm("Delete this skill? This can't be undone.")) return;
      try {
        const res = await apiFetch(`/api/memory/notes/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert(`Delete failed: ${j?.error?.message ?? res.statusText}`);
          return;
        }
        setOpen(null);
        setReloadKey((k) => k + 1);
      } catch (e) {
        alert(`Delete failed: ${(e as Error).message}`);
      }
    }, []);

    const editorActions = draft && (
      <div
        className={cx(
          "flex items-center gap-2 border-t border-rule px-4 py-4",
          compact && "border-t-0 px-0 pb-0 pt-1",
        )}
      >
        <button
          type="button"
          disabled={saving || !isDirty}
          title={!isDirty ? "No changes to save" : undefined}
          onClick={handleSave}
          className={cx(
            "rounded-full border border-transparent bg-ink px-4 py-2 text-[13px] font-medium text-cream hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 compact:min-h-[40px]",
            FOCUS_RING,
          )}
        >
          {saving ? "Saving…" : draft.id ? "Save changes" : "Create skill"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={closeDraft}
          className={cx(
            "rounded-full border border-rule px-4 py-2 text-[13px] font-medium text-ink hover:bg-bone disabled:opacity-50 compact:min-h-[40px]",
            FOCUS_RING,
          )}
        >
          Cancel
        </button>
      </div>
    );

    const editor = draft && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(11,11,12,0.55)] px-4 py-8 backdrop-blur-sm compact:px-3 compact:py-4"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && !saving) closeDraft();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={draft.id ? "Edit skill" : "New skill"}
          className="flex max-h-full w-full max-w-[560px] animate-pop-in flex-col overflow-hidden rounded-2xl border border-rule bg-cream shadow-[0_24px_64px_-16px_rgba(0,0,0,0.5),0_2px_10px_rgba(0,0,0,0.16)] ring-1 ring-white/[0.05] motion-reduce:animate-none"
        >
          <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-4 compact:px-4 compact:pb-3 compact:pt-4">
            <div>
              <h3 className="text-[16px] font-medium text-ink">
                {draft.id ? "Edit skill" : "New skill"}
              </h3>
              <p className="mt-1 text-[13px] leading-[1.5] text-inkLight">
                Every agent reads this when the task comes up.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              disabled={saving}
              onClick={closeDraft}
              className={cx(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkLight hover:bg-bone hover:text-ink disabled:opacity-50 compact:h-10 compact:w-10",
                FOCUS_RING,
              )}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4 compact:px-4 compact:py-3">
            <input
              ref={titleInputRef}
              type="text"
              maxLength={SKILL_MAX_TITLE_CHARS}
              value={draft.title}
              onChange={(e) => patchDraft({ title: e.target.value })}
              aria-label="Skill title"
              placeholder="e.g. How we handle a refund request"
              className={field}
            />
            <textarea
              value={draft.body_markdown}
              onChange={(e) => patchDraft({ body_markdown: e.target.value })}
              aria-label="What the skill is"
              rows={8}
              placeholder="Describe the procedure in your own words: the steps, the judgement calls, what to do when it goes wrong."
              className={cx(field, "resize-y leading-[1.55]")}
            />
            <input
              type="text"
              value={draft.tags}
              onChange={(e) => patchDraft({ tags: e.target.value })}
              aria-label="Tags"
              placeholder="Tags: refunds, support, policy"
              className={field}
            />
            <div>
              <button
                type="button"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
                className={cx(
                  "inline-flex items-center gap-2 rounded-full border border-rule px-3.5 py-1.5 text-[13px] font-medium text-inkMuted hover:bg-bone hover:text-ink disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Fill from a markdown file
              </button>
            </div>
            {saveErr && (
              <p role="alert" className="text-[13px] text-danger">
                {saveErr}
              </p>
            )}
            {compact && editorActions}
          </div>

          {!compact && editorActions}
        </div>
      </div>
    );

    const detail = open && !draft && (
      <div className="rounded-2xl border border-rule bg-cream p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="min-w-0 break-words text-[16px] font-medium text-ink">
              {open.title || "Untitled skill"}
            </h3>
            <p className="mt-1 text-[12px] text-inkLight">
              Updated {new Date(open.updated_at).toLocaleDateString()}
              {open.tags.length > 0 && ` · ${open.tags.join(", ")}`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close skill"
            onClick={() => setOpen(null)}
            className={cx(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkLight hover:bg-bone hover:text-ink",
              FOCUS_RING,
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <pre className="mt-4 whitespace-pre-wrap font-sans text-[16px] leading-[1.6] text-ink">
          {open.body_markdown}
        </pre>
        {canEdit && (
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSaveErr(null);
                setDraft({
                  id: open.id,
                  title: open.title,
                  body_markdown: open.body_markdown,
                  tags: open.tags.join(", "),
                  baseline: {
                    title: open.title.trim(),
                    body: open.body_markdown.trim(),
                    tags: normalizeTagInput(open.tags.join(", ")),
                  },
                });
              }}
              className={cx(
                "rounded-full border border-rule px-4 py-1.5 text-[13px] font-medium text-ink hover:bg-bone",
                FOCUS_RING,
              )}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => handleDelete(open.id)}
              className={cx(
                "rounded-full border border-rule px-4 py-1.5 text-[13px] font-medium text-danger hover:bg-bone",
                FOCUS_RING,
              )}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    );

    return (
      <div className="mx-auto w-full max-w-[1080px] px-8 py-8 compact:px-4 compact:py-4">
        <input
          ref={fileInputRef}
          type="file"
          accept={SKILL_FILE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void fillFromFile(file);
          }}
        />

        <div>
          <h1 className="text-[28px] font-medium leading-tight tracking-[-0.01em] text-ink compact:text-[20px]">
            Skills
          </h1>
          <p className="mt-2 text-[16px] leading-[1.5] text-inkMuted compact:mt-1 compact:text-[14px]">
            Skills help you create outcomes with repeatability.
          </p>
        </div>

        <div className="mt-6 flex h-12 items-center gap-3 rounded-full border border-rule bg-creamDeep px-4 transition-colors duration-150 focus-within:border-ink/40 motion-reduce:transition-none compact:mt-4 compact:h-11 compact:px-4">
          <Search className="h-4 w-4 shrink-0 text-inkLight" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for skills"
            aria-label="Search skills"
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-inkLight"
          />
        </div>

        <h2 className="mt-8 text-[16px] font-medium text-ink compact:mt-6 compact:text-[14px]">Active Skills</h2>

        <div className="mt-4 flex flex-col gap-5 compact:mt-3 compact:gap-4">
          {detail}

          {loading && <SkeletonSkillGrid />}
          {errorMsg && (
            <p className="text-[13px] text-danger">
              Couldn&apos;t load skills: {errorMsg}
            </p>
          )}

          {!loading && !errorMsg && rows.length === 0 && (
            <div className="rounded-2xl border border-dashed border-rule px-6 py-14 text-center compact:px-4 compact:py-9">
              <p className="mx-auto max-w-md text-[16px] leading-[1.6] text-inkMuted">
                <span className="font-medium text-ink">Skills</span> are short
                write-ups of how your company does a recurring task: refunds,
                onboarding a host, qualifying a lead. Every agent reads them, so
                writing one teaches the whole fleet at once.
              </p>
              {canEdit && (
                <button
                  type="button"
                  onClick={startCreate}
                  className={cx(
                    "mt-5 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-cream hover:opacity-90",
                    FOCUS_RING,
                  )}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Write your first skill
                </button>
              )}
            </div>
          )}

          {!loading &&
            !errorMsg &&
            filtered.length === 0 &&
            rows.length > 0 && (
              <p className="py-10 text-center text-[13px] text-inkMuted">
                No skills match this search.
              </p>
            )}

          {!loading && !errorMsg && listed.length > 0 && (
            <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 compact:gap-4">
              {listed.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(n)}
                    className={cx(
                      "flex h-full min-h-[168px] w-full flex-col rounded-2xl border border-rule bg-cream p-[22px] text-left transition-colors duration-150 hover:border-ink/25 motion-reduce:transition-none",
                      FOCUS_RING,
                    )}
                  >
                    <span className="min-w-0 break-words text-[16px] font-medium text-ink">
                      {n.title || "Untitled skill"}
                    </span>
                    <span className="mt-2.5 line-clamp-2 text-[16px] leading-[1.55] text-inkMuted">
                      {previewOf(n.body_markdown)}
                    </span>
                    <span className="mt-auto flex items-center justify-between pt-4">
                      <span className="flex items-center gap-2 text-[13px] text-inkMuted">
                        <BadgeCheck className="h-4 w-4" aria-hidden />
                        Shared
                      </span>
                      <span className="text-[12px] tabular-nums text-inkLight">
                        {new Date(n.updated_at).toLocaleDateString()}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {editor}

        {dialog === "upload" && (
          <UploadSkillDialog
            onClose={() => setDialog(null)}
            onCommit={commitParsedSkill}
            onDone={(title, ignoredPaths) => {
              setDialog(null);
              setReloadKey((k) => k + 1);
              toast.add({
                type: "success",
                title: "Skill uploaded successfully",
                ...(ignoredPaths.length > 0
                  ? {
                      description: `${ignoredPaths.length} other ${
                        ignoredPaths.length === 1 ? "file" : "files"
                      } in that zip ${
                        ignoredPaths.length === 1 ? "was" : "were"
                      } not imported`,
                      timeout: 10_000,
                    }
                  : {}),
                position: "top-center",
                dismissible: false,
              });
            }}
          />
        )}
      </div>
    );
  },
);

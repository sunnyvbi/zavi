"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Film,
  Folder,
  FolderMinus,
  FolderPlus,
  Images,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  SquareDashed,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  IMAGE_ACCEPT,
  runBounded,
  screenUploads,
  useWorkspaceFiles,
  validateCollectionName,
  type ActionResult,
  type CollectionRow,
  type FileRow,
  type PendingUpload,
} from "@/lib/workspace/useWorkspaceFiles";
import type { FileRef } from "@/lib/workspace/fileRefs";
import { cx, FOCUS_RING, useModalFocusTrap } from "../layout/shared";
import { PhotoViewer } from "./PhotoViewer";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const photoCount = (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`;

const PILL =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-rule px-4 text-[13px] font-medium text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-50";
const PILL_SOLID =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
const SMALL_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-50";
const SELECTION_BUTTON = `inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition-colors hover:bg-cream/15 ${FOCUS_RING}`;
const MENU_SURFACE =
  "absolute top-full z-30 mt-1.5 min-w-[196px] overflow-hidden rounded-xl border border-rule bg-cream p-1 shadow-elevMd animate-code-fade motion-reduce:animate-none";
const MENU_ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] leading-[18px] transition-colors hover:bg-creamDeep focus:bg-creamDeep focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const PaneActive = createContext(true);

const PILL_SLIDE = "380ms cubic-bezier(0.32,0.72,0,1)";

function useSlidingIndicator<T extends string>(value: T) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const observed = useRef<{ el: HTMLButtonElement; observer: ResizeObserver | null } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[value] ?? null;
    const measure = () => {
      const next =
        el && el.offsetWidth > 0
          ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }
          : null;
      setBox((prev) =>
        !next
          ? null
          : prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
            ? prev
            : next,
      );
    };
    measure();
    if (observed.current?.el === el) return;
    observed.current?.observer?.disconnect();
    observed.current = null;
    if (!el) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    observed.current = { el, observer };
  });
  useEffect(() => () => observed.current?.observer?.disconnect(), []);
  const measured = box !== null;
  useEffect(() => {
    if (!measured || animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [measured, animate]);
  const style = box
    ? {
        width: box.width,
        height: box.height,
        transform: `translate(${box.left}px, ${box.top}px)`,
        transition: animate ? `transform ${PILL_SLIDE}, width ${PILL_SLIDE}` : "none",
      }
    : undefined;
  return { refs, sliding: box !== null, style };
}

const DELETE_CONCURRENCY = 4;

type MenuItem = {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

function Menu({
  label,
  items,
  align = "right",
  className,
  onOpenChange,
  children,
}: {
  label: string;
  items: MenuItem[];
  align?: "left" | "right";
  className: string;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const paneActive = useContext(PaneActive);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);

  useEffect(() => {
    if (!paneActive) setOpen(false);
  }, [paneActive]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    itemRefs.current.find((el) => el && !el.disabled)?.focus();
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled);
    if (enabled.length === 0) return;
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % enabled.length
        : event.key === "ArrowUp"
          ? (at - 1 + enabled.length) % enabled.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? enabled.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    enabled[next]!.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(className, FOCUS_RING)}
      >
        {children}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={moveFocus}
          className={cx(MENU_SURFACE, align === "right" ? "right-0" : "left-0")}
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  item.onSelect();
                }}
                className={cx(MENU_ROW, item.danger ? "text-danger" : "text-ink")}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  busy = false,
  initialFocusRef,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  initialFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useModalFocusTrap(ref, onClose, busy, initialFocusRef);
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-[380px] rounded-2xl border border-rule bg-cream p-4 shadow-pop animate-tab-enter motion-reduce:animate-none"
      >
        <h4 id={titleId} className="text-[14px] font-semibold text-ink">
          {title}
        </h4>
        {children}
      </div>
    </div>
  );
}

function NameDialog({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial: string;
  onSubmit: (name: string) => Promise<ActionResult<unknown>>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateCollectionName(name);
    if (invalid) {
      setError(invalid);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onSubmit(name.trim());
    setBusy(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.message);
    inputRef.current?.focus();
  };

  return (
    <Dialog title={title} onClose={onClose} busy={busy} initialFocusRef={inputRef}>
      <form onSubmit={submit} className="mt-3" noValidate>
        <label htmlFor={inputId} className="text-[14px] font-medium text-inkSoft">
          Collection name
        </label>
        <input
          ref={inputRef}
          id={inputId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError(null);
          }}
          placeholder="e.g. landing"
          autoComplete="off"
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="mt-1.5 h-10 w-full rounded-lg border border-rule bg-transparent px-3 text-[14px] text-ink placeholder:text-inkLight focus:border-ink/40 focus:outline-none"
        />
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-[13px] leading-5 text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={cx(PILL, FOCUS_RING)}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={cx(PILL_SOLID, FOCUS_RING)}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog title={title} onClose={onClose} initialFocusRef={cancelRef}>
      <p className="mt-2 text-[13px] leading-5 text-inkMuted">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onClose} className={cx(PILL, FOCUS_RING)}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={cx(
            "inline-flex h-9 items-center gap-2 rounded-full bg-danger px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90",
            FOCUS_RING,
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function AddToCollectionDialog({
  count,
  collections,
  onPick,
  onNew,
  onClose,
}: {
  count: number;
  collections: CollectionRow[];
  onPick: (collection: CollectionRow) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      title={count === 1 ? "Add to collection" : `Add ${photoCount(count)} to collection`}
      onClose={onClose}
      initialFocusRef={firstRef}
    >
      <ul className="ws-scroll mt-3 max-h-[240px] space-y-1 overflow-y-auto">
        {collections.map((collection, index) => (
          <li key={collection.id}>
            <button
              ref={index === 0 ? firstRef : undefined}
              type="button"
              onClick={() => onPick(collection)}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-cta px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-creamDeep",
                FOCUS_RING,
              )}
            >
              <Images className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{collection.name}</span>
              <span className="text-[12px] text-inkMuted">{collection.file_count}</span>
            </button>
          </li>
        ))}
        <li>
          <button
            ref={collections.length === 0 ? firstRef : undefined}
            type="button"
            onClick={onNew}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-cta px-3 py-2 text-left text-[13px] font-medium text-ink transition-colors hover:bg-creamDeep",
              FOCUS_RING,
            )}
          >
            <FolderPlus className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
            New collection…
          </button>
        </li>
      </ul>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={onClose} className={cx(PILL, FOCUS_RING)}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

type FileKind = "image" | "video" | "document";
type KindFilter = "all" | FileKind;
type ViewMode = "grid" | "list";

const KIND_FILTERS: Array<{ kind: KindFilter; label: string }> = [
  { kind: "all", label: "All files" },
  { kind: "image", label: "Images" },
  { kind: "video", label: "Videos" },
  { kind: "document", label: "Documents" },
];

export function kindOf(mime: string): FileKind {
  const type = mime.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "document";
}

const TYPE_LABELS: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/jpg": "JPG",
  "image/png": "PNG",
  "image/webp": "WEBP",
  "image/gif": "GIF",
  "image/avif": "AVIF",
};

export function fileTypeLabel(file: Pick<FileRow, "mime" | "name">): string {
  const known = TYPE_LABELS[file.mime.toLowerCase()];
  if (known) return known;
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toUpperCase() : "";
  if (ext) return ext === "JPEG" ? "JPG" : ext.slice(0, 5);
  const subtype = file.mime.split("/")[1];
  return subtype ? subtype.toUpperCase().slice(0, 5) : "FILE";
}

export function formatFileDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

const LIST_UPDATED_COL = "hidden w-28 shrink-0 [@container(min-width:420px)]:block";
const LIST_SIZE_COL = "hidden w-20 shrink-0 [@container(min-width:520px)]:block";

const REVEAL_ON_HOVER =
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

function Thumb({ file }: { file: FileRow }) {
  const kind = kindOf(file.mime);
  if (kind === "image") {
    return (
      <img
        src={file.url}
        alt={file.name}
        aria-description={`Uploaded image asset. File name: ${file.name}`}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    );
  }
  const Icon = kind === "video" ? Film : FileText;
  return (
    <span className="flex h-full w-full items-center justify-center text-inkMuted">
      <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

type PhotoProps = {
  file: FileRow;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  actions: MenuItem[];
};

function OpenableThumb({ file, onOpen }: { file: FileRow; onOpen: () => void }) {
  if (kindOf(file.mime) !== "image") return <Thumb file={file} />;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${file.name}`}
      data-file-open={file.id}
      className={cx("block h-full w-full cursor-zoom-in", FOCUS_RING)}
    >
      <Thumb file={file} />
    </button>
  );
}

type CardProps = PhotoProps & { selecting: boolean };

function PhotoCard({ file, index, selected, selecting, onToggle, onOpen, actions }: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const reveal = selected || selecting || menuOpen ? "opacity-100" : REVEAL_ON_HOVER;
  return (
    <li
      className={cx("group relative animate-tab-enter motion-reduce:animate-none", menuOpen && "z-10")}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <div
        className={cx(
          "relative aspect-square overflow-hidden rounded-xl border bg-bone transition-colors",
          selected ? "border-ink/50 ring-2 ring-ink/20" : "border-rule group-hover:border-ink/20",
        )}
      >
        <OpenableThumb file={file} onOpen={onOpen} />
      </div>
      <label
        className={cx(
          "absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg bg-cream/90 shadow-elev transition-opacity motion-reduce:transition-none",
          reveal,
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${file.name}`}
          className={cx("h-3.5 w-3.5 cursor-pointer accent-ink", FOCUS_RING)}
        />
      </label>
      <div className={cx("absolute right-2 top-2 transition-opacity motion-reduce:transition-none", reveal)}>
        <Menu
          label={`Actions for ${file.name}`}
          items={actions}
          onOpenChange={setMenuOpen}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-cream/90 text-ink shadow-elev transition-colors hover:bg-cream"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Menu>
      </div>
      <div className="mt-2.5 min-w-0 px-0.5">
        <p className="truncate text-[14px] font-medium text-ink">
          {file.name}
        </p>
        <p className="mt-1 text-[12px] font-medium uppercase tracking-wide text-inkMuted">
          {fileTypeLabel(file)}
        </p>
      </div>
    </li>
  );
}

function PhotoRow({ file, index, selected, selecting, onToggle, onOpen, actions }: CardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className={cx(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors animate-tab-enter motion-reduce:animate-none",
        selected ? "bg-creamDeep" : "hover:bg-creamDeep",
        menuOpen && "z-10",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 20}ms` }}
    >
      <span
        className={cx(
          "flex w-4 shrink-0 transition-opacity motion-reduce:transition-none",
          selected || selecting || menuOpen ? "opacity-100" : REVEAL_ON_HOVER,
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${file.name}`}
          className={cx("h-3.5 w-3.5 cursor-pointer accent-ink", FOCUS_RING)}
        />
      </span>
      <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-bone">
        <OpenableThumb file={file} onOpen={onOpen} />
      </span>
      <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
        {file.name}
      </p>
      <time dateTime={file.created_at} className={cx(LIST_UPDATED_COL, "text-[13px] text-inkMuted")}>
        {formatFileDate(file.created_at)}
      </time>
      <span className={cx(LIST_SIZE_COL, "text-[13px] text-inkMuted")}>{formatFileSize(file.size)}</span>
      <Menu
        label={`Actions for ${file.name}`}
        items={actions}
        onOpenChange={setMenuOpen}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-inkMuted transition-colors hover:bg-bone hover:text-ink"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Menu>
    </li>
  );
}

function ListHeader() {
  return (
    <li
      aria-hidden
      className="flex items-center gap-3 px-3 pb-2.5 text-[13px] font-medium text-inkMuted"
    >
      <span className="w-4 shrink-0" />
      <span className="min-w-0 flex-1">Name</span>
      <span className={LIST_UPDATED_COL}>Updated</span>
      <span className={LIST_SIZE_COL}>Size</span>
      <span className="w-8 shrink-0" />
    </li>
  );
}

type TrayItem =
  | { state: "uploading" | "failed"; item: PendingUpload }
  | { state: "done"; file: FileRow };

const TRAY_ICON_BUTTON =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkMuted transition-colors hover:bg-bone hover:text-ink";

function UploadTray({
  items,
  expanded,
  onToggle,
  onClose,
  onDismiss,
}: {
  items: TrayItem[];
  expanded: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDismiss: (id: string) => void;
}) {
  const listId = useId();
  const uploading = items.filter((t) => t.state === "uploading").length;
  const failed = items.filter((t) => t.state === "failed").length;
  const done = items.length - uploading - failed;
  const title =
    uploading > 0
      ? `Uploading ${done}/${items.length}`
      : done === 0
        ? "Upload failed"
        : `Uploaded ${done}/${items.length}`;
  return (
    <section
      aria-label="Uploads"
      className="absolute bottom-4 right-4 z-20 w-[320px] max-w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-rule bg-cream shadow-pop animate-tab-enter motion-reduce:animate-none"
    >
      <div className="flex h-12 items-center gap-2.5 pl-4 pr-2">
        {uploading > 0 ? (
          <Upload className="h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
        ) : failed > 0 ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={3} aria-hidden />
        )}
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          {title}
          {uploading === 0 && failed > 0 && done > 0 && <span className="text-danger"> · {failed} failed</span>}
        </p>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse uploads" : "Expand uploads"}
          aria-expanded={expanded}
          aria-controls={listId}
          className={cx(TRAY_ICON_BUTTON, FOCUS_RING)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronUp className="h-4 w-4" aria-hidden />}
        </button>
        <button type="button" onClick={onClose} aria-label="Close uploads" className={cx(TRAY_ICON_BUTTON, FOCUS_RING)}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {uploading > 0 && (
        <span aria-hidden className="block h-0.5 w-full overflow-hidden bg-rule">
          <span className="block h-full w-1/3 bg-ink/50 animate-upload-bar motion-reduce:animate-none" />
        </span>
      )}
      <ul id={listId} hidden={!expanded} className="ws-scroll max-h-[232px] overflow-y-auto border-t border-rule py-1">
        {items.map((entry) => {
          const key = entry.state === "done" ? entry.file.id : entry.item.id;
          const name = entry.state === "done" ? entry.file.name : entry.item.name;
          return (
            <li key={key} className="flex items-center gap-3 px-4 py-2" aria-busy={entry.state === "uploading"}>
              <span
                className={cx(
                  "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-bone",
                  entry.state === "failed" ? "border-danger/40" : "border-rule",
                )}
              >
                {entry.state === "done" && kindOf(entry.file.mime) === "image" ? (
                  <img src={entry.file.url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : entry.state === "failed" ? (
                  <AlertCircle className="h-4 w-4 text-danger" aria-hidden />
                ) : (
                  <FileText className="h-4 w-4 text-inkMuted" strokeWidth={1.75} aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">{name}</p>
                <p className={cx("truncate text-[12px]", entry.state === "failed" ? "text-danger" : "text-inkMuted")}>
                  {entry.state === "done" ? "Uploaded" : entry.state === "failed" ? entry.item.error : "Uploading…"}
                </p>
              </div>
              {entry.state === "uploading" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-inkMuted motion-reduce:animate-none" aria-hidden />
              ) : entry.state === "failed" ? (
                <button
                  type="button"
                  onClick={() => onDismiss(entry.item.id)}
                  aria-label={`Dismiss ${entry.item.name}`}
                  className={cx(TRAY_ICON_BUTTON, "h-8 w-8", FOCUS_RING)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : (
                <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={3} aria-hidden />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CollectionCard({
  collection,
  photos,
  index,
  onOpen,
  actions,
}: {
  collection: CollectionRow;
  photos: FileRow[];
  index: number;
  onOpen: () => void;
  actions: MenuItem[];
}) {
  const tiles = photos.filter((p) => kindOf(p.mime) === "image").slice(0, 4);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className={cx("group relative animate-tab-enter motion-reduce:animate-none", menuOpen && "z-10")}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <button type="button" onClick={onOpen} className={cx("block w-full rounded-cta text-left", FOCUS_RING)}>
        <span className="block aspect-square overflow-hidden rounded-xl border border-rule bg-creamDeep transition-colors group-hover:border-ink/20">
          {tiles.length === 0 ? (
            <span className="flex h-full w-full items-center justify-center">
              <Folder className="h-8 w-8 text-inkMuted" strokeWidth={1.5} aria-hidden />
            </span>
          ) : tiles.length === 1 ? (
            <img
              src={tiles[0]!.url}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="grid h-full w-full grid-cols-2 grid-rows-2 gap-0.5">
              {[0, 1, 2, 3].map((slot) => {
                const tile = tiles[slot];
                return tile ? (
                  <img
                    key={tile.id}
                    src={tile.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full min-h-0 object-cover"
                  />
                ) : (
                  <span key={`empty-${slot}`} className="bg-bone" />
                );
              })}
            </span>
          )}
        </span>
        <span className="mt-2 block truncate px-0.5 text-[13px] font-medium text-ink">
          {collection.name}
        </span>
        <span className="block px-0.5 text-[12px] text-inkMuted">{photoCount(collection.file_count)}</span>
      </button>
      <div className={cx("absolute right-2 top-2 transition-opacity motion-reduce:transition-none", menuOpen ? "opacity-100" : REVEAL_ON_HOVER)}>
        <Menu
          label={`Collection actions for ${collection.name}`}
          items={actions}
          onOpenChange={setMenuOpen}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-cream/90 text-ink shadow-elev transition-colors hover:bg-cream"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Menu>
      </div>
    </li>
  );
}

function LoadingGrid() {
  const bar = "animate-pulse rounded-full bg-bone/80 motion-reduce:animate-none";
  const tile = "animate-pulse rounded-xl bg-bone/70 motion-reduce:animate-none";
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading files</span>
      <div aria-hidden>
        <div className={cx(bar, "mb-3 h-4 w-28")} />
        <div className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i}>
              <div className={cx(tile, "aspect-square")} style={{ animationDelay: `${i * 90}ms` }} />
              <div className={cx(bar, "mt-2.5 h-3.5 w-1/2")} />
              <div className={cx(bar, "mt-1.5 h-2.5 w-1/4 bg-bone/60")} />
            </div>
          ))}
        </div>
        <div className="mb-5 flex items-center gap-1">
          {[96, 84, 80, 112].map((w, i) => (
            <div key={i} className={cx(bar, "h-9")} style={{ width: w }} />
          ))}
          <div className="ml-auto flex items-center gap-2">
            <div className={cx(bar, "h-9 w-9 rounded-lg")} />
            <div className={cx(bar, "h-9 w-9 rounded-lg")} />
            <div className={cx(bar, "h-9 w-[70px] rounded-lg")} />
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i}>
              <div className={cx(tile, "aspect-square")} style={{ animationDelay: `${(i + 2) * 90}ms` }} />
              <div className={cx(bar, "mt-2.5 h-3.5 w-3/4")} />
              <div className={cx(bar, "mt-1.5 h-2.5 w-8 bg-bone/60")} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type DialogState =
  | null
  | { kind: "create"; addFileIds: string[] | null }
  | { kind: "rename"; collection: CollectionRow }
  | { kind: "delete-files"; ids: string[] }
  | { kind: "delete-collection"; collection: CollectionRow }
  | { kind: "add-to"; ids: string[] };

type Notice = { tone: "error" | "info"; title: string; lines?: string[] };

const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function BuildFilesPane({
  onUseOnSite,
  active: paneActive = true,
}: {
  onUseOnSite: (files: FileRef[]) => void;
  active?: boolean;
}) {
  const store = useWorkspaceFiles();
  const { status, error, files, collections, pending } = store;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [view, setView] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewerIndex = useRef(0);
  const kindPill = useSlidingIndicator(kind);
  const viewPill = useSlidingIndicator(view);
  const [uploaded, setUploaded] = useState<FileRow[]>([]);
  const [trayExpanded, setTrayExpanded] = useState(true);
  const [trayHidden, setTrayHidden] = useState(false);
  const traySession = useRef(0);
  const dragDepth = useRef(0);
  const uploadingCount = pending.filter((p) => p.status === "uploading").length;
  const failedCount = pending.length - uploadingCount;
  useEffect(() => {
    if (uploaded.length === 0 || uploadingCount > 0 || failedCount > 0) return;
    const timer = setTimeout(() => setUploaded([]), 4000);
    return () => clearTimeout(timer);
  }, [uploaded, uploadingCount, failedCount]);
  const liveFiles = useMemo(() => new Set(files.map((f) => f.id)), [files]);
  const trayItems = useMemo<TrayItem[]>(
    () => [
      ...pending.map((item) => ({ state: item.status, item })),
      ...uploaded.filter((file) => liveFiles.has(file.id)).map((file) => ({ state: "done" as const, file })),
    ],
    [pending, uploaded, liveFiles],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const collectionsHeadingId = useId();

  const active = scope === "all" ? null : collections.find((c) => c.id === scope) ?? null;

  useEffect(() => {
    if (scope !== "all" && !active) setScope("all");
  }, [scope, active]);

  useEffect(() => {
    setSelected([]);
  }, [scope, kind]);

  useEffect(() => {
    if (paneActive) return;
    setDialog(null);
    setViewingId(null);
    setDragging(false);
    dragDepth.current = 0;
  }, [paneActive]);

  useEffect(() => {
    if (!paneActive || dialog || viewingId || selected.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"]')) return;
      setSelected([]);
      setSelectMode(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [paneActive, dialog, viewingId, selected.length]);

  useEffect(() => {
    if (notice?.tone !== "info") return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const q = query.trim().toLowerCase();
  const scoped = useMemo(
    () => (active ? files.filter((f) => f.collection_ids.includes(active.id)) : files),
    [files, active],
  );
  const searched = useMemo(
    () => (q ? scoped.filter((f) => f.name.toLowerCase().includes(q)) : scoped),
    [scoped, q],
  );
  const counts = useMemo(() => {
    const tally: Record<KindFilter, number> = { all: searched.length, image: 0, video: 0, document: 0 };
    for (const file of searched) tally[kindOf(file.mime)] += 1;
    return tally;
  }, [searched]);
  const visible = useMemo(() => {
    const list = kind === "all" ? searched : searched.filter((f) => kindOf(f.mime) === kind);
    const time = (f: FileRow) => Date.parse(f.created_at) || 0;
    return [...list].sort((a, b) => (newestFirst ? time(b) - time(a) : time(a) - time(b)));
  }, [searched, kind, newestFirst]);
  const visibleCollections = useMemo(
    () => (q ? collections.filter((c) => c.name.toLowerCase().includes(q) || c.id === scope) : collections),
    [collections, q, scope],
  );
  const filesByCollection = useMemo(() => {
    const map = new Map<string, FileRow[]>();
    for (const file of files) {
      for (const id of file.collection_ids) {
        const list = map.get(id);
        if (list) list.push(file);
        else map.set(id, [file]);
      }
    }
    return map;
  }, [files]);
  const selectedFiles = useMemo(() => visible.filter((f) => selected.includes(f.id)), [visible, selected]);
  const viewerFiles = useMemo(() => visible.filter((f) => kindOf(f.mime) === "image"), [visible]);
  const viewingAt = viewingId ? viewerFiles.findIndex((f) => f.id === viewingId) : -1;
  const viewing = viewingAt >= 0 ? viewerFiles[viewingAt]! : null;
  if (viewingAt >= 0) viewerIndex.current = viewingAt;

  useEffect(() => {
    if (!viewingId || viewingAt >= 0) return;
    const fallback = viewerFiles[Math.min(viewerIndex.current, viewerFiles.length - 1)];
    setViewingId(fallback ? fallback.id : null);
  }, [viewingId, viewingAt, viewerFiles]);

  const closeViewer = () => {
    const id = viewingId;
    setViewingId(null);
    if (!id) return;
    requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLElement>("[data-file-open]"))
        .find((el) => el.dataset.fileOpen === id)
        ?.focus();
    });
  };

  const stepViewer = (delta: number) => {
    if (viewingAt < 0) return;
    const next = viewerFiles[viewingAt + delta];
    if (next) setViewingId(next.id);
  };

  useEffect(() => {
    const shown = new Set(visible.map((f) => f.id));
    setSelected((prev) => (prev.every((id) => shown.has(id)) ? prev : prev.filter((id) => shown.has(id))));
  }, [visible]);

  const report = (result: ActionResult<unknown>, title: string) => {
    if (!result.ok) setNotice({ tone: "error", title, lines: [result.message] });
  };

  const startUpload = (list: File[]) => {
    if (list.length === 0) return;
    const { accepted, skipped } = screenUploads(list);
    setNotice(
      skipped.length > 0
        ? {
            tone: "error",
            title:
              skipped.length === 1
                ? "1 file wasn't uploaded"
                : `${skipped.length} files weren't uploaded`,
            lines: skipped.map((s) => `${s.name}: ${s.reason}`),
          }
        : null,
    );
    if (accepted.length === 0) return;
    setTrayHidden(false);
    const session = traySession.current;
    void store.upload(accepted, active?.id ?? null).then((outcome) => {
      if (outcome.uploaded.length === 0 || session !== traySession.current) return;
      setUploaded((prev) => {
        const fresh = outcome.uploaded.filter((f) => !prev.some((p) => p.id === f.id));
        return [...fresh, ...prev];
      });
    });
  };

  const closeTray = () => {
    traySession.current += 1;
    for (const item of pending) if (item.status === "failed") store.dismissPending(item.id);
    setUploaded([]);
    if (uploadingCount > 0) setTrayHidden(true);
  };

  const openPicker = () => inputRef.current?.click();

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? []);
    event.target.value = "";
    startUpload(list);
  };

  const sendToSite = (list: FileRow[]) => {
    if (list.length === 0) return;
    onUseOnSite(list.map((file) => ({ name: file.name, url: file.url })));
  };

  const copyLink = async (file: FileRow) => {
    try {
      await navigator.clipboard.writeText(file.url);
      setNotice({ tone: "info", title: "Link copied" });
    } catch {
      setNotice({ tone: "error", title: "Couldn't copy the link", lines: [file.url] });
    }
  };

  const deleteFiles = async (ids: string[]) => {
    setDialog(null);
    setSelected((prev) => prev.filter((id) => !ids.includes(id)));
    const results = await runBounded(ids, DELETE_CONCURRENCY, (id) => store.remove(id));
    const failures = results.filter((r): r is Extract<ActionResult, { ok: false }> => !r.ok);
    if (failures.length > 0) {
      setNotice({
        tone: "error",
        title: failures.length === 1 ? "A photo couldn't be deleted" : `${failures.length} photos couldn't be deleted`,
        lines: failures.map((f) => f.message),
      });
    }
  };

  const deleteCollection = async (collection: CollectionRow) => {
    setDialog(null);
    if (scope === collection.id) setScope("all");
    report(await store.deleteCollection(collection.id), `Couldn't delete "${collection.name}"`);
  };

  const addTo = async (collection: CollectionRow, ids: string[]) => {
    setDialog(null);
    const result = await store.addToCollection(collection.id, ids);
    if (result.ok) setNotice({ tone: "info", title: `Added to "${collection.name}"` });
    else report(result, `Couldn't add to "${collection.name}"`);
  };

  const removeFrom = async (collection: CollectionRow, file: FileRow) => {
    report(
      await store.removeFromCollection(collection.id, file.id),
      `Couldn't remove from "${collection.name}"`,
    );
  };

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const openCreate = () => setDialog({ kind: "create", addFileIds: null });

  const photoActions = (file: FileRow, single = false): MenuItem[] => {
    const targets = !single && selected.includes(file.id) && selectedFiles.length > 1 ? selectedFiles : [file];
    const many = targets.length > 1;
    const ids = targets.map((f) => f.id);
    return [
      { label: many ? `Use ${photoCount(targets.length)} on site` : "Use on site", icon: Send, onSelect: () => sendToSite(targets) },
      ...(many ? [] : [{ label: "Copy link", icon: Link2, onSelect: () => void copyLink(file) }]),
      {
        label: many ? `Add ${photoCount(targets.length)} to collection` : "Add to collection",
        icon: FolderPlus,
        onSelect: () => setDialog({ kind: "add-to", ids }),
      },
      ...(active
        ? [
            {
              label: "Remove from this collection",
              icon: FolderMinus,
              onSelect: () => {
                for (const target of targets) void removeFrom(active, target);
              },
            },
          ]
        : []),
      {
        label: many ? `Delete ${photoCount(targets.length)}` : "Delete",
        icon: Trash2,
        danger: true,
        onSelect: () => setDialog({ kind: "delete-files", ids }),
      },
    ];
  };

  const collectionActions = (collection: CollectionRow, photos: FileRow[]): MenuItem[] => [
    {
      label: "Use on site",
      icon: Send,
      disabled: photos.length === 0,
      onSelect: () => sendToSite(photos),
    },
    {
      label: "Rename",
      icon: Pencil,
      onSelect: () => setDialog({ kind: "rename", collection }),
    },
    {
      label: "Delete collection",
      icon: Trash2,
      danger: true,
      onSelect: () => setDialog({ kind: "delete-collection", collection }),
    },
  ];

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event) || status === "unavailable") return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (status === "unavailable") return;
    startUpload(Array.from(event.dataTransfer.files ?? []));
  };

  const blocked = status === "error" && files.length === 0 && collections.length === 0;
  const loadingFirst = status === "loading" && files.length === 0;
  const nothingYet =
    (status === "ready" || status === "unavailable") &&
    files.length === 0 &&
    collections.length === 0 &&
    pending.length === 0 &&
    !q;

  let grid: ReactNode;
  if (visible.length === 0) {
    grid = (
      <p className="text-[13px] text-inkMuted">
        {status === "unavailable" ? "Uploads switch on with the next release." : "No matching files"}
      </p>
    );
  } else if (view === "list") {
    grid = (
      <ul aria-label="Photos" className="divide-y divide-rule [container-type:inline-size] animate-pane-fade motion-reduce:animate-none">
        <ListHeader />
        {visible.map((file, index) => (
          <PhotoRow
            key={file.id}
            file={file}
            index={index}
            selected={selected.includes(file.id)}
            selecting={selectMode || selected.length > 0}
            onToggle={() => toggle(file.id)}
            onOpen={() => setViewingId(file.id)}
            actions={photoActions(file)}
          />
        ))}
      </ul>
    );
  } else {
    grid = (
      <ul
        aria-label="Photos"
        className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-6 animate-pane-fade motion-reduce:animate-none"
      >
        {visible.map((file, index) => (
          <PhotoCard
            key={file.id}
            file={file}
            index={index}
            selected={selected.includes(file.id)}
            selecting={selectMode || selected.length > 0}
            onToggle={() => toggle(file.id)}
            onOpen={() => setViewingId(file.id)}
            actions={photoActions(file)}
          />
        ))}
      </ul>
    );
  }

  let body: ReactNode;
  if (loadingFirst) {
    body = <LoadingGrid />;
  } else if (nothingYet) {
    body = (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center animate-pane-fade motion-reduce:animate-none">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bone text-inkMuted" aria-hidden>
          <FileText className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div className="space-y-1">
          <p className="text-[14px] font-semibold text-ink">No files or collections</p>
          <p className="max-w-xs text-[13px] leading-5 text-inkMuted">
            {status === "unavailable"
              ? "Uploads switch on with the next release."
              : "Upload photos to use on your site, and group them into collections. Anyone with a photo's link can view it."}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={openPicker}
            disabled={status === "unavailable"}
            className={cx(PILL, "gap-2 disabled:cursor-not-allowed disabled:opacity-50", FOCUS_RING)}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden />
            Upload files
          </button>
          <button
            type="button"
            onClick={openCreate}
            disabled={status === "unavailable"}
            className={cx(PILL, "gap-2 disabled:cursor-not-allowed disabled:opacity-50", FOCUS_RING)}
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden />
            Create collection
          </button>
        </div>
      </div>
    );
  } else if (blocked) {
    body = (
      <div
        role="alert"
        className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-center"
      >
        <AlertCircle className="h-6 w-6 text-danger" aria-hidden />
        <p className="text-[14px] font-semibold text-ink">Couldn&apos;t load your files</p>
        <p className="max-w-sm text-[13px] leading-5 text-inkMuted">{error}</p>
        <button type="button" onClick={() => void store.load()} className={cx(PILL, FOCUS_RING)}>
          Try again
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {active ? (
          <div
            key={`crumb-${active.id}`}
            className="mb-5 flex flex-wrap items-center gap-2 animate-pane-fade motion-reduce:animate-none"
          >
            <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-1 text-[14px]">
                <li className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setScope("all")}
                    className={cx(
                      "rounded-cta px-1 font-medium text-inkMuted transition-colors hover:text-ink",
                      FOCUS_RING,
                    )}
                  >
                    Collections
                  </button>
                </li>
                <li aria-hidden className="shrink-0">
                  <ChevronRight className="h-4 w-4 text-inkLight" />
                </li>
                <li className="min-w-0">
                  <span aria-current="page" className="block truncate font-semibold text-ink">
                    {active.name}
                  </span>
                </li>
                <li className="shrink-0 pl-1.5 text-[12px] text-inkMuted">{photoCount(active.file_count)}</li>
              </ol>
            </nav>
            <button
              type="button"
              onClick={() => sendToSite(scoped)}
              disabled={scoped.length === 0}
              className={cx(PILL, FOCUS_RING)}
            >
              <Send className="h-4 w-4" aria-hidden />
              Use on site
            </button>
            <Menu
              label={`Collection actions for ${active.name}`}
              items={collectionActions(active, scoped)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-rule text-ink transition-colors hover:bg-bone"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Menu>
          </div>
        ) : (
          <section
            aria-labelledby={collectionsHeadingId}
            className="mb-8 animate-pane-fade motion-reduce:animate-none"
          >
            <h4 id={collectionsHeadingId} className="mb-3 text-[16px] font-semibold text-ink">
              Collections
            </h4>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
              {visibleCollections.map((collection, index) => {
                const photos = filesByCollection.get(collection.id) ?? [];
                return (
                  <CollectionCard
                    key={collection.id}
                    collection={collection}
                    photos={photos}
                    index={index}
                    onOpen={() => setScope(collection.id)}
                    actions={collectionActions(collection, photos)}
                  />
                );
              })}
              <li
                className="animate-tab-enter motion-reduce:animate-none"
                style={{ animationDelay: `${Math.min(visibleCollections.length, 8) * 30}ms` }}
              >
                <button
                  type="button"
                  onClick={openCreate}
                  disabled={status === "unavailable"}
                  className={cx(
                    "flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-cta border border-dashed border-rule text-inkMuted transition-colors hover:border-ink/30 hover:bg-creamDeep hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-rule disabled:hover:bg-transparent disabled:hover:text-inkMuted",
                    FOCUS_RING,
                  )}
                >
                  <Plus className="h-5 w-5" aria-hidden />
                  <span className="text-[14px] font-medium">Create collection</span>
                </button>
              </li>
            </ul>
          </section>
        )}

        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter by type"
            className="ws-scroll relative flex min-w-0 items-center gap-1 overflow-x-auto"
          >
            {kindPill.style && (
              <span
                aria-hidden
                data-testid="kind-indicator"
                className="pointer-events-none absolute left-0 top-0 rounded-full bg-bone motion-reduce:!transition-none"
                style={kindPill.style}
              />
            )}
            {KIND_FILTERS.map((filter) => {
              const on = kind === filter.kind;
              return (
                <button
                  key={filter.kind}
                  ref={(el) => {
                    kindPill.refs.current[filter.kind] = el;
                  }}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setKind(filter.kind)}
                  className={cx(
                    "relative z-10 inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5 text-[14px] font-medium transition-colors duration-200",
                    on ? cx("text-ink", !kindPill.sliding && "bg-bone") : "text-inkMuted hover:text-ink",
                    FOCUS_RING,
                  )}
                >
                  {filter.label}
                  <span
                    className={cx(
                      "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[12px] tabular-nums",
                      on ? "bg-cream text-ink" : "bg-bone text-inkMuted",
                    )}
                  >
                    {counts[filter.kind]}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setNewestFirst((on) => !on)}
              aria-label={newestFirst ? "Newest first" : "Oldest first"}
              title={newestFirst ? "Newest first" : "Oldest first"}
              className={cx(
                "flex h-10 w-10 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink",
                FOCUS_RING,
              )}
            >
              {newestFirst ? <ArrowDown className="h-4 w-4" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectMode) setSelected([]);
                setSelectMode((on) => !on);
              }}
              aria-label="Select files"
              aria-pressed={selectMode}
              title="Select files"
              className={cx(
                "flex h-10 w-10 items-center justify-center rounded-full border transition-colors",
                selectMode ? "border-ink/30 bg-bone text-ink" : "border-rule text-inkMuted hover:bg-bone hover:text-ink",
                FOCUS_RING,
              )}
            >
              <SquareDashed className="h-4 w-4" aria-hidden />
            </button>
            <div role="group" aria-label="View" className="relative flex items-center gap-0.5 rounded-full border border-rule p-0.5">
              {viewPill.style && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-0 rounded-full bg-bone motion-reduce:!transition-none"
                  style={viewPill.style}
                />
              )}
              {(
                [
                  { mode: "grid", label: "Grid view", icon: LayoutGrid },
                  { mode: "list", label: "List view", icon: List },
                ] as const
              ).map((option) => {
                const Icon = option.icon;
                const on = view === option.mode;
                return (
                  <button
                    key={option.mode}
                    ref={(el) => {
                      viewPill.refs.current[option.mode] = el;
                    }}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={on}
                    onClick={() => setView(option.mode)}
                    className={cx(
                      "relative z-10 flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200",
                      on ? cx("text-ink", !viewPill.sliding && "bg-bone") : "text-inkMuted hover:text-ink",
                      FOCUS_RING,
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {grid}
      </>
    );
  }

  const noticeNode = notice ? (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cx(
        "mb-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] animate-code-fade motion-reduce:animate-none",
        notice.tone === "error" ? "border-danger/30 bg-creamDeep" : "border-rule bg-creamDeep",
      )}
    >
      {notice.tone === "error" ? (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
      ) : (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-ink" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">{notice.title}</p>
        {notice.lines && notice.lines.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[13px] leading-5 text-inkMuted">
            {notice.lines.map((line, i) => (
              <li key={i} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label="Dismiss message"
        className={cx("rounded-cta p-0.5 text-inkMuted hover:text-ink", FOCUS_RING)}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  ) : null;

  const liveText =
    uploadingCount > 0
      ? `Uploading ${photoCount(uploadingCount)}…`
      : uploaded.length > 0
        ? `${photoCount(uploaded.length)} uploaded${failedCount > 0 ? `, ${failedCount} failed` : ""}`
        : failedCount > 0
          ? "Upload failed"
          : "";

  return (
    <PaneActive.Provider value={paneActive}>
      <div
        className="relative flex h-full min-h-0 flex-col"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <p role="status" aria-live="polite" className="sr-only">
          {liveText}
        </p>
        {!trayHidden && trayItems.length > 0 && (
          <UploadTray
            items={trayItems}
            expanded={trayExpanded}
            onToggle={() => setTrayExpanded((open) => !open)}
            onClose={closeTray}
            onDismiss={store.dismissPending}
          />
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          onChange={onPicked}
          className="hidden"
          data-testid="files-input"
          tabIndex={-1}
          aria-hidden
        />

        <div
          aria-hidden={viewing ? true : undefined}
          inert={viewing ? true : undefined}
          className="flex shrink-0 flex-wrap items-center gap-3 px-6 pb-2 pt-5"
        >
          <h3 className="text-[22px] font-semibold tracking-tight text-ink">Files</h3>
          <label className="relative ml-auto block w-full max-w-[260px] flex-1">
            <span className="sr-only">Search files and collections</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkMuted"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="h-9 w-full rounded-full border border-rule bg-transparent pl-8 pr-3 text-[13px] text-ink placeholder:text-inkLight focus:border-ink/40 focus:outline-none"
            />
          </label>
          <Menu
            label="New"
            items={[
              { label: "Upload files", icon: Upload, onSelect: openPicker, disabled: status === "unavailable" },
              {
                label: "Create collection",
                icon: FolderPlus,
                onSelect: openCreate,
                disabled: status === "unavailable",
              },
            ]}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-ink pl-4 pr-3 text-[13px] font-medium text-cream transition-opacity hover:opacity-90"
          >
            New
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Menu>
        </div>

        <div
          aria-hidden={viewing ? true : undefined}
          inert={viewing ? true : undefined}
          className="ws-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-24 pt-4"
        >
          {!viewing && noticeNode}

          {status === "error" && !blocked && (
            <div role="alert" className="mb-3 flex items-center gap-2.5 rounded-xl border border-danger/30 bg-creamDeep px-3.5 py-2.5 text-[13px]">
              <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
              <p className="min-w-0 flex-1 text-ink">{error}</p>
              <button type="button" onClick={() => void store.load()} className={cx(SMALL_BUTTON, FOCUS_RING)}>
                Try again
              </button>
            </div>
          )}

          {body}
        </div>

        {viewing && (
          <PhotoViewer
            file={viewing}
            position={viewingAt + 1}
            total={viewerFiles.length}
            details={[
              { label: "Name", value: viewing.name },
              { label: "Size", value: formatFileSize(viewing.size) },
              { label: "Type", value: fileTypeLabel(viewing) },
              ...(formatFileDate(viewing.created_at)
                ? [{ label: "Added", value: formatFileDate(viewing.created_at) }]
                : []),
            ]}
            notice={noticeNode}
            onClose={closeViewer}
            onPrev={() => stepViewer(-1)}
            onNext={() => stepViewer(1)}
            onAddToCollection={() => setDialog({ kind: "add-to", ids: [viewing.id] })}
            moreMenu={
              <Menu
                label="More actions"
                items={photoActions(viewing, true)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Menu>
            }
          />
        )}

        {!viewing && selectedFiles.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
            <div
              role="toolbar"
              aria-label="Selected photos"
              className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-ink p-1.5 text-cream shadow-pop ring-1 ring-cream/10 animate-tab-enter motion-reduce:animate-none"
            >
              <button
                type="button"
                onClick={() => {
                  setSelected([]);
                  setSelectMode(false);
                }}
                aria-label="Clear selection"
                title="Clear selection (Esc)"
                className={cx(SELECTION_BUTTON, "pl-2.5 pr-3.5")}
              >
                <X className="h-4 w-4 text-cream/60" aria-hidden />
                <span>
                  <span className="font-semibold tabular-nums">{selectedFiles.length}</span> selected
                </span>
              </button>
              {selectedFiles.length < visible.length && (
                <button
                  type="button"
                  onClick={() => setSelected(visible.map((f) => f.id))}
                  className={cx(SELECTION_BUTTON, "text-cream/60 hover:text-cream")}
                >
                  Select all
                </button>
              )}
              <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-cream/15" />
              <button
                type="button"
                onClick={() => setDialog({ kind: "add-to", ids: selectedFiles.map((f) => f.id) })}
                className={SELECTION_BUTTON}
              >
                <FolderPlus className="h-4 w-4 text-cream/70" aria-hidden />
                Add to collection
              </button>
              <button type="button" onClick={() => sendToSite(selectedFiles)} className={SELECTION_BUTTON}>
                <Send className="h-4 w-4 text-cream/70" aria-hidden />
                Use on site
              </button>
              <button
                type="button"
                onClick={() => setDialog({ kind: "delete-files", ids: selectedFiles.map((f) => f.id) })}
                aria-label={`Delete ${photoCount(selectedFiles.length)}`}
                className={cx(SELECTION_BUTTON, "group/delete hover:bg-danger hover:text-white")}
              >
                <Trash2 className="h-4 w-4 text-cream/70 group-hover/delete:text-white" aria-hidden />
                Delete
              </button>
            </div>
          </div>
        )}

        {dragging && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink/40 bg-cream/90 animate-code-fade motion-reduce:animate-none"
          >
            <Upload className="h-6 w-6 text-ink" aria-hidden />
            <p className="text-[14px] font-semibold text-ink">
              {active ? `Drop photos to add them to "${active.name}"` : "Drop photos to upload"}
            </p>
            <p className="text-[13px] text-inkMuted">PNG, JPEG, WebP, GIF or AVIF, up to 10 MB each</p>
            <p className="text-[13px] text-inkMuted">Anyone with a photo&apos;s link can view it.</p>
          </div>
        )}

        {dialog?.kind === "create" && (
          <NameDialog
            title="Create collection"
            submitLabel="Create"
            initial=""
            onClose={() => setDialog(null)}
            onSubmit={async (name) => {
              const result = await store.createCollection(name);
              if (!result.ok) return result;
              if (dialog.addFileIds && dialog.addFileIds.length > 0) {
                const added = await store.addToCollection(result.value.id, dialog.addFileIds);
                if (added.ok) setNotice({ tone: "info", title: `Added to "${result.value.name}"` });
                else report(added, `Couldn't add to "${result.value.name}"`);
              } else {
                setScope(result.value.id);
              }
              return result;
            }}
          />
        )}
        {dialog?.kind === "rename" && (
          <NameDialog
            title="Rename collection"
            submitLabel="Save"
            initial={dialog.collection.name}
            onClose={() => setDialog(null)}
            onSubmit={(name) => store.renameCollection(dialog.collection.id, name)}
          />
        )}
        {dialog?.kind === "delete-files" && (
          <ConfirmDialog
            title={dialog.ids.length === 1 ? "Delete this photo?" : `Delete ${photoCount(dialog.ids.length)}?`}
            body={
              dialog.ids.length === 1
                ? "It's removed from every collection, and any page still using its link will break."
                : "They're removed from every collection, and any page still using their links will break."
            }
            confirmLabel="Delete"
            onClose={() => setDialog(null)}
            onConfirm={() => void deleteFiles(dialog.ids)}
          />
        )}
        {dialog?.kind === "delete-collection" && (
          <ConfirmDialog
            title={`Delete "${dialog.collection.name}"?`}
            body="Photos stay in All files."
            confirmLabel="Delete collection"
            onClose={() => setDialog(null)}
            onConfirm={() => void deleteCollection(dialog.collection)}
          />
        )}
        {dialog?.kind === "add-to" && (
          <AddToCollectionDialog
            count={dialog.ids.length}
            collections={collections}
            onClose={() => setDialog(null)}
            onPick={(collection) => void addTo(collection, dialog.ids)}
            onNew={() => setDialog({ kind: "create", addFileIds: dialog.ids })}
          />
        )}
      </div>
    </PaneActive.Provider>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  Check,
  Info,
  Loader2,
  OctagonX,
  TriangleAlert,
  X,
} from "lucide-react";
import { Portal } from "@/components/ui/Portal";
import { cn } from "@/lib/cn";

export type ToastType = "success" | "info" | "warning" | "error" | "loading";

export type ToastPosition = "bottom-right" | "bottom-center" | "top-center" | "top-right";

const POSITIONS: readonly ToastPosition[] = [
  "bottom-right",
  "bottom-center",
  "top-center",
  "top-right",
];

export type ToastOptions = {
  title?: ReactNode;
  description?: ReactNode;
  type?: ToastType;
  timeout?: number;
  position?: ToastPosition;
  dismissible?: boolean;
  inverse?: boolean;
  actionProps?: ButtonHTMLAttributes<HTMLButtonElement>;
};

type ToastData = ToastOptions & { id: string; leaving: boolean };

const DEFAULT_TIMEOUT = 5000;
const LIMIT = 3;
const GAP = 12;
const PEEK = 12;
const EXIT_MS = 300;

let store: ToastData[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const exitTimers = new Map<string, number>();

function emit(next: ToastData[]) {
  store = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot() {
  return store;
}

const SERVER_SNAPSHOT: ToastData[] = [];

function getServerSnapshot(): ToastData[] {
  return SERVER_SNAPSHOT;
}

function add(options: ToastOptions): string {
  const id = `toast-${++counter}`;
  emit([{ id, leaving: false, ...options }, ...store]);
  return id;
}

function update(id: string, options: ToastOptions) {
  emit(store.map((t) => (t.id === id ? { id, leaving: false, ...options } : t)));
}

function close(id: string) {
  if (exitTimers.has(id) || !store.some((t) => t.id === id)) return;
  emit(store.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  exitTimers.set(
    id,
    window.setTimeout(() => {
      exitTimers.delete(id);
      emit(store.filter((t) => t.id !== id));
    }, EXIT_MS),
  );
}

type PromiseMessage<T> = string | ToastOptions | ((value: T) => string | ToastOptions);

function resolveMessage<T>(m: PromiseMessage<T>, value: T): ToastOptions {
  const r = typeof m === "function" ? m(value) : m;
  return typeof r === "string" ? { title: r } : r;
}

function promise<T>(
  p: Promise<T>,
  opts: {
    loading: string | ToastOptions;
    success: PromiseMessage<T>;
    error: PromiseMessage<unknown>;
  },
): Promise<T> {
  const loading = typeof opts.loading === "string" ? { title: opts.loading } : opts.loading;
  const id = add({ type: "loading", ...loading });
  p.then(
    (value) => update(id, { type: "success", ...resolveMessage(opts.success, value) }),
    (err) => update(id, { type: "error", ...resolveMessage(opts.error, err) }),
  );
  return p;
}

export const toast = { add, close, update, promise };

function ToastIcon({ type, inverse }: { type: ToastType | undefined; inverse?: boolean }) {
  if (!type) return null;
  if (inverse && type === "success") return <span className="flex shrink-0 self-center"><Check className="h-4 w-4 text-[#4ade80]" strokeWidth={2.5} aria-hidden /></span>;
  const icons: Record<ToastType, ReactNode> = {
    success: (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full bg-[#e6f6ee] text-[#0e7c4a] [html.dark_&]:bg-[#0e7c4a]/25 [html.dark_&]:text-[#4ade80]"
        aria-hidden
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    ),
    info: <Info className="h-4 w-4" aria-hidden />,
    warning: <TriangleAlert className="h-4 w-4" aria-hidden />,
    error: <OctagonX className="h-4 w-4 text-danger" aria-hidden />,
    loading: <Loader2 className="h-4 w-4 animate-spin" aria-hidden />,
  };
  return <span className="mt-0.5 flex shrink-0">{icons[type]}</span>;
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(!document.hidden);
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function ToastCard({
  item,
  index,
  offset,
  frontHeight,
  expanded,
  onHeight,
  position,
}: {
  item: ToastData;
  index: number;
  offset: number;
  frontHeight: number;
  expanded: boolean;
  onHeight: (id: string, h: number) => void;
  position: ToastPosition;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const docVisible = useDocumentVisible();

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 15);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => onHeight(item.id, el.offsetHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.id, onHeight]);

  useEffect(() => {
    if (item.leaving || item.type === "loading" || item.timeout === 0) return;
    if (expanded || !docVisible) return;
    const t = window.setTimeout(() => close(item.id), item.timeout ?? DEFAULT_TIMEOUT);
    return () => window.clearTimeout(t);
  }, [item.id, item.leaving, item.type, item.timeout, expanded, docVisible]);

  const behind = !expanded && index > 0;
  const hidden = index >= LIMIT;
  const dir = position === "bottom-right" || position === "bottom-center" ? -1 : 1;
  const transform =
    !entered || item.leaving
      ? `translateY(${dir * -150}%)`
      : expanded
        ? `translateY(${dir * offset}px)`
        : `translateY(${dir * index * PEEK}px) scale(${Math.max(0, 1 - index * 0.1)})`;
  const height = expanded || index === 0 ? undefined : frontHeight || undefined;
  const { actionProps } = item;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto absolute w-full select-none overflow-hidden border shadow-pop will-change-transform",
        item.inverse
          ? "rounded-full border-ink bg-ink text-cream [html.dark_&]:border-[#ececec] [html.dark_&]:bg-[#ececec] [html.dark_&]:text-[#1f1f1f]"
          : "rounded-xl border-rule bg-white text-ink [html.dark_&]:border-dark-border [html.dark_&]:bg-dark-surface [html.dark_&]:text-[#ececec]",
        position === "bottom-center"
          ? "bottom-0 left-0 origin-bottom"
          : position === "top-center"
          ? "left-0 top-0 origin-top"
          : position === "top-right"
            ? "right-0 top-0 origin-top"
            : "bottom-0 right-0 origin-bottom",
        "[transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_300ms,height_150ms]",
        (!entered || item.leaving || hidden) && "opacity-0",
        hidden && "pointer-events-none",
      )}
      style={{ transform, height, zIndex: 1000 - index }}
    >
      <div
        ref={contentRef}
        className={cn(
          "flex gap-3 transition-opacity duration-200",
          item.inverse ? "items-center py-2 pl-5 pr-2" : "items-start py-3 pl-4 pr-3",
          behind && "opacity-0",
        )}
      >
        <ToastIcon type={item.type} inverse={item.inverse} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {item.title != null && <div className="text-[14px] font-semibold leading-5">{item.title}</div>}
          {item.description != null && (
            <div className="text-[13px] leading-5 text-inkMuted [html.dark_&]:text-[#9a9a9a]">
              {item.description}
            </div>
          )}
        </div>
        {actionProps && (
          <button
            type="button"
            {...actionProps}
            onClick={(e) => {
              actionProps.onClick?.(e);
              close(item.id);
            }}
            className={cn(
              "inline-flex h-8 shrink-0 items-center justify-center self-center text-[13px] font-medium transition-opacity hover:opacity-90",
              item.inverse
                ? "rounded-full bg-white px-4 text-ink [html.dark_&]:bg-[#1f1f1f] [html.dark_&]:text-[#ececec]"
                : "rounded-cta bg-ink px-3 text-cream [html.dark_&]:bg-[#ececec] [html.dark_&]:text-[#1f1f1f]",
              actionProps.className,
            )}
          />
        )}
        {item.dismissible !== false && (
        <button
          type="button"
          aria-label="Close toast"
          onClick={() => close(item.id)}
          className="grid h-8 w-8 shrink-0 place-items-center self-center rounded-cta text-inkMuted transition-colors hover:bg-cream hover:text-ink [html.dark_&]:text-[#9a9a9a] [html.dark_&]:hover:bg-dark-hover [html.dark_&]:hover:text-[#ececec]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        )}
      </div>
    </div>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [heights, setHeights] = useState<Record<string, number>>({});

  const onHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  }, []);

  if (items.length === 0) return null;

  return (
    <>
      {POSITIONS.map((position) => {
        const group = items.filter(
          (t) => (t.position ?? "bottom-right") === position,
        );
        if (group.length === 0) return null;
        return (
          <ToastRegion
            key={position}
            items={group}
            position={position}
            heights={heights}
            onHeight={onHeight}
          />
        );
      })}
    </>
  );
}

function ToastRegion({
  items,
  position,
  heights,
  onHeight,
}: {
  items: ToastData[];
  position: ToastPosition;
  heights: Record<string, number>;
  onHeight: (id: string, h: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (items.length === 0) setExpanded(false);
  }, [items.length]);

  const visible = items.filter((t) => !t.leaving);
  const shown = visible.slice(0, LIMIT);
  const frontHeight = heights[visible[0]?.id ?? ""] ?? 0;
  const offsets = new Map<string, number>();
  let acc = 0;
  visible.forEach((t, i) => {
    offsets.set(t.id, acc);
    acc += (heights[t.id] ?? 0) + (i < visible.length - 1 ? GAP : 0);
  });
  const viewportHeight = expanded
    ? acc
    : frontHeight + PEEK * Math.max(0, shown.length - 1);

  return (
    <Portal>
      <div
        role="region"
        aria-label="Notifications"
        className={cn(
          "pointer-events-none fixed z-[140] w-auto",
          position === "bottom-center" ? "max-w-md" : "max-w-sm",
          position === "bottom-center"
            ? "inset-x-4 bottom-6 mx-auto sm:w-full"
            : position === "top-center"
            ? "inset-x-4 top-4 mx-auto sm:w-full"
            : position === "top-right"
              ? "inset-x-4 top-4 mx-auto sm:left-auto sm:right-4 sm:mx-0 sm:w-full"
              : "inset-x-4 bottom-4 mx-auto sm:left-auto sm:right-4 sm:mx-0 sm:w-full",
        )}
        style={{ height: viewportHeight }}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
      >
        {items.map((item) => {
          const i = visible.findIndex((t) => t.id === item.id);
          return (
            <ToastCard
              key={item.id}
              item={item}
              index={i === -1 ? 0 : i}
              offset={offsets.get(item.id) ?? 0}
              frontHeight={frontHeight}
              expanded={expanded}
              onHeight={onHeight}
              position={position}
            />
          );
        })}
      </div>
    </Portal>
  );
}

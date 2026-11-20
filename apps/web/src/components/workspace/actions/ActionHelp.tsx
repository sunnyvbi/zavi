"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Info } from "lucide-react";

type Entry = { label: string; description: string };
type Help = {
  set: (id: string, entry: Entry) => void;
  remove: (id: string) => void;
};

const touchQuery = "(hover: none), (pointer: coarse)";
const subscribeTouch = (change: () => void) => {
  const query = window.matchMedia(touchQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
const isTouch = () => window.matchMedia(touchQuery).matches;
const serverTouch = () => false;

export const useTouch = () =>
  useSyncExternalStore(subscribeTouch, isTouch, serverTouch);

const HelpContext = createContext<Help | null>(null);

export function ActionHelpReset({ children }: { children: ReactNode }) {
  return <HelpContext.Provider value={null}>{children}</HelpContext.Provider>;
}

export function useCardHelp(label: string, description: string): boolean {
  const help = useContext(HelpContext);
  const touch = useTouch();
  const id = useId();
  const active = !!help && touch;
  useEffect(() => {
    if (!active) return;
    return () => help?.remove(id);
  }, [active, help, id]);
  useEffect(() => {
    if (active) help?.set(id, { label, description });
  }, [active, help, id, label, description]);
  return active;
}

export function ActionHelpProvider({
  children,
}: {
  children: (help: ReactNode) => ReactNode;
}) {
  const [entries, setEntries] = useState<Map<string, Entry>>(() => new Map());
  const [open, setOpen] = useState(false);
  const listId = useId();
  const set = useCallback((id: string, entry: Entry) => {
    setEntries((prev) => {
      const old = prev.get(id);
      if (old?.label === entry.label && old.description === entry.description)
        return prev;
      return new Map(prev).set(id, entry);
    });
  }, []);
  const remove = useCallback((id: string) => {
    setEntries((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ set, remove }), [set, remove]);
  const list = [
    ...new Map(
      [...entries.values()].map((e) => [`${e.label}\n${e.description}`, e]),
    ).values(),
  ];
  const help = list.length > 0 && (
    <div data-testid="action-card-help" className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full text-[13px] font-medium text-inkMuted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inkMuted"
      >
        <Info className="size-4" aria-hidden />
        What these buttons do
      </button>
      {open && (
        <ul
          id={listId}
          className="mt-2 space-y-2 rounded-xl border border-rule bg-creamDeep px-3 py-2 text-[13px] leading-5 text-inkSoft"
        >
          {list.map((e) => (
            <li key={`${e.label}\n${e.description}`} className="break-words">
              <span className="font-semibold text-ink">{e.label}</span>
              {" · "}
              {e.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <HelpContext.Provider value={value}>{children(help)}</HelpContext.Provider>
  );
}

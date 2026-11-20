"use client";

import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { announceChannelHistoryChanged, viewChannelHistory } from "../useChannelHistory";

export const MOVE_DELAY_MS = 1400;
export const MOVE_EXIT_MS = 280;

export function useMoveToHistory({ id, slug, title, active, history = true, onGone }: { id: string; slug: string; title: string; active: boolean; history?: boolean; onGone: () => void }) {
  const gone = useRef(onGone);
  gone.current = onGone;
  const label = useRef({ title, history });
  label.current = { title, history };
  const started = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      started.current = null;
      return;
    }
    started.current ??= Date.now();
    let exits: Animation[] = [];
    let target: HTMLElement | null = null;
    let after: number | undefined;
    const finish = () => {
      const { title, history } = label.current;
      gone.current();
      if (!history) return;
      announceChannelHistoryChanged(slug);
      toast.add({
        type: "success",
        inverse: true,
        position: "bottom-center",
        dismissible: false,
        timeout: 4000,
        title: <span className="block truncate"><span className="font-semibold">Moved to History:</span> <span className="font-normal">{title}</span></span>,
        actionProps: { children: "View", onClick: () => viewChannelHistory(slug, id) },
      });
    };
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="action-${id.replace(/["\\]/g, "\\$&")}"]`);
      const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!el || typeof el.animate !== "function" || still) {
        finish();
        return;
      }
      const box = getComputedStyle(el);
      target = el;
      el.style.overflow = "hidden";
      el.style.willChange = "height, opacity, transform";
      exits = [
        el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.98)" }], { duration: MOVE_EXIT_MS * 0.6, easing: "ease-out", fill: "forwards" }),
        el.animate(
          [
            { height: `${el.offsetHeight}px`, paddingTop: box.paddingTop, paddingBottom: box.paddingBottom, borderTopWidth: box.borderTopWidth, borderBottomWidth: box.borderBottomWidth, marginBottom: "0px" },
            { height: "0px", paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", marginBottom: "-12px" },
          ],
          { duration: MOVE_EXIT_MS, easing: "cubic-bezier(0.4,0,0.2,1)", fill: "forwards" },
        ),
      ];
      after = window.setTimeout(finish, MOVE_EXIT_MS);
    }, Math.max(0, MOVE_DELAY_MS - (Date.now() - started.current)));
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(after);
      exits.forEach((exit) => exit?.cancel?.());
      if (target) {
        target.style.overflow = "";
        target.style.willChange = "";
      }
    };
  }, [active, id, slug]);
}

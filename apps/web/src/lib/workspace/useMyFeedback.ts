"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export type FeedbackStatus = "received" | "working" | "done" | "wont_do";

export type MyFeedbackRequest = {
  id: string;
  body: string;
  created_at: string;
  status: FeedbackStatus;
  staff_note: string | null;
  updated: boolean;
};

export const FEEDBACK_CHANGED_EVENT = "zavi:feedback-changed";

export function announceFeedbackChanged() {
  window.dispatchEvent(new Event(FEEDBACK_CHANGED_EVENT));
}

export function useMyFeedback() {
  const [requests, setRequests] = useState<MyFeedbackRequest[] | null>(null);
  const [updates, setUpdates] = useState(0);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const res = await apiFetch("/api/feedback/product/mine");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { requests?: MyFeedbackRequest[]; updates?: number };
      if (seq !== latest.current) return;
      setRequests(body.requests ?? []);
      setUpdates(body.updates ?? 0);
      setFailed(false);
    } catch {
      if (seq === latest.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener(FEEDBACK_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(FEEDBACK_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const markSeen = useCallback(async () => {
    try {
      const res = await apiFetch("/api/feedback/product/seen", { method: "POST" });
      if (res.ok) announceFeedbackChanged();
    } catch {
    }
  }, []);

  return { requests, updates, failed, markSeen, reload: load };
}

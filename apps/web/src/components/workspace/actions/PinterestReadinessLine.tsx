"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { NewPinterestBoard } from "./PinterestBoardTools";

type ReadinessCheck = { status: "pass" | "fail" | "unverified" | "skipped"; reason_code?: string; reason?: string };
type Readiness = {
  ok: boolean;
  reason_code?: string;
  reason?: string;
  board_count?: number;
  checks?: { board?: ReadinessCheck };
};

export type PinterestReadinessView = {
  text: string;
  link?: { href: string; label: string };
  create?: boolean;
};

const READINESS_URL = "/api/channels/pinterest_organic/readiness";
const PINTEREST_HOME = "https://www.pinterest.com/";

export function pinterestReadinessView(r: Readiness | null): PinterestReadinessView | null {
  if (!r) return null;
  if (r.ok) return null;
  const code = r.reason_code ?? r.checks?.board?.reason_code;
  if (code === "pinterest_no_boards") {
    return {
      text: "Connected. Add a board so Zavi has somewhere to pin.",
      link: { href: PINTEREST_HOME, label: "Create on Pinterest" },
      create: true,
    };
  }
  if (code === "pinterest_lookup_failed") {
    return { text: "Connected. Zavi could not check your boards just now." };
  }
  return { text: `Connected. ${r.reason ?? r.checks?.board?.reason ?? "Zavi could not confirm your boards yet."}` };
}

export function PinterestReadinessLine() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [checking, setChecking] = useState(false);
  const live = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const res = await apiFetch(READINESS_URL);
      if (!res.ok) return;
      const data = (await res.json()) as { connected?: boolean; readiness?: Readiness };
      if (!live.current || ticket !== latest.current) return;
      setReadiness(data.connected && data.readiness ? data.readiness : null);
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const recheck = async () => {
    setChecking(true);
    await load();
    if (live.current) setChecking(false);
  };

  const view = pinterestReadinessView(readiness);
  if (!view) return null;

  return (
    <div
      role="status"
      data-testid="pinterest-readiness"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5 text-inkMuted"
    >
      <span>{view.text}</span>
      {view.create ? <NewPinterestBoard label="Create a board" onCreated={() => void recheck()} /> : null}
      {view.link ? (
        <a
          href={view.link.href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="pinterest-readiness-open"
          className="inline-flex items-center gap-1 font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted"
        >
          {view.link.label}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      ) : null}
      <button
        type="button"
        onClick={recheck}
        disabled={checking}
        data-testid="pinterest-readiness-recheck"
        className="font-medium text-inkMuted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inkMuted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {checking ? "Checking" : "Check again"}
      </button>
    </div>
  );
}

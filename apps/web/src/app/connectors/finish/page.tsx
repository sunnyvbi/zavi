"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { sameOriginTarget } from "./target";
import { finishErrorMessage } from "./errors";
import { clearChannelReadCache } from "@/lib/workspace/channelReadCache";

const SLUG_RE = /^[a-z0-9_]{1,64}$/;
const PHONE_RE = /iPhone|iPad|iPod|Android/;

export default function ConnectorFinishPage() {
  const [error, setError] = useState<string | null>(null);
  const [appLink, setAppLink] = useState<string | null>(null);
  const [signIn, setSignIn] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const slug = params.get("connector") ?? "";
    const code = params.get("code") ?? "";
    const state = params.get("state") ?? "";
    if (!SLUG_RE.test(slug) || !code || !state) {
      setError("This connection link is incomplete. Start the connection again from your workspace.");
      return;
    }
    void (async () => {
      try {
        const res = await apiFetch(`/api/connectors/${slug}/complete`, {
          method: "POST",
          body: JSON.stringify({ code, state }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          redirect?: string;
          error?: { code?: string; message?: string };
        };
        if (res.status === 401 && PHONE_RE.test(window.navigator.userAgent)) {
          setAppLink(`zavi://connectors/finish?${new URLSearchParams({ connector: slug, code, state }).toString()}`);
          setError("Open the Zavi app to finish connecting. If you started this on a computer, sign in there and start again.");
          return;
        }
        if (res.status === 401) {
          setSignIn(true);
          setError("You are signed out, so this connection was not finished and nothing was saved. Sign in, then start the connection again from your workspace.");
          return;
        }
        if (!res.ok) {
          setError(finishErrorMessage(slug, body.error));
          return;
        }
        clearChannelReadCache();
        window.location.replace(sameOriginTarget(body.redirect, window.location.origin));
      } catch {
        setError("The connection could not be finished. Check your network and start it again from your workspace.");
      }
    })();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      {error ? (
        <>
          <h1 className="text-[20px] font-semibold text-[#1f1f1f]">Connection not finished</h1>
          <p className="text-[15px] text-[#555]">{error}</p>
          {appLink ? (
            <a href={appLink} className="rounded-cta bg-[#1f1f1f] px-4 py-2 text-[15px] font-semibold text-white">
              Open the Zavi app
            </a>
          ) : null}
          {signIn ? (
            <a href={`/login?next=${encodeURIComponent("/workspace?tab=settings")}`} className="rounded-cta bg-[#1f1f1f] px-4 py-2 text-[15px] font-semibold text-white">
              Sign in
            </a>
          ) : null}
          <a href="/workspace?tab=settings" className="rounded-cta border border-[#f0f0f0] px-4 py-2 text-[15px] font-semibold text-[#1f1f1f]">
            Back to your workspace
          </a>
        </>
      ) : (
        <p className="text-[15px] text-[#555]">Finishing the connection…</p>
      )}
    </main>
  );
}

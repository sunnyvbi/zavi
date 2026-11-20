"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

type Props = { email: string };

type StartResponse = { code?: string; redirect_uri?: string };

export function ExtensionConnectPanel({ email }: Props) {
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/extension/connect/start", { method: "POST" });
      if (!res.ok) throw new Error("start_failed");
      const body = (await res.json()) as StartResponse;
      if (!body.code || !body.redirect_uri) throw new Error("start_incomplete");

      const dest = new URL(body.redirect_uri);
      dest.searchParams.set("code", body.code);
      window.location.replace(dest.toString());
    } catch {
      setError("Could not connect the extension. Try again.");
      setBusy(false);
    }
  }

  function cancel() {
    setCancelled(true);
    window.close();
  }

  if (cancelled) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-semibold">Sign-in cancelled</h1>
        <p className="text-base text-neutral-600">
          Nothing was connected. You can close this window.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Connect the Zavi extension?</h1>
        <p className="text-base text-neutral-600">
          The extension will be signed in as{" "}
          <strong className="font-medium text-neutral-900">{email}</strong>.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          className="rounded-cta bg-neutral-900 px-4 py-2 text-base font-medium text-white disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded-cta border border-neutral-300 px-4 py-2 text-base font-medium text-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      {error && (
        <p className="text-base text-red-600" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

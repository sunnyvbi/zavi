"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "../ConnectorTile";
import { FormNote, FormPanel, FormPrimaryButton, FormSecondaryButton } from "../formControls";
import { createPairCode, getConnector, type ConnectorStatus, type PairCode } from "./databaseApi";
import { CodeBlock, OkRow } from "./DatabaseSetupPanel";

export const POLL_MS = 3000;

export type InstallState = "minting" | "mint_failed" | "waiting" | "online" | "expired";

const monotonic = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function installState(
  pairingId: string | null,
  expiresInSeconds: number | null,
  mintedAt: number | null,
  status: ConnectorStatus | null,
  now: number,
  mintFailed: boolean,
): InstallState {
  if (mintFailed) return "mint_failed";
  if (!pairingId || mintedAt === null || expiresInSeconds === null) return "minting";
  if (status && status.paired && status.online && status.pairing_id === pairingId) return "online";
  if (now - mintedAt >= expiresInSeconds * 1000) return "expired";
  return "waiting";
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
    </svg>
  );
}

export function ConnectorInstallPanel({ onCancel, onOnline }: { onCancel: () => void; onOnline: () => void }) {
  const [secret, setSecret] = useState<Pick<PairCode, "code" | "command"> | null>(null);
  const [pairing, setPairing] = useState<{ id: string; expiresIn: number; mintedAt: number } | null>(null);
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [mintFailed, setMintFailed] = useState(false);
  const [now, setNow] = useState(() => monotonic());
  const notified = useRef(false);

  const mint = useCallback(async () => {
    setMintFailed(false);
    setSecret(null);
    setPairing(null);
    setStatus(null);
    notified.current = false;
    try {
      const c = await createPairCode();
      const at = monotonic();
      setPairing({ id: c.pairing_id, expiresIn: c.expires_in_seconds, mintedAt: at });
      setSecret({ code: c.code, command: c.command });
      setNow(at);
    } catch {
      setMintFailed(true);
    }
  }, []);

  useEffect(() => {
    void mint();
  }, [mint]);

  const state = installState(pairing?.id ?? null, pairing?.expiresIn ?? null, pairing?.mintedAt ?? null, status, now, mintFailed);

  useEffect(() => {
    if (state !== "waiting") return;
    let live = true;
    const tick = async () => {
      try {
        const s = await getConnector();
        if (live) setStatus(s);
      } catch {
      }
      if (live) setNow(monotonic());
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [state]);

  useEffect(() => {
    if (state === "online" && !notified.current) {
      notified.current = true;
      setSecret(null);
      onOnline();
    }
  }, [state, onOnline]);

  const machine = status && status.paired ? status.machine ?? "your server" : "your server";

  return (
    <FormPanel>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-[16px] font-semibold text-[#0e0f11]">Install the Zavi Connector</p>
          <p className="mt-0.5 text-[14px] leading-[20px] text-[#595959]">
            Run this on a server inside your network that can reach your database. It only connects out to Zavi, so there are no ports to open.
          </p>
        </div>

        {state === "minting" && (
          <FormNote>
            <span className="flex items-center gap-2 font-medium text-[#1f1f1f]">
              <Spinner /> Making your pairing code…
            </span>
          </FormNote>
        )}
        {state === "mint_failed" && (
          <Banner tone="error" title="Couldn’t make a pairing code.">
            <span className="flex flex-wrap items-center gap-2">
              Try again in a moment.
              <button type="button" onClick={() => void mint()} className="cursor-pointer font-semibold underline">
                Try again
              </button>
            </span>
          </Banner>
        )}

        {secret && state !== "online" && state !== "mint_failed" && (
          <>
            <div data-replay-mask="">
              <CodeBlock code={secret.command} label="Server with Docker (recommended, always on)" />
            </div>
            <span className="-mt-1 text-[12px] leading-[16px] text-[#8a8a8a]">
              Needs to reach api.zaviagent.com on port 443. The pairing code works once and expires in 30 minutes.
            </span>
            <span className="-mt-2 text-[12px] leading-[16px] text-[#8a8a8a]">
              Recommended: keep the encryption key outside the data volume with a Docker secret named zavi_connector_key.
            </span>
          </>
        )}

        {state === "waiting" && (
          <FormNote>
            <span className="flex items-center gap-2 font-medium text-[#1f1f1f]" role="status">
              <Spinner /> Waiting for your connector to check in. This updates by itself.
            </span>
          </FormNote>
        )}
        {state === "online" && status && status.paired && (
          <div className="flex flex-col gap-2">
            <OkRow>
              Connector online on {machine}
              {status.version ? ` · version ${status.version}` : ""}
              {status.last_seen_age ? ` · last seen ${status.last_seen_age} ago` : ""}
            </OkRow>
            <p className="text-[14px] leading-[20px] text-[#595959]">
              Next, on {machine}, open <b className="font-semibold text-[#1f1f1f]">http://localhost:7801</b> to add your database. The password goes there, not
              to Zavi. The admin token is in the connector&apos;s log: docker logs zavi-connector.
            </p>
          </div>
        )}
        {state === "expired" && (
          <Banner tone="warning" title="The pairing code expired before a connector used it.">
            <span className="flex flex-wrap items-center gap-2">
              Get a new code and run the command again.
              <button type="button" onClick={() => void mint()} className="cursor-pointer font-semibold underline">
                Get a new pairing code
              </button>
            </span>
          </Banner>
        )}

        <div className="flex items-center gap-2.5">
          {state === "online" ? (
            <FormPrimaryButton type="button" onClick={onCancel}>
              Done
            </FormPrimaryButton>
          ) : (
            <FormSecondaryButton onClick={onCancel}>Cancel</FormSecondaryButton>
          )}
        </div>
      </div>
    </FormPanel>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Banner } from "../ConnectorTile";
import { FormPanel, FormPrimaryButton } from "../formControls";
import { getConnector, type ConnectorStatus } from "./databaseApi";
import { CodeBlock, OkRow } from "./DatabaseSetupPanel";

export function skippedTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function ConnectorStatusPanel({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      getConnector()
        .then((s) => live && (setStatus(s), setError(false)))
        .catch(() => live && setError(true));
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  const s = status && status.paired ? status : null;
  const machine = s?.machine ?? "your server";

  return (
    <FormPanel>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-[16px] font-semibold text-[#0e0f11]">Connector status</p>
          {s && !s.online && (
            <p className="mt-0.5 text-[14px] leading-[20px] text-[#595959]">
              {s.last_seen_age ? `Last seen ${s.last_seen_age} ago on ${machine}.` : `Your connector on ${machine} has not checked in yet.`}
            </p>
          )}
        </div>
        {error && <p className="text-[14px] text-rose-700">Couldn’t load the connector. Try again in a moment.</p>}
        {!error && status === null && <p className="text-[14px] text-[#8a8a8a]">Loading…</p>}
        {status && !status.paired && <p className="text-[14px] text-[#595959]">No connector is paired.</p>}
        {s && s.online && (
          <div className="flex flex-col gap-2">
            <OkRow>
              Connector online on {machine}
              {s.version ? ` · version ${s.version}` : ""}
              {s.last_seen_age ? ` · last seen ${s.last_seen_age} ago` : ""}
            </OkRow>
            {!s.dialect && (
              <p className="text-[14px] leading-[20px] text-[#595959]">
                Next, on {machine}, open <b className="font-semibold text-[#1f1f1f]">http://localhost:7801</b> to add your database. The password goes there, not
                to Zavi.
              </p>
            )}
          </div>
        )}
        {s && !s.online && (
          <>
            {s.skipped && (
              <Banner tone="warning" title={`${s.skipped.feature} skipped: connector offline`}>
                It did not run at {skippedTime(s.skipped.at)}.{" "}
                {s.skipped.emailed ? "We emailed the owners and admins." : "We are emailing the owners and admins."} It runs again at its next scheduled
                time once the connector is back.
              </Banner>
            )}
            <div className="grid gap-2">
              <span className="text-[13px] font-medium leading-[18px] text-[#595959]">How to bring it back, on {machine}</span>
              <CodeBlock code="docker restart zavi-connector" label="On the connector machine" />
            </div>
          </>
        )}
        <div>
          <FormPrimaryButton type="button" onClick={onDone}>
            Done
          </FormPrimaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

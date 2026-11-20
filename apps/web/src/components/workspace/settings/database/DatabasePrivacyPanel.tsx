"use client";

import { useEffect, useState } from "react";
import { FormPanel, FormPrimaryButton, FormSecondaryButton } from "../formControls";
import { showConnectorError } from "../connectorErrorDialog";
import { getPrivacy, putPrivacy, type DbPrivacy } from "./databaseApi";
import { OkRow } from "./DatabaseSetupPanel";

type Raw = "run" | "7" | "30";
type Chat = "forever" | "90" | "30";

function Radio<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-medium leading-[18px] text-[#595959]">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.id}
            className={`flex h-10 cursor-pointer items-center gap-2 rounded-[10px] border px-3 text-[15px] font-medium ${
              value === o.id ? "border-[#0e0f11] text-[#0e0f11]" : "border-[#f0f0f0] text-[#1f1f1f]"
            }`}
          >
            <input type="radio" checked={value === o.id} onChange={() => onChange(o.id)} className="accent-[#0e0f11]" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function DatabasePrivacyPanel({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [data, setData] = useState<DbPrivacy | null>(null);
  const [raw, setRaw] = useState<Raw>("run");
  const [chat, setChat] = useState<Chat>("forever");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legacy = data !== null && (data.raw_results_retention === null || data.chat_retention === null);

  useEffect(() => {
    let live = true;
    getPrivacy()
      .then((d) => {
        if (!live) return;
        setData(d);
        setRaw(d.raw_results_retention ?? "run");
        setChat(d.chat_retention ?? "forever");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await putPrivacy({ raw_results_retention: raw, chat_retention: chat });
      onSaved();
    } catch (e) {
      showConnectorError({ title: "Couldn’t save", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormPanel>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-[16px] font-semibold text-[#0e0f11]">Privacy</p>
          {legacy ? (
            <p data-testid="privacy-legacy" className="text-[13px] text-amber-700">
              Raw results are kept until you choose. The options below are recommended, not saved yet.
            </p>
          ) : (
            <p className="text-[13px] text-[#595959]">Sensible defaults are set. You can change them later from Manage.</p>
          )}
        </div>
        {error && <p className="text-[14px] text-rose-700">{error}</p>}
        <Radio
          legend="Keep raw query results for"
          value={raw}
          onChange={setRaw}
          options={[
            { id: "run", label: "Delete after each run" },
            { id: "7", label: "7 days" },
            { id: "30", label: "30 days" },
          ]}
        />
        <Radio
          legend="Keep chat answers for"
          value={chat}
          onChange={setChat}
          options={[
            { id: "forever", label: "Forever" },
            { id: "90", label: "90 days" },
            { id: "30", label: "30 days" },
          ]}
        />
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium leading-[18px] text-[#595959]">AI model providers</span>
          <ul className="divide-y divide-[#f0f0f0] rounded-[12px] border border-[#f0f0f0] px-3.5">
            {(data?.providers ?? []).map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-[14px]">
                <span className="w-24 font-medium text-[#1f1f1f]">{p.name}</span>
                <span className="text-[13px] font-medium text-[#595959]">{p.line}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[13px] text-[#595959]">
          Your data is never used to train AI models.{" "}
          <a href="/security" className="font-semibold text-[#0e0f11] underline">
            Security details
          </a>
        </p>
        <div className="flex items-center gap-2.5">
          <FormPrimaryButton type="button" onClick={() => void save()} disabled={busy || !data}>
            Save and finish
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onCancel}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

export function DatabaseDonePanel({ onDone }: { onDone: () => void }) {
  return (
    <FormPanel>
      <div className="flex flex-col gap-2">
        <OkRow>Connected. Zavi can now answer questions from your database.</OkRow>
        <p className="text-[16px] leading-[22px] text-[#595959]">
          Every query Zavi runs is in the Data access tab. You can switch it off any time: Manage on this card has What
          Zavi can see, Data access log, Privacy and Disconnect.
        </p>
        <div className="mt-1">
          <FormPrimaryButton type="button" onClick={onDone}>
            Done
          </FormPrimaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

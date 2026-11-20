"use client";

import { confirmAction } from "@/components/ui/ConfirmDialog";

export type ConnectField = { key: string; label: string; placeholder: string; hint: string };

export async function askConnectField(appName: string, field: ConnectField): Promise<string | null> {
  const value = { current: "" };
  const ok = await confirmAction({
    title: `Connect ${appName}`,
    confirmLabel: "Continue",
    body: (
      <label className="block text-[13px] text-ink">
        <span className="font-medium">{field.label}</span>
        <input
          type="text"
          autoFocus
          placeholder={field.placeholder}
          onChange={(e) => { value.current = e.target.value; }}
          className="mt-1.5 w-full rounded-cta border border-rule bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink"
        />
        <span className="mt-1.5 block text-[12px] leading-[1.5] text-inkMuted">{field.hint}</span>
      </label>
    ),
  });
  const v = value.current.trim();
  return ok && v ? v : null;
}

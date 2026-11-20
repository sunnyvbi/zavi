"use client";

import { confirmAction } from "@/components/ui/ConfirmDialog";
import { FormPanel, FormPrimaryButton } from "../formControls";
import { showConnectorError } from "../connectorErrorDialog";
import { disconnectDb } from "./databaseApi";
import { CodeBlock, OkRow } from "./DatabaseSetupPanel";

export async function confirmAndDisconnect(): Promise<string | null> {
  const ok = await confirmAction({
    title: "Disconnect your database?",
    description: "Zavi deletes the stored login now and agents stop using your data. Your data access log is kept.",
    confirmLabel: "Delete login and disconnect",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!ok) return null;
  try {
    const r = await disconnectDb();
    return r.revoke_command;
  } catch (e) {
    showConnectorError({ title: "Couldn’t disconnect", message: (e as Error).message });
    return null;
  }
}

export function DisconnectedPanel({ revokeCommand, onDone }: { revokeCommand: string; onDone: () => void }) {
  return (
    <FormPanel>
      <div className="flex flex-col gap-3">
        <OkRow>Login deleted from Zavi. Disconnected.</OkRow>
        <div className="grid gap-2">
          <span className="text-[13px] font-medium leading-[18px] text-[#595959]">Last step, in your database</span>
          <p className="text-[14px] text-[#595959]">This removes the login itself, so nobody can use it, including Zavi.</p>
          <CodeBlock code={revokeCommand} label="In your database" />
          <span className="text-[12px] leading-[16px] text-[#8a8a8a]">
            Using Keep data on your server instead? Remove connector revokes the pairing; then run docker rm -f zavi-connector on your server.
          </span>
        </div>
        <div>
          <FormPrimaryButton type="button" onClick={onDone}>
            Done
          </FormPrimaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

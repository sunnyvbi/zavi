"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import {
  FormPanel,
  FormField,
  FormSelect,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type Project = { ref: string; name: string; region: string; status: string };
type ErrBody = { error?: { message?: string } };

export function SupabaseForm({ onClose }: { onClose: () => void }) {
  const [accessToken, setAccessToken] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectRef, setProjectRef] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ project: string } | null>(null);

  async function post(path: string, body: Record<string, unknown>) {
    const res = await apiFetch(`/api/connectors/supabase/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return null;
    }
    const parsed = (await res.json().catch(() => ({}))) as ErrBody & Record<string, unknown>;
    if (!res.ok || parsed.error) {
      throw new Error(parsed.error?.message ?? `HTTP ${res.status}`);
    }
    return parsed;
  }

  async function connect(chosen: string, list: Project[]) {
    const body = await post("connect", { access_token: accessToken, project_ref: chosen });
    if (!body) return;
    setDone({
      project: (body.project_name as string) ?? list.find((p) => p.ref === chosen)?.name ?? chosen,
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (projects && projectRef) {
        await connect(projectRef, projects);
        return;
      }
      const body = await post("projects", { access_token: accessToken });
      if (!body) return;
      const list = (body.projects as Project[]) ?? [];
      if (list.length === 1) {
        await connect(list[0].ref, list);
        return;
      }
      setProjects(list);
      setProjectRef(list[0]?.ref ?? "");
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect Supabase",
        message: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <FormPanel>
        <div className="flex flex-col gap-2">
          <div className="text-[14px] font-semibold text-[#0e0f11]">Connected to Supabase</div>
          <p className="text-[16px] leading-[19px] text-[#595959]">
            Reading from <strong className="font-semibold text-[#0e0f11]">{done.project}</strong>.
            Every agent call is pinned to this project.
          </p>
          <div className="mt-1">
            <FormPrimaryButton type="button" onClick={() => window.location.reload()}>
              Done
            </FormPrimaryButton>
          </div>
        </div>
      </FormPanel>
    );
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        <div className="rounded-[12px] border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3.5 text-[13px] leading-[18px] text-[#595959]">
          <div className="mb-2 text-[16px] font-semibold text-[#0e0f11]">
            How to connect Supabase (~1 min)
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              Open <strong>supabase.com/dashboard/account/tokens</strong> and generate a personal
              access token.
            </li>
            <li>Paste it below. We check it against your account before saving it.</li>
            <li>
              Pick the project agents may read. Supabase tokens are account-scoped, so this pick is
              what limits us to one project.
            </li>
          </ol>
        </div>

        <FormField label="Personal access token">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="sbp_…"
            autoComplete="off"
            required
          />
        </FormField>

        {projects && projects.length > 1 && (
          <FormField label="Project">
            <FormSelect value={projectRef} onChange={(e) => setProjectRef(e.target.value)}>
              {projects.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {p.name} ({p.region})
                </option>
              ))}
            </FormSelect>
          </FormField>
        )}

        <FormNote>
          Read-only. Agents read project metadata, edge functions and analytics; nothing in your
          database is written or migrated.
        </FormNote>

        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy || accessToken.trim().length < 20}>
            {busy ? "Checking…" : projects && projects.length > 1 ? "Connect project" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>Cancel</FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

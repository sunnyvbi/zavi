"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { toast } from "@/components/ui/toast";
import {
  FormPanel,
  FormField,
  FormSelect,
  FormSecretInput,
  FormNote,
  FormPrimaryButton,
  FormSecondaryButton,
} from "@/components/workspace/settings/formControls";

type Project = { id: string; name: string };
type ErrBody = { error?: { message?: string } };

export function PosthogForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);

  const picking = !!projects && projects.length > 1;

  async function post(path: string, body: Record<string, unknown>) {
    const res = await apiFetch(`/api/connectors/posthog/${path}`, {
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
    const body = await post("connect", { api_key: apiKey, region, project_id: chosen });
    if (!body) return;
    const name = list.find((p) => p.id === chosen)?.name ?? chosen;
    toast.add({ type: "success", title: `Connected to PostHog. Reading from ${name}.` });
    onConnected?.();
    onClose();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (projects && projectId) {
        await connect(projectId, projects);
        return;
      }
      const body = await post("projects", { api_key: apiKey, region });
      if (!body) return;
      const list = (body.projects as Project[]) ?? [];
      if (list.length === 0) {
        throw new Error("That key can't reach any PostHog project.");
      }
      if (list.length === 1) {
        await connect(list[0].id, list);
        return;
      }
      setProjects(list);
      setProjectId("");
    } catch (err) {
      showConnectorError({
        title: "Couldn’t connect PostHog",
        message: (err as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormPanel onSubmit={onSubmit}>
      <div className="grid gap-4">
        <div className="rounded-[12px] border border-[#f0f0f0] bg-[#f9f9f9] px-4 py-3.5 text-[13px] leading-[18px] text-[#595959]">
          <div className="mb-2 text-[16px] font-semibold text-[#0e0f11]">
            How to connect PostHog (~1 min)
          </div>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              In PostHog, open <strong>Settings → Personal API keys</strong> and create a key.
            </li>
            <li>
              Give it the <strong>Query Read</strong> and <strong>Project Read</strong> scopes. Those
              two are all we use; this connector never writes to PostHog.
            </li>
            <li>Paste the key below and pick the region your PostHog account is in. If the key reaches more than one project, choose the one to connect.</li>
          </ol>
        </div>

        <FormField label="Personal API key">
          <FormSecretInput
            show={showSecret}
            onToggle={() => setShowSecret((v) => !v)}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setProjects(null);
              setProjectId("");
            }}
            placeholder="phx_…"
            autoComplete="off"
            disabled={busy}
            required
          />
        </FormField>

        <FormField label="Region">
          <FormSelect
            value={region}
            disabled={busy}
            onChange={(e) => {
              setRegion(e.target.value === "eu" ? "eu" : "us");
              setProjects(null);
              setProjectId("");
            }}
          >
            <option value="us">US cloud (us.posthog.com)</option>
            <option value="eu">EU cloud (eu.posthog.com)</option>
          </FormSelect>
        </FormField>

        {picking && (
          <FormField label="Project">
            <FormSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="" disabled>
                Choose a project…
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </FormSelect>
          </FormField>
        )}

        <FormNote>
          Read-only. Agents run analytics queries against this project and never write to it.
        </FormNote>

        <div className="flex items-center gap-2">
          <FormPrimaryButton type="submit" disabled={busy || !apiKey || (picking && !projectId)}>
            {busy ? "Checking…" : picking ? "Connect project" : "Connect"}
          </FormPrimaryButton>
          <FormSecondaryButton onClick={onClose}>
            Cancel
          </FormSecondaryButton>
        </div>
      </div>
    </FormPanel>
  );
}

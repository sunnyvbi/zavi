import { File } from "expo-file-system";
import { apiFetch, apiJson } from "../../lib/api";
import { MARK_FAILED, REMOVE_FAILED } from "./copy";
import { mimeFor, uploadFailure, uploadName, type PickedFile, type ServerFile } from "./imports";
import type { SetupMark, SetupResponse } from "./types";

export function fetchSetup(): Promise<SetupResponse> {
  return apiJson<SetupResponse>("/api/workspace/setup", { timeoutMs: 20_000 });
}

export async function postProgress(mark: SetupMark): Promise<SetupResponse> {
  const res = await apiFetch("/api/workspace/setup/progress", { method: "POST", body: JSON.stringify(mark), timeoutMs: 30_000 });
  if (!res.ok) throw new Error(MARK_FAILED(res.status));
  return (await res.json()) as SetupResponse;
}

export function postDraft(retry: boolean): Promise<Response> {
  return apiFetch("/api/workspace/setup/draft", {
    method: "POST",
    body: JSON.stringify({ retry, paid: false }),
    retryOnNetworkError: false,
  });
}

export async function fetchImports(): Promise<ServerFile[] | null> {
  try {
    const res = await apiFetch("/api/knowledge/imports");
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { files?: ServerFile[] } | null;
    return Array.isArray(body?.files) ? body.files : null;
  } catch {
    return null;
  }
}

export async function uploadImport(file: PickedFile): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const src = new File(file.uri);
    const form = new FormData();
    const part = { name: uploadName(file.name), type: mimeFor(file), bytes: () => src.bytes() };
    form.append("file", part as unknown as Blob);
    const res = await apiFetch("/api/personalization/documents?purpose=import", {
      method: "POST",
      body: form,
      retryOnNetworkError: false,
    });
    const body = (await res.json().catch(() => null)) as { document?: { id?: string }; error?: { message?: string } } | null;
    if (!res.ok || !body?.document?.id) return { ok: false, reason: uploadFailure(res.status, body?.error?.message) };
    return { ok: true, id: body.document.id };
  } catch {
    return { ok: false, reason: "the connection dropped" };
  }
}

export async function deleteImport(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await apiFetch(`/api/knowledge/imports/${encodeURIComponent(id)}`, { method: "DELETE", retryOnNetworkError: false });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, reason: res.status === 409 && body?.error?.message ? body.error.message : REMOVE_FAILED };
  } catch {
    return { ok: false, reason: REMOVE_FAILED };
  }
}

export function kickRead(id: string): void {
  void apiFetch(`/api/knowledge/import/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => null);
}

export async function suggestCompetitors(): Promise<{ ok: boolean; names: string[]; pending: boolean }> {
  try {
    const res = await apiFetch("/api/connectors/company-facts/competitor-suggestions", { method: "POST" });
    const body = (await res.json().catch(() => null)) as { competitors?: unknown; pending?: boolean } | null;
    if (!res.ok) return { ok: false, names: [], pending: false };
    const names = Array.isArray(body?.competitors)
      ? body.competitors.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim())
      : [];
    return { ok: true, names, pending: body?.pending === true };
  } catch {
    return { ok: false, names: [], pending: false };
  }
}

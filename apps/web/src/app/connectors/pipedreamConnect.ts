
import { apiFetch } from "@/lib/api";

export async function startPipedreamConnect(app: string): Promise<void> {
  const res = await apiFetch(`/api/connectors/pipedream/${encodeURIComponent(app)}/connect`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    connect_link_url?: string | null;
    error?: { code?: string; message?: string };
  };
  if (!res.ok || !body.connect_link_url) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  window.location.href = body.connect_link_url;
}

"use client";

import { apiFetch } from "@/lib/api";

export async function fetchIntroVideoUrl(path: string): Promise<string> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "The video did not load. Try again.");
  }
  return URL.createObjectURL(await res.blob());
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
html,body{margin:0;height:100%;background:#0e0f11;color:#ececec;font:15px system-ui,-apple-system,"Segoe UI",sans-serif}
main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;box-sizing:border-box}
video{max-width:100%;max-height:calc(100vh - 80px);border-radius:12px;background:#000}
p{margin:0;color:#9a9a9a}
</style></head><body><main>${body}</main></body></html>`;
}

export function openIntroVideo(path: string, creatorName: string): boolean {
  const tab = window.open("", "_blank");
  if (!tab) return false;
  const title = `${creatorName}: intro video`;
  tab.document.write(page(title, `<p>Loading ${esc(creatorName)}'s intro video…</p>`));
  tab.document.close();
  fetchIntroVideoUrl(path)
    .then((url) => {
      if (tab.closed) {
        URL.revokeObjectURL(url);
        return;
      }
      tab.document.open();
      tab.document.write(
        page(title, `<video src="${url}" controls autoplay playsinline></video><p>${esc(creatorName)}'s intro video</p>`),
      );
      tab.document.close();
      tab.addEventListener("beforeunload", () => URL.revokeObjectURL(url));
    })
    .catch((e: unknown) => {
      if (tab.closed) return;
      tab.document.open();
      tab.document.write(page(title, `<p>${esc(e instanceof Error ? e.message : "The video did not load. Try again.")}</p>`));
      tab.document.close();
    });
  return true;
}

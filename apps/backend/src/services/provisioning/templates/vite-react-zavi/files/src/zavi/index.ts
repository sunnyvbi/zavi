
import { createZavi, type FetchLike, type KeyValueStorage, type LockManagerLike } from "./client";
import { DevStore } from "./devstore";
import { createLocalServer, type DevSeed } from "./local";
import { validateManifest } from "./manifest";
import manifestJson from "../../zavi-site.json";
import devSeed from "../../dev-seed.json";

export { ZaviError, isReauthRequired, needsSignIn, userMessage } from "./errors";
export { CAPTCHA_HEADER } from "./client";
export type { ZaviErrorCode, KernelReason } from "./errors";
export type {
  Session, User, ZaviRecord, Page, ListOptions, Filter, Order,
  ActionRequest, ActionResult, Transition, Member, MemberPage, CaptchaOption,
} from "./client";

const DEV_SITE_ID = "00000000-0000-4000-8000-00000000d0e0";

function safeLocalStorage(): KeyValueStorage | null {
  try {
    const s = window.localStorage;
    const probe = "zavi.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

async function resolveSiteId(fetchFn: FetchLike): Promise<string> {
  const injected = (window as unknown as { __ZAVI__?: { site_id?: unknown } }).__ZAVI__?.site_id;
  if (typeof injected === "string" && injected) return injected;
  const res = await fetchFn("/api/site", { method: "GET", headers: { accept: "application/json" } });
  const body = JSON.parse(await res.text()) as { data?: { site_id?: unknown } };
  if (res.status !== 200 || typeof body.data?.site_id !== "string") throw new Error("site bootstrap failed");
  return body.data.site_id;
}

function build() {
  const storage = safeLocalStorage();
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks ?? null;
  const watchStorage = (onKey: (k: string | null) => void) => {
    const h = (e: StorageEvent) => onKey(e.key);
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  };

  if (import.meta.env.DEV) {
    const checked = validateManifest(manifestJson);
    if (!checked.ok) {
      console.error("zavi-site.json is invalid:\n" + checked.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n"));
      throw new Error("zavi-site.json is invalid; see the console");
    }
    const store = new DevStore({ manifest: checked.value });
    const server = createLocalServer({
      store,
      siteId: `${DEV_SITE_ID}`,
      seed: devSeed as DevSeed,
      persist: storage,
      objectUrl: (body) => (body instanceof Blob ? URL.createObjectURL(body) : ""),
    });
    return createZavi({
      fetch: server.fetch,
      origin: window.location.origin,
      siteId: async () => DEV_SITE_ID,
      captchaSiteKey: async () => null,
      storage,
      locks,
      watchStorage,
    });
  }

  const fetchFn: FetchLike = (url, init) =>
    window.fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, credentials: "same-origin" });
  const injected = (window as unknown as { __ZAVI__?: { turnstile_site_key?: unknown } }).__ZAVI__;
  const injectedKey = injected && "turnstile_site_key" in injected
    ? async () => (typeof injected.turnstile_site_key === "string" && injected.turnstile_site_key ? injected.turnstile_site_key : null)
    : undefined;
  return createZavi({
    fetch: fetchFn,
    origin: window.location.origin,
    siteId: () => resolveSiteId(fetchFn),
    captchaSiteKey: injectedKey,
    storage,
    locks,
    watchStorage,
  });
}

export const zavi = build();

(window as unknown as { __zavi?: typeof zavi }).__zavi = zavi;

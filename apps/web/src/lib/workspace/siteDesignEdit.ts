import { apiFetch, IDEMPOTENCY_HEADER, newIdempotencyKey } from "@/lib/api";
import { notifyBuildSessionsChanged } from "@/lib/workspace/useBuildSessions";

const SITE_DESIGN_SETTLE_ATTEMPTS = 225;

export type ThemeColorKey = "primary" | "background" | "foreground" | "accent";

export type SiteThemeTokens = {
  name: string;
  colors: Record<ThemeColorKey, string>;
  fonts: { display: string; body: string };
  radius: string;
};

export type SiteSectionInfo = {
  id: string;
  component: string;
  variant: string | null;
  tone: string | null;
  variants: string[];
  tones: string[];
  can_move_up: boolean;
  can_move_down: boolean;
};

export type SiteDesignEditState = {
  theme: SiteThemeTokens | null;
  fonts: string[];
  radii: string[];
  section: SiteSectionInfo | null;
  section_message: string | null;
  image_ai: boolean;
  image_ai_mask: boolean;
  logo_ai: boolean;
  logo_preview_free: boolean;
};

export type SitePhotoPreview = { data_url: string; width: number; height: number };

export type SiteDesignOp =
  | {
      kind: "theme";
      colors?: Partial<Record<ThemeColorKey, string>>;
      fonts?: { display?: string; body?: string };
      radius?: string;
      logo?: { preview_id: string } | { name_only: true };
    }
  | { kind: "section"; section_id: string; variant?: string; tone?: string; move?: "up" | "down" }
  | { kind: "image"; src: string; mode: "generate" | "edit" | "url"; text: string; mask?: string }
  | { kind: "logo"; description: string };

export type SiteDesignEditResult =
  | { ok: true; theme: SiteThemeTokens | null; section: SiteSectionInfo | null; image: { src: string; srcset: string; places: number } | null; logo: { src: string } | null; changeId?: string | null }
  | { ok: false; code: string | null; message: string };

export const SITE_DESIGN_SAVED = "Saved. It goes live when you publish.";
export const SITE_DESIGN_UNREACHABLE = "We couldn't reach the server. Nothing was changed. Try again.";
const FAILED = "We couldn't save that change. Try again, or ask for it in the chat.";

function siteQuery(appId: string, extra: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams({ app_id: appId });
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  return q.toString();
}

export async function loadSiteDesignEdit(
  appId: string,
  opts: { section?: string | null; path?: string | null } = {},
): Promise<{ ok: true; state: SiteDesignEditState } | { ok: false; message: string }> {
  try {
    const res = await apiFetch(`/api/website/site-design-edit?${siteQuery(appId, { section: opts.section, path: opts.path })}`);
    const body = (await res.json().catch(() => null)) as (SiteDesignEditState & { error?: { message?: unknown } }) | null;
    if (!res.ok || !body) {
      const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : FAILED;
      return { ok: false, message };
    }
    return {
      ok: true,
      state: {
        theme: body.theme ?? null,
        fonts: Array.isArray(body.fonts) ? body.fonts : [],
        radii: Array.isArray(body.radii) ? body.radii : [],
        section: body.section ?? null,
        section_message: typeof body.section_message === "string" ? body.section_message : null,
        image_ai: body.image_ai === true,
        image_ai_mask: body.image_ai === true && body.image_ai_mask === true,
        logo_ai: body.logo_ai === true,
        logo_preview_free: body.logo_ai === true && body.logo_preview_free === true,
      },
    };
  } catch {
    return { ok: false, message: SITE_DESIGN_UNREACHABLE };
  }
}

export async function loadSitePhoto(appId: string, src: string): Promise<{ ok: true; photo: SitePhotoPreview } | { ok: false; message: string }> {
  try {
    const res = await apiFetch(`/api/website/site-design-edit?${siteQuery(appId, { photo: src })}`);
    const body = (await res.json().catch(() => null)) as { photo?: Partial<SitePhotoPreview>; error?: { message?: unknown } } | null;
    const photo = body?.photo;
    if (
      !res.ok ||
      !photo ||
      typeof photo.data_url !== "string" ||
      !photo.data_url.startsWith("data:image/") ||
      !(typeof photo.width === "number" && photo.width > 0) ||
      !(typeof photo.height === "number" && photo.height > 0)
    ) {
      const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : FAILED;
      return { ok: false, message };
    }
    return { ok: true, photo: { data_url: photo.data_url, width: photo.width, height: photo.height } };
  } catch {
    return { ok: false, message: SITE_DESIGN_UNREACHABLE };
  }
}

type DesignEditBody = {
  theme?: SiteThemeTokens | null;
  section?: SiteSectionInfo | null;
  image?: { src: string; srcset: string; places: number } | null;
  logo?: { src: string; design?: unknown } | null;
  preview?: { id?: unknown; src?: unknown; free?: unknown; design?: unknown } | null;
  conductor_run_id?: unknown;
  error?: { code?: unknown; message?: unknown };
};

async function postDesignEdit(payload: Record<string, unknown>): Promise<{ res: Response; body: DesignEditBody | null }> {
  const key = newIdempotencyKey();
  const send = async () => {
    const res = await apiFetch("/api/website/site-design-edit", {
      method: "POST",
      idempotent: true,
      headers: { "Content-Type": "application/json", [IDEMPOTENCY_HEADER]: key },
      body: JSON.stringify(payload),
    });
    return { res, body: (await res.json().catch(() => null)) as DesignEditBody | null };
  };
  let response = await send();
  for (let attempt = 0; attempt < SITE_DESIGN_SETTLE_ATTEMPTS && response.body?.error?.code === "idempotency_in_progress"; attempt++) {
    response = await send();
  }
  return response;
}

function refusal(res: Response, body: DesignEditBody | null): { ok: false; code: string | null; message: string } {
  const code = typeof body?.error?.code === "string" ? body.error.code : null;
  const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : FAILED;
  return { ok: false, code, message: res.status === 403 && code === "forbidden" ? "Viewers can't change the site. Ask a workspace owner, admin or member." : message };
}

export async function saveSiteDesignEdit(appId: string, op: SiteDesignOp, path?: string | null): Promise<SiteDesignEditResult> {
  try {
    const { res, body } = await postDesignEdit({ app_id: appId, op, ...(path ? { path } : {}) });
    if (!res.ok) return refusal(res, body);
    notifyBuildSessionsChanged();
    return { ok: true, theme: body?.theme ?? null, section: body?.section ?? null, image: body?.image ?? null, logo: body?.logo ?? null, changeId: typeof body?.conductor_run_id === "string" ? body.conductor_run_id : null };
  } catch {
    return { ok: false, code: null, message: SITE_DESIGN_UNREACHABLE };
  }
}

export type SiteLogoDesign = { type: string; rationale: string };
export type SiteLogoPreview = { id: string; src: string; free: boolean; design: SiteLogoDesign | null };

export function readLogoDesign(raw: unknown): SiteLogoDesign | null {
  const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  return d && typeof d.type === "string" && d.type && typeof d.rationale === "string" && d.rationale ? { type: d.type, rationale: d.rationale } : null;
}

export const LOGO_TYPE_LABEL: Readonly<Record<string, string>> = {
  monogram: "Monogram",
  pictorial: "Pictorial mark",
  abstract: "Abstract mark",
  mascot: "Mascot",
  emblem: "Emblem",
  wordmark: "Wordmark",
};

export async function previewSiteLogo(
  appId: string,
  input: { description: string; colors?: { primary: string; accent: string } | null },
): Promise<{ ok: true; preview: SiteLogoPreview } | { ok: false; code: string | null; message: string }> {
  try {
    const { res, body } = await postDesignEdit({
      app_id: appId,
      op: { kind: "logo_preview", description: input.description, ...(input.colors ? { colors: input.colors } : {}) },
    });
    if (!res.ok) return refusal(res, body);
    const p = body?.preview;
    if (!p || typeof p.id !== "string" || typeof p.src !== "string" || !p.src.startsWith("data:image/svg+xml")) {
      return { ok: false, code: null, message: FAILED };
    }
    return { ok: true, preview: { id: p.id, src: p.src, free: p.free === true, design: readLogoDesign(p.design) } };
  } catch {
    return { ok: false, code: null, message: SITE_DESIGN_UNREACHABLE };
  }
}

export function layoutLabel(id: string): string {
  return id ? id[0]!.toUpperCase() + id.slice(1) : id;
}

export const TONE_LABEL: Record<string, string> = { default: "Page", muted: "Soft", inverse: "Contrast" };

export const RADIUS_LABEL: Record<string, string> = {
  "0": "Square",
  "0.25rem": "Slight",
  "0.5rem": "Soft",
  "0.75rem": "Rounded",
  "1rem": "Round",
  "1.5rem": "Pill",
};

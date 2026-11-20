import { apiFetch } from "../../lib/api";
import { messageOf, type ActiveStatus, type AdPlace, type LocationStatus, type Suggestions } from "./adLocations";

const base = (slug: string) => `/api/channels/${encodeURIComponent(slug)}/ad-locations`;

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

export async function fetchLocationStatus(slug: string): Promise<LocationStatus | null> {
  try {
    const res = await apiFetch(base(slug));
    return res.ok ? await readJson<LocationStatus>(res) : null;
  } catch {
    return null;
  }
}

export async function fetchSuggestions(slug: string, status: ActiveStatus): Promise<{ sugg: Suggestions; error: string | null }> {
  const empty: Suggestions = { orders: "not_set_up", country: status.country, places: [], picked: [] };
  try {
    const res = await apiFetch(`${base(slug)}/suggestions`);
    const body = await readJson<Suggestions>(res);
    if (res.ok && body) return { sugg: body, error: null };
    return { sugg: empty, error: messageOf(body, "Zavi couldn't load suggestions. You can still search for places.") };
  } catch {
    return { sugg: empty, error: "Zavi couldn't load suggestions. You can still search for places." };
  }
}

export async function searchPlaces(slug: string, q: string): Promise<AdPlace[]> {
  try {
    const res = await apiFetch(`${base(slug)}/search?q=${encodeURIComponent(q)}`);
    const body = await readJson<{ places?: AdPlace[] }>(res);
    return res.ok ? body?.places ?? [] : [];
  } catch {
    return [];
  }
}

export async function saveLocations(
  slug: string,
  status: ActiveStatus,
  places: readonly AdPlace[],
  applyAll?: boolean,
): Promise<string | null> {
  try {
    const res = await apiFetch(base(slug), {
      method: "POST",
      body: JSON.stringify({
        campaign_id: status.campaign.id,
        fingerprint: status.fingerprint,
        places: places.map((p) => ({ id: p.id, name: p.name })),
        ...(status.targeting === "mixed" ? { apply_to_all: applyAll === true } : {}),
      }),
      retryOnNetworkError: false,
    });
    const body = await readJson<{ approved?: boolean; decision_id?: string | null }>(res);
    if (!res.ok) return messageOf(body, "That didn't save. Try again.");
    if (body?.decision_id && body.approved === false) {
      return "Zavi saved your places but couldn't apply them. Approve the change in Channels.";
    }
    return null;
  } catch {
    return "That didn't save. Try again.";
  }
}

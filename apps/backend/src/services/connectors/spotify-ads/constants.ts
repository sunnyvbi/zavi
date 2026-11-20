
export const SPOTIFY_ADS_SLUG = "spotify_ads";
export const SPOTIFY_ADS_ACCESS_TOKEN_KEY = `${SPOTIFY_ADS_SLUG}.access_token`;
export const SPOTIFY_ADS_REFRESH_TOKEN_KEY = `${SPOTIFY_ADS_SLUG}.refresh_token`;

export const SPOTIFY_ADS_API_BASE = "https://api-partner.spotify.com/ads/v3/";
export const SPOTIFY_ADS_SCOPES = [] as const;
export const SPOTIFY_ADS_DEFAULT_TTL_SEC = 3600;

export function spotifyAdsCreds(): { id: string; secret: string } {
  const id = process.env.SPOTIFY_ADS_CLIENT_ID?.trim();
  const secret = process.env.SPOTIFY_ADS_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("SPOTIFY_ADS_CLIENT_ID and SPOTIFY_ADS_CLIENT_SECRET must be set.");
  return { id, secret };
}

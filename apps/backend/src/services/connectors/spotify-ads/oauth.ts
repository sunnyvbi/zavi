
import type { ConnectorOAuth } from "../core/types";
import { oauth2AuthCode } from "../core/oauth2-authcode";
import {
  SPOTIFY_ADS_ACCESS_TOKEN_KEY,
  SPOTIFY_ADS_DEFAULT_TTL_SEC,
  SPOTIFY_ADS_REFRESH_TOKEN_KEY,
  SPOTIFY_ADS_SCOPES,
  SPOTIFY_ADS_SLUG,
  spotifyAdsCreds,
} from "./constants";

const flow = oauth2AuthCode({
  slug: SPOTIFY_ADS_SLUG,
  authorizeUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  scopes: SPOTIFY_ADS_SCOPES,
  clientAuth: "basic",
  creds: spotifyAdsCreds,
  accessTokenKey: SPOTIFY_ADS_ACCESS_TOKEN_KEY,
  refreshTokenKey: SPOTIFY_ADS_REFRESH_TOKEN_KEY,
  defaultTtlSec: SPOTIFY_ADS_DEFAULT_TTL_SEC,
  async identify(accessToken) {
    const { listSpotifyAdAccountsRaw } = await import("./client");
    const accounts = await listSpotifyAdAccountsRaw(accessToken);
    const first = accounts[0];
    return {
      team_id: first?.id ?? "no_ad_account",
      team_name: first
        ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
        : "Spotify Ads (no ad account)",
    };
  },
});

export const spotifyAdsConnector: ConnectorOAuth = {
  slug: SPOTIFY_ADS_SLUG,
  serverId: SPOTIFY_ADS_SLUG,
  scopes: [...SPOTIFY_ADS_SCOPES],
  ...flow,
};

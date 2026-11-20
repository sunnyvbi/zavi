export const META_TOKEN_EXPIRED_MESSAGE =
  "Meta Ads needs to be reconnected — the Facebook access token has expired or was " +
  "invalidated (this happens if the Facebook password changed, access was revoked, " +
  "or the login was checkpointed). No campaign data can be read until it is reconnected.";
export const META_PERMISSION_REVOKED_MESSAGE =
  "The connected Facebook user no longer has the required permission on this ad " +
  "account. The token is still valid, so reconnecting alone may not be enough — " +
  "the account role has to be restored in Meta Business Settings.";

export function metaCodeOfMessage(message: string): "meta_ads_token_expired" | "meta_ads_permission_revoked" | null {
  if (message.includes(META_TOKEN_EXPIRED_MESSAGE)) return "meta_ads_token_expired";
  if (message.includes(META_PERMISSION_REVOKED_MESSAGE)) return "meta_ads_permission_revoked";
  return null;
}

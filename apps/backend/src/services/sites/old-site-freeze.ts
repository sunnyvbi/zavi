
export const OLD_SITE_FROZEN_CODE = "old_site_frozen";

export const REBUILD_ACTION_LABEL = "Rebuild on the new builder";

export const OLD_SITE_FROZEN_MESSAGE =
  "This site was made with our earlier builder. It stays live exactly as it is, but it can't be changed anymore. " +
  `To make changes, choose "${REBUILD_ACTION_LABEL}". That starts a fresh site with the same name and description. ` +
  "Your old site's saved data, like form entries or sign-ups, does not move over. " +
  "Your old site stays live until you point your domain at the new one.";

export class OldSiteFrozen extends Error {
  readonly code = OLD_SITE_FROZEN_CODE;
  constructor(public readonly tenant_id: string) {
    super(OLD_SITE_FROZEN_MESSAGE);
    this.name = "OldSiteFrozen";
  }
}

export function oldSiteFrozenBody(): {
  error: { code: typeof OLD_SITE_FROZEN_CODE; message: string; chat: string; action: { kind: "rebuild_old_site"; label: string } };
} {
  return {
    error: {
      code: OLD_SITE_FROZEN_CODE,
      message: OLD_SITE_FROZEN_MESSAGE,
      chat: OLD_SITE_FROZEN_MESSAGE,
      action: { kind: "rebuild_old_site", label: REBUILD_ACTION_LABEL },
    },
  };
}

export const OLD_SITE_FROZEN_STATUS = 409;


export const DEFAULT_SYSTEM_EMAIL_FROM = "support@zaviagent.com";

export const DEFAULT_SYSTEM_EMAIL_FROM_NAME = "Zavi";

const LEGACY_ENV_VAR = "SYSTEM_EMAIL_FROM";

let warnedLegacy = false;

export interface SystemSender {
  email: string;
  name: string;
}

export function systemSender(): SystemSender {
  warnIfLegacyVarSet();
  return {
    email: process.env.ZAVI_EMAIL_FROM?.trim() || DEFAULT_SYSTEM_EMAIL_FROM,
    name: process.env.ZAVI_EMAIL_FROM_NAME?.trim() || DEFAULT_SYSTEM_EMAIL_FROM_NAME,
  };
}

export function systemSenderEmail(): string {
  return systemSender().email;
}

function warnIfLegacyVarSet(): void {
  if (warnedLegacy) return;
  const legacy = process.env[LEGACY_ENV_VAR]?.trim();
  if (!legacy) return;
  warnedLegacy = true;
  console.warn(
    `[system-identity] ${LEGACY_ENV_VAR}="${legacy}" is set but IGNORED — it was retired ` +
      `2026-09-07 because a stale value there kept prod sending as hello@thepraxis.ai ` +
      `long after the secret was corrected. The sender now defaults to ` +
      `${DEFAULT_SYSTEM_EMAIL_FROM} in code; override with ZAVI_EMAIL_FROM. ` +
      `Delete ${LEGACY_ENV_VAR} from AWS Secrets Manager praxis-envprod-1.`,
  );
}

export function __resetLegacyWarnForTests(): void {
  warnedLegacy = false;
}

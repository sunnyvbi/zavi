
export type KnownGatekeeperFlag = {
  name: string;
  description: string;
  defaultEnabled: boolean;
  cachePolicy: "critical" | "standard";
};

export const MULTI_WORKSPACE_FLAG = "multi-workspace";

export const KNOWN_GATEKEEPER_FLAGS: readonly KnownGatekeeperFlag[] = [
  {
    name: MULTI_WORKSPACE_FLAG,
    description:
      "Lets a user who already owns a company add another one (workspace switcher → Add company). OFF = one company per account; existing extra companies are kept. First signup is never gated.",
    defaultEnabled: false,
    cachePolicy: "critical",
  },
];

import { creatorApi, CreatorApiError, type CreatorMe } from "./api";

export type CreatorIdentity =
  | { kind: "creator"; me: CreatorMe }
  | { kind: "blocked"; message: string }
  | { kind: "not_creator"; message: string };

export async function fetchCreatorIdentity(): Promise<CreatorIdentity> {
  try {
    const me = await creatorApi.me();
    return { kind: "creator", me };
  } catch (e) {
    if (e instanceof CreatorApiError && e.status === 403) {
      if (e.code === "not_approved") return { kind: "blocked", message: e.message };
      if (e.code === "not_a_creator") return { kind: "not_creator", message: e.message };
    }
    throw e;
  }
}

export function identityIsCreator(identity: CreatorIdentity | undefined): boolean {
  return identity?.kind === "creator" || identity?.kind === "blocked";
}

export function identityMemberId(identity: CreatorIdentity | undefined): string | null {
  return identity?.kind === "creator" ? identity.me.creator.id : null;
}

import { creatorApi } from "./api";

export const CREATOR_SIGNUP_FLAG = "zavi_signup";

type SignedInUser = { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined;

export function signedUpAsCreator(user: SignedInUser): boolean {
  return user?.user_metadata?.[CREATOR_SIGNUP_FLAG] === "creator";
}

type AccountHome = Awaited<ReturnType<typeof creatorApi.home>>;

export async function creatorHome(user: SignedInUser, typedEmail = "", known?: AccountHome) {
  let home = known ?? (await creatorApi.home());
  let created = false;
  if (home.home === "/start" && !home.in_any_company && !home.is_creator) {
    const meta = user?.user_metadata ?? {};
    const name = String(meta.full_name ?? meta.name ?? (user?.email ?? typedEmail).split("@")[0] ?? "").trim();
    created = (await creatorApi.signup(name || "Creator")).created;
    home = await creatorApi.home();
  }
  return { home, created };
}

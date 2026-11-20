import { z } from "zod";

export const redditId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const redditLevel = z.enum(["campaign", "ad_group", "ad"]);
export type RedditLevel = z.infer<typeof redditLevel>;

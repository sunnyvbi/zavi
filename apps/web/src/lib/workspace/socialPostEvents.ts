export const SOCIAL_POSTED_EVENT = "zavi:social-posted";

export function announceSocialPosted(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SOCIAL_POSTED_EVENT));
}

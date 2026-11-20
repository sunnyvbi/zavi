
import type { Colors } from "../../theme/tokens";

export function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function agentAvatarColor(colors: Colors, slug: string): string {
  const AVATAR_BG = [colors.avatarDefault, colors.avatarGreen, colors.avatarBlue, colors.avatarOrange];
  if (slug === "operator") return colors.avatarOrange;
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return AVATAR_BG[h % AVATAR_BG.length];
}

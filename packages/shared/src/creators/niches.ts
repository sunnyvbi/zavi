
export const CREATOR_NICHES = [
  "Food and drink",
  "Lifestyle",
  "Beauty",
  "Fitness",
  "Tech",
  "Apps",
  "Home",
  "Pets",
  "Travel",
  "Fashion",
  "Local",
] as const;

export type CreatorNiche = (typeof CREATOR_NICHES)[number];

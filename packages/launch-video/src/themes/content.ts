import type { InUse } from './in-use/plan';

export type FilmContent = {
  product_name: string;
  one_liner: string;
  problem?: string;
  surface?: { title: string; items: { title: string; chips: string[] }[] };
  features: { title: string; detail: string }[];
  metrics?: { stat: string; label: string }[];
  regions?: string[];
  cta_text: string;
  cta_url: string;
  theme?: string;
  marks?: { title: string; src: string; hex: string }[];
  in_use?: InUse;
  brand?: { accent?: string; ground?: string; ink?: string };
  journey?: import('./journey/types').Station[];
};


import type { ReactNode } from "react";

export type Feature = { label: string; icon: ReactNode };
export type FeatureColumn = { title: string; color: string; items: Feature[] };

export const FEATURE_COLUMNS: FeatureColumn[] = [
  {
    title: "Optimize",
    color: "#f06a35",
    items: [
      { label: "Bid & budget optimization", icon: <><path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" /></> },
      { label: "ROAS improvement", icon: <><path d="M5 21v-6" /><path d="M12 21V3" /><path d="M19 21V9" /></> },
      { label: "Dayparting & scheduling", icon: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></> },
      { label: "Audience refinement", icon: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></> },
      { label: "Placement optimization", icon: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></> },
      { label: "Device bid adjustments", icon: <><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></> },
    ],
  },
  {
    title: "Create",
    color: "#9b5de5",
    items: [
      { label: "Ad creative generation", icon: <><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" /></> },
      { label: "Headline & copy testing", icon: <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></> },
      { label: "A/B testing", icon: <><path d="M15 6a9 9 0 0 0-9 9V3" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /></> },
      { label: "Dynamic ad variants", icon: <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></> },
      { label: "Video ad hooks", icon: <><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></> },
      { label: "Responsive search ads", icon: <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></> },
    ],
  },
  {
    title: "Audit",
    color: "#14a38b",
    items: [
      { label: "Wasted spend detection", icon: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></> },
      { label: "Negative keyword mining", icon: <><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /></> },
      { label: "Quality Score fixes", icon: <><circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" /></> },
      { label: "Conversion tracking audit", icon: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></> },
      { label: "Account structure review", icon: <><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></> },
      { label: "Search term analysis", icon: <><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /></> },
    ],
  },
  {
    title: "Report",
    color: "#d99a00",
    items: [
      { label: "Slack & Teams alerts", icon: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></> },
      { label: "Automated performance reports", icon: <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M8 18v-1" /><path d="M12 18v-6" /><path d="M16 18v-3" /></> },
      { label: "Custom dashboards", icon: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></> },
      { label: "Budget pacing alerts", icon: <><path d="M16 17h6v-6" /><path d="m22 17-8.5-8.5-5 5L2 7" /></> },
      { label: "Competitor benchmarking", icon: <><path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2" /><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2" /><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3" /><path d="M4 22h16" /><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z" /><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3" /></> },
      { label: "Weekly AI summaries", icon: <><path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" /></> },
    ],
  },
];

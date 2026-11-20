"use client";

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function MobileMenuIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} strokeWidth={1.7} className={className} aria-hidden>
      <path d="M4 6h12M4 12h16M4 18h9" />
    </svg>
  );
}

export function MobileNewChatIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} strokeWidth={1.7} className={className} aria-hidden>
      <path d="M13 4H7a4 4 0 0 0-4 4v10a3 3 0 0 0 3 3h11a4 4 0 0 0 4-4v-6M11 15l-4 1 1-4L18 2l4 4Z" />
    </svg>
  );
}

export function MobileBackIcon({ className }: { className?: string }) {
  return (
    <svg {...BASE} strokeWidth={1.9} className={className} aria-hidden>
      <path d="m15 5-7 7 7 7" />
    </svg>
  );
}

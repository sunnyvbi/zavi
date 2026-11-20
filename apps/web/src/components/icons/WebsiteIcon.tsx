import type { SVGProps } from "react";

export function WebsiteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="1.9" y="3.1" width="16.2" height="13.8" rx="3.6" />
      <path d="M1.9 7.4h16.2" />
      <path d="M4.9 5.25h.01M7.4 5.25h.01" strokeWidth="2" />
    </svg>
  );
}

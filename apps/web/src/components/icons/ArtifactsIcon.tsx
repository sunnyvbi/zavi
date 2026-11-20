import type { SVGProps } from "react";

export function ArtifactsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 5.5V5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 5v.5" />
      <path d="M6.5 9v-.5A1.5 1.5 0 0 1 8 7h8a1.5 1.5 0 0 1 1.5 1.5V9" />
      <path d="M5.5 10.5h13a2 2 0 0 1 1.9 2.6l-2.2 6.4a2 2 0 0 1-1.9 1.4H7.7a2 2 0 0 1-1.9-1.4l-2.2-6.4a2 2 0 0 1 1.9-2.6Z" />
    </svg>
  );
}

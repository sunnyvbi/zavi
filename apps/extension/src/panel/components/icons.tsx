
import type { ReactNode, JSX } from "react";

type IconProps = { className?: string };

function Svg(props: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M12 2.8l7 2.8v5.6c0 4.4-2.9 8.2-7 9.5-4.1-1.3-7-5.1-7-9.5V5.6l7-2.8Z" />
      <path d="M9.2 11.9l2 2 3.6-3.7" />
    </Svg>
  );
}

export function PeopleIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M15.8 20v-1.8a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.2V20" />
      <circle cx="9.4" cy="7.4" r="3.4" />
      <path d="M21 20v-1.8a3.6 3.6 0 0 0-2.7-3.48" />
      <path d="M15.6 4.12a3.6 3.6 0 0 1 0 6.97" />
    </Svg>
  );
}

export function WarningIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M10.7 3.6 2.4 18a1.5 1.5 0 0 0 1.3 2.2h16.6a1.5 1.5 0 0 0 1.3-2.2L13.3 3.6a1.5 1.5 0 0 0-2.6 0Z" />
      <path d="M12 9v4.4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

export function NewThreadIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M21 11.6a8.4 8.4 0 0 1-11.9 7.6L3.5 21l1.8-5.4A8.4 8.4 0 1 1 21 11.6Z" />
      <path d="M12 8.6v5" />
      <path d="M9.5 11.1h5" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 0 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H3a2 2 0 0 1 0-4h.11a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.47V3a2 2 0 0 1 4 0v.11a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47.97H21a2 2 0 0 1 0 4h-.11a1.6 1.6 0 0 0-1.47.97Z" />
    </Svg>
  );
}

export function CameraIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2a1.5 1.5 0 0 0 1.3-.75l.7-1.2A1.5 1.5 0 0 1 10 4.3h4a1.5 1.5 0 0 1 1.3.75l.7 1.2A1.5 1.5 0 0 0 17.3 7h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" />
      <circle cx="12" cy="13" r="3.2" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
      <path d="M15.5 8.5V5.8A1.8 1.8 0 0 0 13.7 4H5.8A1.8 1.8 0 0 0 4 5.8v7.9a1.8 1.8 0 0 0 1.8 1.8h2.7" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M5 12.5 10 17.5 19 7" />
    </Svg>
  );
}

export function SendIcon(props: IconProps): JSX.Element {
  return (
    <Svg className={props.className}>
      <path d="M12 19.5V5" />
      <path d="M5.8 11.2 12 4.9l6.2 6.3" />
    </Svg>
  );
}

export function ZaviMark(props: { size?: number; className?: string }): JSX.Element {
  const size = props.size ?? 20;
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="22" height="22" rx="7" fill="currentColor" />
      <path
        d="M8 8h8l-8 8h8"
        fill="none"
        stroke="var(--zv-bg)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

import Svg, { Circle, Ellipse, Line, Path, Polyline, Rect } from "react-native-svg";
import { useTheme } from "../theme/theme";

export type IconName =
  | "menu"
  | "edit"
  | "plus"
  | "mic"
  | "send"
  | "copy"
  | "check"
  | "thumb"
  | "chevron"
  | "chevronLeft"
  | "trending"
  | "user"
  | "bell"
  | "building"
  | "users"
  | "card"
  | "wallet"
  | "replay"
  | "motion"
  | "timer"
  | "mail"
  | "key"
  | "sun"
  | "moon"
  | "smartphone"
  | "paperclip"
  | "more"
  | "share"
  | "pin"
  | "trash"
  | "logout"
  | "pencil"
  | "rename"
  | "close"
  | "library"
  | "file"
  | "photo"
  | "camera"
  | "video"
  | "blocks"
  | "hamburger"
  | "compose"
  | "dots"
  | "arrowUp"
  | "externalLink"
  | "alertCircle"
  | "calendarList"
  | "target"
  | "chartColumn"
  | "refresh"
  | "swords"
  | "sprout"
  | "image"
  | "presentation"
  | "home"
  | "shieldCheck"
  | "inbox"
  | "appWindow"
  | "bot"
  | "atSign"
  | "messages"
  | "package"
  | "gear"
  | "panelClose"
  | "search"
  | "chevronDown"
  | "add"
  | "plus"
  | "pinSmall"
  | "tick"
  | "lock"
  | "messageSquare"
  | "database"
  | "filter"
  | "scroll"
  | "hand"
  | "sparkles"
  | "loader"
  | "shieldAlert"
  | "eye"
  | "upload"
  | "helpCircle";

export function Icon({
  name,
  size = 22,
  color: colorProp,
  strokeWidth = 1.5,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const { colors } = useTheme();
  const color = colorProp ?? colors.ink;
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <Svg width={size} height={size} viewBox={name === "send" ? "0 0 20 20" : "0 0 24 24"}>
      {name === "menu" ? <Path d="M4 6h12M4 12h16M4 18h9" {...stroke} /> : null}

      {name === "edit" ? (
        <Path
          d="M13 4H7a4 4 0 0 0-4 4v10a3 3 0 0 0 3 3h11a4 4 0 0 0 4-4v-6M11 15l-4 1 1-4L18 2l4 4Z"
          {...stroke}
        />
      ) : null}

      {name === "plus" ? <Path d="M12 4v16M4 12h16" {...stroke} /> : null}

      {name === "chevronLeft" ? <Path d="m14.5 5.5-6.5 6.5 6.5 6.5" {...stroke} /> : null}

      {}
      {name === "chevron" ? <Path d="m7 9 5 5 5-5" {...stroke} /> : null}

      {}
      {name === "trending" ? <Path d="m22 7-8.5 8.5-5-5L2 17M16 7h6v6" {...stroke} /> : null}

      {name === "library" ? (
        <>
          <Rect x="3" y="3" width="5" height="18" rx="1" {...stroke} />
          <Rect x="10" y="3" width="5" height="18" rx="1" {...stroke} />
          <Path d="m17 4 3-1 4 17-3 1Z" {...stroke} />
        </>
      ) : null}

      {}
      {name === "blocks" ? (
        <>
          <Rect x="14" y="3" width="7" height="7" rx="1" {...stroke} />
          <Path
            d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"
            {...stroke}
          />
        </>
      ) : null}

      {name === "mic" ? (
        <>
          <Rect x="9" y="2" width="6" height="13" rx="3" {...stroke} />
          <Path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M9 22h6" {...stroke} />
        </>
      ) : null}

      {name === "copy" ? (
        <>
          <Rect x="9" y="8" width="12" height="14" rx="3" {...stroke} />
          <Path d="M15 8V5a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h3" {...stroke} />
        </>
      ) : null}

      {name === "check" ? <Path d="m5 12 4 4L19 6" {...stroke} /> : null}

      {}
      {name === "thumb" ? (
        <Path d="M7 10v11H3V10Zm0 1 5-8c1-2 3-1 3 1v5h4c2 0 3 1 2 4l-2 6c0 1-1 2-3 2H7" {...stroke} />
      ) : null}

      {}
      {name === "user" ? (
        <>
          <Circle cx="12" cy="8" r="4" {...stroke} />
          <Path d="M4 21a8 8 0 0 1 16 0" {...stroke} />
        </>
      ) : null}

      {name === "bell" ? <Path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4ZM10 21h4" {...stroke} /> : null}

      {name === "building" ? (
        <>
          <Rect x="4" y="3" width="16" height="18" rx="1.5" {...stroke} />
          <Path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" {...stroke} />
        </>
      ) : null}

      {name === "users" ? (
        <>
          <Circle cx="9" cy="8" r="3.5" {...stroke} />
          <Path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M17.5 13.5a6 6 0 0 1 4.5 6.5" {...stroke} />
        </>
      ) : null}

      {name === "card" ? (
        <>
          <Rect x="2" y="5" width="20" height="14" rx="2" {...stroke} />
          <Path d="M2 10h20M6 15h4" {...stroke} />
        </>
      ) : null}

      {name === "wallet" ? (
        <>
          <Path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" {...stroke} />
          <Path d="M21 8h-5a4 4 0 0 0 0 8h5Z" {...stroke} />
        </>
      ) : null}

      {name === "replay" ? <Path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" {...stroke} /> : null}

      {name === "motion" ? <Path d="M13 3 4 14h6l-1 7 9-11h-6Z" {...stroke} /> : null}
      {name === "timer" ? (
        <>
          <Line x1="10" y1="2" x2="14" y2="2" {...stroke} />
          <Line x1="12" y1="14" x2="15" y2="11" {...stroke} />
          <Circle cx="12" cy="14" r="8" {...stroke} />
        </>
      ) : null}

      {name === "mail" ? (
        <>
          <Rect x="3" y="5" width="18" height="14" rx="2" {...stroke} />
          <Path d="m3 7 9 6 9-6" {...stroke} />
        </>
      ) : null}

      {name === "key" ? (
        <>
          <Circle cx="8" cy="15" r="4" {...stroke} />
          <Path d="m11 12 9-9M17 5l3 3M14 8l2 2" {...stroke} />
        </>
      ) : null}

      {name === "sun" ? (
        <>
          <Circle cx="12" cy="12" r="4" {...stroke} />
          <Path
            d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2M20 12h2m-15.66 5.66-1.41 1.41m14.14-14.14-1.41 1.41"
            {...stroke}
          />
        </>
      ) : null}

      {name === "moon" ? <Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" {...stroke} /> : null}

      {name === "smartphone" ? (
        <>
          <Rect width="14" height="20" x="5" y="2" rx="2" ry="2" {...stroke} />
          <Path d="M12 18h.01" {...stroke} />
        </>
      ) : null}

      {name === "paperclip" ? (
        <>
          <Path d="M13.234 20.252 21 12.3" {...stroke} />
          <Path d="m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486" {...stroke} />
        </>
      ) : null}

      {}
      {name === "more" ? (
        <>
          <Circle cx="12" cy="5" r="1" {...stroke} />
          <Circle cx="12" cy="12" r="1" {...stroke} />
          <Circle cx="12" cy="19" r="1" {...stroke} />
        </>
      ) : null}

      {name === "share" ? <Path d="M12 15V2m-4 4 4-4 4 4M7 10H4v11h16V10h-3" {...stroke} /> : null}

      {name === "pin" ? <Path d="m8 3 8 0-1 6 3 4H6l3-4ZM12 13v9" {...stroke} /> : null}

      {name === "pencil" ? (
        <Path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" {...stroke} />
      ) : null}

      {name === "trash" ? (
        <Path d="M3 6h18M8 6V4h8v2M19 6v14c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V6M10 11v6M14 11v6" {...stroke} />
      ) : null}

      {}
      {name === "rename" ? <Path d="M8.5 18l-4 1 1-4L15.5 5l4 4ZM13 20h7" {...stroke} /> : null}

      {name === "close" ? <Path d="M6 6l12 12M18 6 6 18" {...stroke} /> : null}

      {}
      {name === "logout" ? <Path d="M9 21H4V3h5M16 17l5-5-5-5M21 12H9" {...stroke} /> : null}

      {}
      {name === "file" ? <Path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h6" {...stroke} /> : null}

      {name === "photo" ? (
        <>
          <Rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
          <Circle cx="9" cy="10" r="2" {...stroke} />
          <Path d="m21 16-5-5-9 9" {...stroke} />
        </>
      ) : null}

      {name === "camera" ? (
        <>
          <Path
            d="M3 8a2 2 0 0 1 2-2h2.5L9 4h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
            {...stroke}
          />
          <Circle cx="12" cy="13" r="3.5" {...stroke} />
        </>
      ) : null}

      {name === "video" ? (
        <>
          <Rect x="2" y="6" width="14" height="12" rx="2" {...stroke} />
          <Path d="m16 10 6-3v10l-6-3" {...stroke} />
        </>
      ) : null}

      {}
      {name === "hamburger" ? <Path d="M4 5h16M4 12h16M4 19h16" {...stroke} /> : null}

      {name === "compose" ? (
        <>
          <Path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" {...stroke} />
          <Path
            d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
            {...stroke}
          />
        </>
      ) : null}

      {name === "dots" ? (
        <>
          <Circle cx="12" cy="12" r="1" {...stroke} />
          <Circle cx="19" cy="12" r="1" {...stroke} />
          <Circle cx="5" cy="12" r="1" {...stroke} />
        </>
      ) : null}

      {name === "externalLink" ? (
        <>
          <Path d="M15 3h6v6" {...stroke} />
          <Path d="M10 14 21 3" {...stroke} />
          <Path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" {...stroke} />
        </>
      ) : null}
      {name === "arrowUp" ? <Path d="m5 12 7-7 7 7M12 19V5" {...stroke} /> : null}

      {name === "alertCircle" ? (
        <>
          <Circle cx="12" cy="12" r="10" {...stroke} />
          <Line x1="12" x2="12" y1="8" y2="12" {...stroke} />
          <Line x1="12" x2="12.01" y1="16" y2="16" {...stroke} />
        </>
      ) : null}

      {name === "calendarList" ? (
        <>
          <Rect x="3" y="3" width="18" height="18" rx="2" {...stroke} />
          <Path d="M16 2v3M3 9h18M8 2v3M17 13h-6M13 17H7M7 13h.01M17 17h.01" {...stroke} />
        </>
      ) : null}

      {name === "target" ? (
        <>
          <Circle cx="12" cy="12" r="10" {...stroke} />
          <Circle cx="12" cy="12" r="6" {...stroke} />
          <Circle cx="12" cy="12" r="2" {...stroke} />
        </>
      ) : null}

      {name === "refresh" ? (
        <Path
          d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"
          {...stroke}
        />
      ) : null}

      {name === "chartColumn" ? <Path d="M5 21v-6M12 21V3M19 21V9" {...stroke} /> : null}

      {name === "swords" ? (
        <Path
          d="m13 19 6-6M14.5 17.5 3.586 6.586A2 2 0 013 5.172V3h2.172a2 2 0 011.414.586L17.5 14.5M14.828 6.172l2.586-2.586A2 2 0 0118.828 3H21v2.172a2 2 0 01-.586 1.414l-2.586 2.586M16 16l4 4M19 21l2-2M5 14l4 4M5 21l-2-2M7.5 16.5 4 20"
          {...stroke}
        />
      ) : null}

      {name === "sprout" ? (
        <Path
          d="M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4M5 21h14"
          {...stroke}
        />
      ) : null}

      {name === "image" ? (
        <>
          <Rect width="18" height="18" x="3" y="3" rx="2" ry="2" {...stroke} />
          <Circle cx="9" cy="9" r="2" {...stroke} />
          <Path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" {...stroke} />
        </>
      ) : null}

      {name === "presentation" ? (
        <Path d="M2 3h20M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3M7 21l5-5 5 5" {...stroke} />
      ) : null}

      {}
      {name === "home" ? (
        <>
          <Path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" {...stroke} />
          <Path
            d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
            {...stroke}
          />
        </>
      ) : null}

      {name === "shieldCheck" ? (
        <>
          <Path
            d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            {...stroke}
          />
          <Path d="m9 12 2 2 4-4" {...stroke} />
        </>
      ) : null}

      {name === "inbox" ? (
        <>
          <Polyline points="22 12 16 12 14 15 10 15 8 12 2 12" {...stroke} />
          <Path
            d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
            {...stroke}
          />
        </>
      ) : null}

      {name === "appWindow" ? (
        <>
          <Rect x="2" y="4" width="20" height="16" rx="2" {...stroke} />
          <Path d="M10 4v4M2 8h20M6 4v4" {...stroke} />
        </>
      ) : null}

      {}
      {name === "atSign" ? (
        <>
          <Circle cx="12" cy="12" r="4" {...stroke} />
          <Path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" {...stroke} />
        </>
      ) : null}
      {name === "messages" ? (
        <Path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" {...stroke} />
      ) : null}

      {}
      {name === "bot" ? (
        <>
          <Rect x="4" y="8" width="16" height="12" rx="2" {...stroke} />
          <Path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2" {...stroke} />
        </>
      ) : null}

      {name === "package" ? (
        <>
          <Path
            d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"
            {...stroke}
          />
          <Path d="M12 22V12M7.5 4.27l9 5.15" {...stroke} />
          <Polyline points="3.29 7 12 12 20.71 7" {...stroke} />
        </>
      ) : null}

      {name === "gear" ? (
        <>
          <Path
            d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
            {...stroke}
          />
          <Circle cx="12" cy="12" r="3" {...stroke} />
        </>
      ) : null}

      {name === "panelClose" ? (
        <>
          <Rect width="18" height="18" x="3" y="3" rx="2" {...stroke} />
          <Path d="M9 3v18M16 15l-3-3 3-3" {...stroke} />
        </>
      ) : null}

      {name === "search" ? (
        <>
          <Path d="m21 21-4.34-4.34" {...stroke} />
          <Circle cx="11" cy="11" r="8" {...stroke} />
        </>
      ) : null}

      {name === "chevronDown" ? <Path d="m6 9 6 6 6-6" {...stroke} /> : null}

      {name === "add" ? <Path d="M5 12h14M12 5v14" {...stroke} /> : null}

      {}
      {name === "plus" ? <Path d="M12 4v16M4 12h16" {...stroke} /> : null}

      {name === "tick" ? <Path d="M20 6 9 17l-5-5" {...stroke} /> : null}

      {}
      {name === "upload" ? (
        <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" {...stroke} />
      ) : null}
      {name === "helpCircle" ? (
        <>
          <Circle cx="12" cy="12" r="10" {...stroke} />
          <Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" {...stroke} />
        </>
      ) : null}

      {}
      {name === "scroll" ? (
        <>
          <Path d="M8 21h11a2 2 0 0 0 2-2v-2H10v2a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2h11a2 2 0 0 1 2 2v12" {...stroke} />
          <Path d="M10 8h4M10 12h4" {...stroke} />
        </>
      ) : null}

      {name === "pinSmall" ? (
        <Path
          d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
          {...stroke}
        />
      ) : null}

      {}
      {name === "lock" ? (
        <>
          <Rect width="18" height="11" x="3" y="11" rx="2" ry="2" {...stroke} />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...stroke} />
        </>
      ) : null}

      {name === "messageSquare" ? (
        <Path
          d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
          {...stroke}
        />
      ) : null}

      {name === "database" ? (
        <>
          <Ellipse cx="12" cy="5" rx="9" ry="3" {...stroke} />
          <Path d="M3 5V19A9 3 0 0 0 21 19V5" {...stroke} />
          <Path d="M3 12A9 3 0 0 0 21 12" {...stroke} />
        </>
      ) : null}

      {name === "filter" ? (
        <>
          <Path d="M2 5h20" {...stroke} />
          <Path d="M6 12h12" {...stroke} />
          <Path d="M9 19h6" {...stroke} />
        </>
      ) : null}

      {}
      {name === "hand" ? (
        <>
          <Path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" {...stroke} />
          <Path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" {...stroke} />
          <Path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" {...stroke} />
          <Path
            d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"
            {...stroke}
          />
        </>
      ) : null}

      {name === "sparkles" ? (
        <>
          <Path
            d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
            {...stroke}
          />
          <Path d="M20 3v4" {...stroke} />
          <Path d="M22 5h-4" {...stroke} />
          <Path d="M4 17v2" {...stroke} />
          <Path d="M5 18H3" {...stroke} />
        </>
      ) : null}

      {name === "loader" ? (
        <>
          <Path d="M12 2v4" {...stroke} />
          <Path d="m16.2 7.8 2.9-2.9" {...stroke} />
          <Path d="M18 12h4" {...stroke} />
          <Path d="m16.2 16.2 2.9 2.9" {...stroke} />
          <Path d="M12 18v4" {...stroke} />
          <Path d="m4.9 19.1 2.9-2.9" {...stroke} />
          <Path d="M2 12h4" {...stroke} />
          <Path d="m4.9 4.9 2.9 2.9" {...stroke} />
        </>
      ) : null}

      {name === "shieldAlert" ? (
        <>
          <Path
            d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            {...stroke}
          />
          <Path d="M12 8v4" {...stroke} />
          <Path d="M12 16h.01" {...stroke} />
        </>
      ) : null}

      {name === "eye" ? (
        <>
          <Path
            d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
            {...stroke}
          />
          <Circle cx="12" cy="12" r="3" {...stroke} />
        </>
      ) : null}

      {name === "send" ? (
        <Path
          d="M1.5 2.106C1.5 1.644 1.998 1.352 2.401 1.578L18.101 9.292C18.2228 9.35195 18.3255 9.4447 18.3976 9.55982C18.4696 9.67493 18.5081 9.80786 18.5087 9.94364C18.5093 10.0794 18.472 10.2127 18.4011 10.3285C18.3301 10.4442 18.2283 10.5379 18.107 10.599L2.501 18.46L2.431 18.477C2.32011 18.5038 2.20459 18.505 2.09313 18.4807C1.98168 18.4564 1.8772 18.4071 1.78757 18.3365C1.69794 18.2659 1.62549 18.1759 1.57568 18.0733C1.52586 17.9707 1.49999 17.8581 1.5 17.744V13.172C1.5 11.952 2.471 10.926 3.713 10.904L10.26 10.734C10.53 10.724 11.01 10.491 11.01 9.937C11.01 9.384 10.51 9.142 10.26 9.142L3.713 8.971C2.47 8.95 1.5 7.924 1.5 6.704V2.106Z"
          fill={color}
        />
      ) : null}
    </Svg>
  );
}

export function BackIcon({ color }: { color?: string }) {
  return <Icon name="chevronLeft" size={28} strokeWidth={1.8} color={color} />;
}

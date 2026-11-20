import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { useTheme } from "../../theme/theme";


export type ArtifactGlyphName =
  | "arrow-left"
  | "close"
  | "dashboard"
  | "download"
  | "eye"
  | "file"
  | "filter"
  | "globe"
  | "grid"
  | "image"
  | "list"
  | "more"
  | "more-horizontal"
  | "open"
  | "pencil"
  | "presentation"
  | "search"
  | "spreadsheet"
  | "trash"
  | "video";

export function ArtifactGlyph({
  name,
  size = 20,
  color: colorProp,
  strokeWidth = 1.6,
}: {
  name: ArtifactGlyphName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const { colors } = useTheme();
  const color = colorProp ?? colors.muted;
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {name === "arrow-left" ? <Path d="m10 5-7 7 7 7M3 12h18" {...stroke} /> : null}
      {name === "close" ? (
        <>
          <Path d="M18 6 6 18" {...stroke} />
          <Path d="m6 6 12 12" {...stroke} />
        </>
      ) : null}
      {name === "dashboard" ? (
        <>
          <Rect x="3" y="3" width="7" height="7" rx="1.5" {...stroke} />
          <Rect x="14" y="3" width="7" height="7" rx="1.5" {...stroke} />
          <Rect x="3" y="14" width="7" height="7" rx="1.5" {...stroke} />
          <Rect x="14" y="14" width="7" height="7" rx="1.5" {...stroke} />
        </>
      ) : null}
      {name === "download" ? (
        <>
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" {...stroke} />
          <Path d="M7 10 12 15 17 10" {...stroke} />
          <Line x1="12" x2="12" y1="15" y2="3" {...stroke} />
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
      {name === "file" ? (
        <Path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h4" {...stroke} />
      ) : null}
      {name === "filter" ? (
        <Path d="M22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3 Z" {...stroke} />
      ) : null}
      {name === "globe" ? (
        <>
          <Circle cx="12" cy="12" r="9" {...stroke} />
          <Path d="M3 12h18M12 3c2.3 2.4 3.4 5.4 3.4 9s-1.1 6.6-3.4 9c-2.3-2.4-3.4-5.4-3.4-9S9.7 5.4 12 3Z" {...stroke} />
        </>
      ) : null}
      {name === "grid" ? (
        <>
          <Path d="M12 3v18" {...stroke} />
          <Path d="M3 12h18" {...stroke} />
          <Rect x="3" y="3" width="18" height="18" rx="2" {...stroke} />
        </>
      ) : null}
      {name === "image" ? (
        <>
          <Rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
          <Circle cx="8.5" cy="9" r="1.2" fill={color} />
          <Path d="m4 17 4.5-4 3 2.5 2.5-2 6 5.5" {...stroke} />
        </>
      ) : null}
      {name === "list" ? (
        <>
          <Path d="M3 12h.01" {...stroke} />
          <Path d="M3 18h.01" {...stroke} />
          <Path d="M3 6h.01" {...stroke} />
          <Path d="M8 12h13" {...stroke} />
          <Path d="M8 18h13" {...stroke} />
          <Path d="M8 6h13" {...stroke} />
        </>
      ) : null}
      {name === "more" ? (
        <>
          <Circle cx="12" cy="5" r="1" {...stroke} />
          <Circle cx="12" cy="12" r="1" {...stroke} />
          <Circle cx="12" cy="19" r="1" {...stroke} />
        </>
      ) : null}
      {name === "more-horizontal" ? (
        <>
          <Circle cx="5" cy="12" r="1" {...stroke} />
          <Circle cx="12" cy="12" r="1" {...stroke} />
          <Circle cx="19" cy="12" r="1" {...stroke} />
        </>
      ) : null}
      {name === "open" ? <Path d="M14 5h5v5M19 5l-8 8M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" {...stroke} /> : null}
      {name === "pencil" ? (
        <>
          <Path
            d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
            {...stroke}
          />
          <Path d="m15 5 4 4" {...stroke} />
        </>
      ) : null}
      {name === "presentation" ? (
        <>
          <Rect x="3" y="4" width="18" height="12" rx="2" {...stroke} />
          <Path d="M12 16v5M8 21h8M7 9h10M12 7v5" {...stroke} />
        </>
      ) : null}
      {name === "search" ? <Path d="m20 20-4.5-4.5M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" {...stroke} /> : null}
      {name === "spreadsheet" ? (
        <>
          <Rect x="4" y="3" width="16" height="18" rx="2" {...stroke} />
          <Path d="M4 8h16M4 13h16M4 17h16M10 8v13M15 8v13" {...stroke} />
        </>
      ) : null}
      {name === "trash" ? (
        <>
          <Path d="M3 6h18" {...stroke} />
          <Path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" {...stroke} />
          <Path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" {...stroke} />
          <Line x1="10" x2="10" y1="11" y2="17" {...stroke} />
          <Line x1="14" x2="14" y1="11" y2="17" {...stroke} />
        </>
      ) : null}
      {name === "video" ? (
        <>
          <Rect x="3" y="6" width="13" height="12" rx="2" {...stroke} />
          <Path d="m16 10 5-3v10l-5-3" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}

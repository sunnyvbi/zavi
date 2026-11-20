import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Circle, Defs, LinearGradient, Path, Polyline, Rect, Stop } from "react-native-svg";
import { type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Mark = { src: number; bg: string; fit: "cover" | "contain" };

const META = { src: require("../../../assets/images/channels/meta-icon.svg"), bg: "#ffffff", fit: "contain" } as const;
const GOOGLE_ADS = { src: require("../../../assets/images/channels/google-ads-icon.png"), bg: "#ffffff", fit: "contain" } as const;
const YOUTUBE = { src: require("../../../assets/images/channels/youtube-channel.png"), bg: "#ffffff", fit: "contain" } as const;
const INSTAGRAM = { src: require("../../../assets/images/channels/instagram-channel.png"), bg: "#ffffff", fit: "contain" } as const;
const TIKTOK = { src: require("../../../assets/images/channels/tiktok-channel.png"), bg: "#000000", fit: "cover" } as const;
const LINKEDIN = { src: require("../../../assets/images/channels/linkedin-channel.png"), bg: "#0073b2", fit: "cover" } as const;
const REDDIT = { src: require("../../../assets/images/channels/reddit-channel.png"), bg: "#ff4500", fit: "cover" } as const;
const X = { src: require("../../../assets/images/channels/twitter-channel.png"), bg: "#000000", fit: "cover" } as const;
const PINTEREST = { src: require("../../../assets/images/channels/pinterest-channel.svg"), bg: "#ffffff", fit: "cover" } as const;
const OPENAI = { src: require("../../../assets/images/channels/openai-channel.svg"), bg: "#000000", fit: "contain" } as const;

const MARKS: Partial<Record<string, Mark>> = {
  meta_ads: META,
  google_ads: GOOGLE_ADS,
  youtube_ads: YOUTUBE,
  tiktok_ads: TIKTOK,
  linkedin_ads: LINKEDIN,
  reddit_ads: REDDIT,
  chatgpt_ads: OPENAI,
  linkedin_organic: LINKEDIN,
  reddit_organic: REDDIT,
  x_organic: X,
  instagram_organic: INSTAGRAM,
  tiktok_organic: TIKTOK,
  pinterest_organic: PINTEREST,
  youtube_organic: YOUTUBE,
};

type GlyphName = "seo" | "geo" | "blog" | "ugc" | "generated_video" | "email_marketing" | "sms";

const GLYPH_BG: Record<GlyphName, string> = {
  seo: "#059669",
  geo: "#7c3aed",
  blog: "#0f766e",
  ugc: "#db2777",
  generated_video: "#db2777",
  email_marketing: "#2563eb",
  sms: "#16a34a",
};

type Gradient = { from: { x: number; y: number }; to: { x: number; y: number }; stops: [number, string][] };

const GLYPH_GRADIENT: Partial<Record<GlyphName, Gradient>> = {
  generated_video: {
    from: { x: 0, y: 0 },
    to: { x: 1, y: 1 },
    stops: [
      [0, "#db2777"],
      [1, "#7c3aed"],
    ],
  },
};

function isGlyph(slug: string): slug is GlyphName {
  return slug in GLYPH_BG;
}

export function ChannelLogo({ slug, size = 36 }: { slug: string; size?: number }) {
  const styles = useStyles(makeStyles);
  const mark = MARKS[slug];
  const circle = { width: size, height: size, borderRadius: size / 2 };

  if (mark) {
    return (
      <View
        style={[styles.logo, circle, { backgroundColor: mark.bg }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Image
          source={mark.src}
          style={mark.fit === "cover" ? StyleSheet.absoluteFill : { width: size * 0.61, height: size * 0.61 }}
          contentFit={mark.fit}
        />
      </View>
    );
  }

  if (isGlyph(slug)) {
    return (
      <View
        style={[styles.logo, circle, { backgroundColor: GLYPH_BG[slug] }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {GLYPH_GRADIENT[slug] ? <GlyphGradient id={slug} gradient={GLYPH_GRADIENT[slug]} size={size} /> : null}
        <ChannelGlyphIcon name={slug} size={size * 0.5} />
      </View>
    );
  }

  return <View style={[styles.logo, styles.plain, circle]} />;
}

function GlyphGradient({ id, gradient, size }: { id: string; gradient: Gradient; size: number }) {
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient
          id={id}
          x1={gradient.from.x}
          y1={gradient.from.y}
          x2={gradient.to.x}
          y2={gradient.to.y}
        >
          {gradient.stops.map(([offset, color]) => (
            <Stop key={offset} offset={offset} stopColor={color} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect width={size} height={size} fill={`url(#${id})`} />
    </Svg>
  );
}

function ChannelGlyphIcon({ name, size }: { name: GlyphName; size: number }) {
  const stroke = {
    stroke: "#ffffff",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "seo" ? (
        <>
          <Circle cx="11" cy="11" r="8" {...stroke} />
          <Path d="m21 21-4.3-4.3" {...stroke} />
        </>
      ) : null}
      {name === "geo" ? (
        <>
          <Path
            d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
            {...stroke}
          />
          <Path d="M20 3v4M22 5h-4M4 17v2M5 18H3" {...stroke} />
        </>
      ) : null}
      {name === "blog" ? (
        <>
          <Path d="M15 18h-5" {...stroke} />
          <Path d="M18 14h-8" {...stroke} />
          <Path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" {...stroke} />
          <Rect x="10" y="6" width="8" height="4" rx="1" {...stroke} />
        </>
      ) : null}
      {name === "ugc" || name === "generated_video" ? (
        <>
          <Path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" {...stroke} />
          <Rect x="2" y="6" width="14" height="12" rx="2" {...stroke} />
        </>
      ) : null}
      {name === "generated_video" ? (
        <Path d="M9 8.8l.75 2.45 2.45.75-2.45.75L9 15.2l-.75-2.45L5.8 12l2.45-.75z" {...stroke} />
      ) : null}
      {name === "email_marketing" ? (
        <>
          <Path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" {...stroke} />
          <Rect x="2" y="4" width="20" height="16" rx="2" {...stroke} />
        </>
      ) : null}
      {name === "sms" ? (
        <>
          <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" {...stroke} />
          <Path d="M13 8H7M17 12H7" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}

export type ChannelIconName =
  | "cog"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "check"
  | "copy"
  | "edit"
  | "plus"
  | "close"
  | "inbox"
  | "lock";

export function ChannelIcon({
  name,
  size = 16,
  color: colorProp,
}: {
  name: ChannelIconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  const color = colorProp ?? colors.ink;
  const stroke = {
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {name === "cog" ? (
        <>
          <Path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            {...stroke}
          />
          <Circle cx="12" cy="12" r="3" {...stroke} />
        </>
      ) : null}
      {name === "chevronDown" ? <Path d="m6 9 6 6 6-6" {...stroke} /> : null}
      {name === "chevronLeft" ? <Path d="m15 18-6-6 6-6" {...stroke} /> : null}
      {name === "chevronRight" ? <Path d="m9 18 6-6-6-6" {...stroke} /> : null}
      {name === "check" ? <Path d="M20 6 9 17l-5-5" {...stroke} /> : null}
      {name === "copy" ? (
        <>
          <Rect x="8" y="8" width="14" height="14" rx="2" ry="2" {...stroke} />
          <Path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" {...stroke} />
        </>
      ) : null}
      {name === "edit" ? (
        <>
          <Path
            d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
            {...stroke}
          />
          <Path d="m15 5 4 4" {...stroke} />
        </>
      ) : null}
      {name === "plus" ? <Path d="M5 12h14M12 5v14" {...stroke} /> : null}
      {name === "close" ? <Path d="M18 6 6 18M6 6l12 12" {...stroke} /> : null}
      {name === "inbox" ? (
        <>
          <Polyline points="22 12 16 12 14 15 10 15 8 12 2 12" {...stroke} />
          <Path
            d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
            {...stroke}
          />
        </>
      ) : null}
      {name === "lock" ? (
        <>
          <Rect x="3" y="11" width="18" height="11" rx="2" ry="2" {...stroke} />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...stroke} />
        </>
      ) : null}
    </Svg>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  logo: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  plain: {
    backgroundColor: colors.wire.card,
  },
});

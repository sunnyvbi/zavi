import { memo, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import Svg, { Path } from "react-native-svg";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import type { Artifact, ArtifactType } from "../../features/artifacts/types";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../../features/artifacts/videoThumbnail";
import { cachedArtifactThumbnail, loadArtifactThumbnail } from "../../features/artifacts/api";
import { SkeletonBlock } from "../Skeleton";
import type { VideoThumbnail } from "expo-video";
import { ArtifactGlyph, type ArtifactGlyphName } from "./ArtifactGlyph";
import { PdfThumb, isPdfArtifact, pdfThumbAvailable } from "./PdfThumb";
import { HtmlThumb } from "./HtmlThumb";
import { CsvThumb } from "./CsvArtifact";
import { isCsv } from "../../features/artifacts/csv";
import { isHtmlArtifact } from "./HtmlArtifactViewer";

const PLAY_GLYPH = "#ffffff";

const typeLabels: Record<ArtifactType, string> = {
  dashboard: "Dashboard",
  document: "Document",
  file: "File",
  image: "Image",
  presentation: "Presentation",
  spreadsheet: "Spreadsheet",
  video: "Video",
  website: "Website",
};

const typeGlyphs: Record<ArtifactType, ArtifactGlyphName> = {
  dashboard: "dashboard",
  document: "file",
  file: "file",
  image: "image",
  presentation: "presentation",
  spreadsheet: "spreadsheet",
  video: "video",
  website: "globe",
};

function typeBackgrounds(colors: Colors): Record<ArtifactType, string> {
  return {
    dashboard: colors.avatarBlue,
    document: colors.avatarOrange,
    file: colors.soft,
    image: colors.avatarBlue,
    presentation: colors.avatarOrange,
    spreadsheet: colors.avatarGreen,
    video: colors.avatarBlue,
    website: colors.avatarGreen,
  };
}

export function artifactTypeGlyph(type: ArtifactType): ArtifactGlyphName {
  return typeGlyphs[type];
}

export function artifactTypeLabel(type: ArtifactType): string {
  return typeLabels[type];
}

export function artifactFormat(artifact: Artifact): string {
  const extension = artifact.filename.split(".").pop()?.trim();
  return extension && extension.length <= 8 ? extension.toUpperCase() : artifactTypeLabel(artifact.type);
}

function isImagePreview(artifact: Artifact): boolean {
  return artifact.type === "image" || artifact.mime.toLowerCase().startsWith("image/");
}

export const ArtifactPreviewTile = memo(function ArtifactPreviewTile({
  artifact,
  compact = false,
  tall = false,
}: {
  artifact: Artifact;
  compact?: boolean;
  tall?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const previewUrl = isImagePreview(artifact) && artifact.preview_url ? artifact.preview_url : null;
  const showImage = !!previewUrl && failedPreviewUrl !== previewUrl;
  const wantsThumb = showImage && !tall;
  const [thumbUrl, setThumbUrl] = useState<string | null | undefined>(() =>
    wantsThumb ? cachedArtifactThumbnail(artifact.id) : null,
  );
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wantsThumb) return;
    let alive = true;
    void loadArtifactThumbnail(artifact.id).then((url) => {
      if (alive) setThumbUrl(url);
    });
    return () => {
      alive = false;
    };
  }, [artifact.id, wantsThumb]);
  const imageUrl = !wantsThumb ? previewUrl : thumbUrl === undefined ? null : (thumbUrl ?? previewUrl);
  const [poster, setPoster] = useState<VideoThumbnail | null>(() => cachedVideoThumbnail(artifact.id) ?? null);
  useEffect(() => {
    if (artifact.type !== "video") return;
    let alive = true;
    void loadVideoThumbnail(artifact.id).then((thumb) => {
      if (alive) setPoster(thumb);
    });
    return () => {
      alive = false;
    };
  }, [artifact.id, artifact.type]);

  if (artifact.type === "video" && poster) {
    return (
      <View
        style={[styles.tile, compact && styles.tileCompact, tall && styles.tileTall]}
        accessible
        accessibilityLabel={`${artifact.title} video preview`}
      >
        <Image source={poster} style={styles.image} contentFit="cover" transition={140} />
        {}
        <View style={[styles.play, compact && styles.playCompact]} pointerEvents="none">
          <Svg width={compact ? 12 : 20} height={compact ? 12 : 20} viewBox="0 0 24 24">
            <Path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill={PLAY_GLYPH} />
          </Svg>
        </View>
      </View>
    );
  }

  if (showImage) {
    return (
      <View
        style={[styles.tile, compact && styles.tileCompact, tall && styles.tileTall]}
        accessible
        accessibilityLabel={`${artifact.title} image preview`}
      >
        {!imageUrl || loadedUrl !== imageUrl ? <SkeletonBlock height={0} radius={0} style={styles.shimmer} /> : null}
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl, cacheKey: `${artifact.id}:${imageUrl === previewUrl ? "full" : "thumb"}` }}
            style={styles.image}
            contentFit="cover"
            transition={140}
            cachePolicy="memory-disk"
            recyclingKey={artifact.id}
            onLoad={() => setLoadedUrl(imageUrl)}
            onError={() => (imageUrl === thumbUrl ? setThumbUrl(null) : setFailedPreviewUrl(previewUrl))}
          />
        ) : null}
      </View>
    );
  }

  const typeTile = (
    <View style={styles.fallbackContent}>
      <View style={[styles.iconBadge, compact && styles.iconBadgeCompact]}>
        <ArtifactGlyph name={typeGlyphs[artifact.type]} size={compact ? 18 : 25} color={colors.ink} />
      </View>
      {compact ? null : <Text style={styles.format}>{artifactFormat(artifact)}</Text>}
    </View>
  );

  return (
    <View
      style={[styles.tile, compact && styles.tileCompact, tall && styles.tileTall, { backgroundColor: typeBackgrounds(colors)[artifact.type] }]}
      accessible
      accessibilityLabel={`${artifactTypeLabel(artifact.type)} preview`}
    >
      {}
      {pdfThumbAvailable() && isPdfArtifact(artifact) ? (
        <PdfThumb artifact={artifact} fallback={typeTile} />
      ) : isCsv(artifact) ? (
        <CsvThumb artifact={artifact} fallback={typeTile} />
      ) : isHtmlArtifact(artifact) ? (
        <HtmlThumb artifact={artifact} fallback={typeTile} />
      ) : (
        typeTile
      )}
    </View>
  );
});

const makeStyles = (colors: Colors) => StyleSheet.create({
  tile: {
    height: 135,
    overflow: "hidden",
    backgroundColor: colors.soft,
  },
  tileCompact: {
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: "hidden",
  },
  tileTall: { height: undefined, aspectRatio: 1.25 },
  image: { width: "100%", height: "100%" },
  shimmer: { ...StyleSheet.absoluteFillObject, height: "100%" },
  play: { position: "absolute", top: "50%", left: "50%", width: 44, height: 44, marginTop: -22, marginLeft: -22, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(23,21,17,0.7)" },
  playCompact: { width: 24, height: 24, marginTop: -12, marginLeft: -12, borderRadius: 12 },
  fallbackContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.panel,
  },
  iconBadgeCompact: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
  },
  format: {
    fontFamily: font.family.semi,
    includeFontPadding: false,
    fontSize: font.size.xs,
    letterSpacing: 0.8,
    color: colors.ink,
  },
});

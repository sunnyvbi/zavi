import { useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { UI_BLOCK_MIME } from "@zavi/shared";
import { signArtifactUrl, type RunArtifact } from "../features/agents/runArtifacts";
import { MediaViewer, inAppVideoAvailable, type MediaItem } from "./MediaViewer";
import { VideoPoster } from "./VideoPoster";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { UiBlockCard } from "./reply/UiBlockCard";

const isImage = (a: RunArtifact) => a.mime.startsWith("image/");
const isVideo = (a: RunArtifact) => a.mime.startsWith("video/");
const isUiBlock = (a: RunArtifact) => a.mime === UI_BLOCK_MIME;

export function RunArtifacts({ artifacts }: { artifacts: RunArtifact[] }) {
  const styles = useStyles(makeStyles);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  if (artifacts.length === 0) return null;

  const images = artifacts.filter(isImage);
  const videos = artifacts.filter(isVideo);
  const files = artifacts.filter((a) => !isImage(a) && !isVideo(a));
  const uiBlocks = files.filter(isUiBlock);
  const fileChips = files.filter((a) => !isUiBlock(a));

  return (
    <View style={styles.wrap}>
      {images.length === 1 ? (
        <View style={styles.imageBubble}>
          <ArtifactImage artifact={images[0]} onOpen={setPreview} style={styles.image} />
        </View>
      ) : images.length > 1 ? (
        <ImageGrid images={images} onOpen={setPreview} />
      ) : null}
      {videos.map((a) => (
        <VideoTile key={a.id} artifact={a} onOpen={setPreview} />
      ))}
      {uiBlocks.map((a) => (
        <UiBlockCard key={a.id} artifact={a} fallback={<FileChip artifact={a} />} />
      ))}
      {fileChips.length > 0 ? (
        <View style={styles.chips}>
          {fileChips.map((a) => (
            <FileChip key={a.id} artifact={a} />
          ))}
        </View>
      ) : null}
      <MediaViewer item={preview} onClose={() => setPreview(null)} />
    </View>
  );
}

async function openInBrowser(a: RunArtifact, signed?: string | null) {
  const url = signed ?? (await signArtifactUrl(a.id));
  if (!url) {
    Alert.alert("Couldn't open file", "Try again in a moment.");
    return;
  }
  await Linking.openURL(url).catch(() => Alert.alert("Couldn't open file", "Try again in a moment."));
}

function ImageGrid({
  images,
  onOpen,
}: {
  images: RunArtifact[];
  onOpen: (item: MediaItem) => void;
}) {
  const styles = useStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const side = (width - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
  return (
    <View style={styles.grid} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0
        ? images.map((a, i) => (
            <ArtifactImage
              key={a.id}
              artifact={a}
              onOpen={onOpen}
              style={[styles.gridTile, { width: side, height: side }, gridCorners(i, images.length)]}
            />
          ))
        : null}
    </View>
  );
}

const GRID_COLS = 3;
const GRID_GAP = 2;
const GRID_RADIUS = 16;

function gridCorners(index: number, total: number) {
  const totalRows = Math.ceil(total / GRID_COLS);
  const row = Math.floor(index / GRID_COLS);
  const col = index % GRID_COLS;
  const lastRowCount = total % GRID_COLS || GRID_COLS;
  return {
    borderTopLeftRadius: row === 0 && col === 0 ? GRID_RADIUS : 0,
    borderTopRightRadius: row === 0 && (col === GRID_COLS - 1 || index === total - 1) ? GRID_RADIUS : 0,
    borderBottomLeftRadius: row === totalRows - 1 && col === 0 ? GRID_RADIUS : 0,
    borderBottomRightRadius:
      index === total - 1 || (lastRowCount < GRID_COLS && row === totalRows - 2 && col === GRID_COLS - 1)
        ? GRID_RADIUS
        : 0,
  };
}

function ArtifactImage({
  artifact,
  onOpen,
  style,
}: {
  artifact: RunArtifact;
  onOpen: (item: MediaItem) => void;
  style: ComponentProps<typeof Pressable>["style"];
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void signArtifactUrl(artifact.id).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [artifact.id]);

  if (failed) return <FileChip artifact={artifact} />;

  return (
    <Pressable
      onPress={() => {
        if (url) onOpen({ kind: "image", url, filename: artifact.filename });
      }}
      disabled={!url}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Image ${artifact.filename}. Open preview`}
      style={style}
    >
      {url ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          recyclingKey={artifact.id}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </Pressable>
  );
}

function VideoTile({
  artifact,
  onOpen,
}: {
  artifact: RunArtifact;
  onOpen: (item: MediaItem) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function play() {
    if (busy) return;
    setBusy(true);
    const url = await signArtifactUrl(artifact.id);
    setBusy(false);
    if (!url) {
      Alert.alert("Couldn't load video", "Try again in a moment.");
      return;
    }
    if (inAppVideoAvailable()) onOpen({ kind: "video", url, filename: artifact.filename });
    else void openInBrowser(artifact, url);
  }

  return <VideoPoster name={artifact.filename} busy={busy} onPress={() => void play()} />;
}

function FileChip({ artifact }: { artifact: RunArtifact }) {
  const styles = useStyles(makeStyles);
  const ext = artifact.filename.includes(".")
    ? artifact.filename.split(".").pop()!.toUpperCase().slice(0, 4)
    : "FILE";
  return (
    <Pressable
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      onPress={() => void openInBrowser(artifact)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${artifact.filename}`}
    >
      <View style={styles.ext}>
        <Text style={styles.extText}>{ext}</Text>
      </View>
      <Text style={styles.chipText} numberOfLines={1}>
        {artifact.filename}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  imageBubble: {
    alignSelf: "flex-start",
    padding: space.sm,
    backgroundColor: colors.soft,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP },
  gridTile: { backgroundColor: colors.line, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  image: {
    width: 156,
    height: 130,
    borderRadius: 14,
    backgroundColor: colors.line,
    overflow: "hidden",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
  },
  chipPressed: { backgroundColor: colors.soft },
  ext: {
    minWidth: 34,
    paddingHorizontal: 4,
    height: 24,
    borderRadius: 6,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  extText: { fontSize: 10, fontFamily: font.family.semi, color: colors.muted },
  chipText: { flexShrink: 1, fontSize: font.size.md, color: colors.ink },
});

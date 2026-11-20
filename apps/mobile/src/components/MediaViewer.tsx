import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { requireOptionalNativeModule, useEvent } from "expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { font, space } from "../theme/tokens";

type ExpoVideo = typeof import("expo-video");
let expoVideo: ExpoVideo | null | undefined;
export function inAppVideoAvailable(): boolean {
  if (expoVideo === undefined) {
    if (!requireOptionalNativeModule("ExpoVideo")) {
      expoVideo = null;
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expoVideo = require("expo-video") as ExpoVideo;
    } catch {
      expoVideo = null;
    }
  }
  return expoVideo !== null;
}

type VideoFrame = import("expo-video").VideoThumbnail;

export function useVideoFrame(key: string | null, url: string | null): VideoFrame | null {
  const [frame, setFrame] = useState<{ key: string; image: VideoFrame } | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;
  useEffect(() => {
    const src = urlRef.current;
    if (!key || !src || !inAppVideoAvailable() || !expoVideo) return;
    let live = true;
    const player = expoVideo.createVideoPlayer(src);
    let done = false;
    let asked = false;
    const finish = () => {
      if (done) return;
      done = true;
      sub.remove();
      player.release();
    };
    const grab = () => {
      if (done || asked) return;
      asked = true;
      player
        .generateThumbnailsAsync(0, { maxWidth: 480 })
        .then(([image]) => {
          if (live && image) setFrame({ key, image });
        })
        .catch(() => {})
        .finally(finish);
    };
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay") grab();
      else if (status === "error") finish();
    });
    if (player.status === "readyToPlay") grab();
    return () => {
      live = false;
      finish();
    };
  }, [key]);
  return frame && frame.key === key ? frame.image : null;
}

export type MediaItem = { kind: "image" | "video"; url: string; filename: string };

export function MediaViewer({ item, onClose }: { item: MediaItem | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={!!item}
      animationType="fade"
      presentationStyle="overFullScreen"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar barStyle="light-content" />
      <View style={styles.stage}>
        {item?.kind === "image" ? <ZoomableImage url={item.url} name={item.filename} /> : null}
        {item?.kind === "video" && inAppVideoAvailable() ? <Player url={item.url} top={insets.top + space.sm + 36 + space.sm} bottom={insets.bottom} /> : null}

        <View style={[styles.bar, { top: insets.top + space.sm }]} pointerEvents="box-none">
          <Text style={styles.name} numberOfLines={1}>
            {item?.filename ?? ""}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close preview"
          >
            <Icon name="close" size={20} color="#fff" strokeWidth={2} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function ZoomableImage({ url, name }: { url: string; name: string }) {
  const { width, height } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  return (
    <ScrollView
      style={StyleSheet.absoluteFill}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      <Image
        source={{ uri: url }}
        style={{ width, height }}
        contentFit="contain"
        onLoadEnd={() => setLoading(false)}
        accessibilityLabel={name}
      />
      {loading ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
    </ScrollView>
  );
}

function Player({ url, top, bottom }: { url: string; top: number; bottom: number }) {
  const { useVideoPlayer, VideoView } = expoVideo as ExpoVideo;
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  const { status, error } = useEvent(player, "statusChange", { status: player.status });

  return (
    <>
      <VideoView
        player={player}
        style={{ position: "absolute", top, left: 0, right: 0, bottom }}
        contentFit="contain"
        nativeControls
        fullscreenOptions={{ enable: true }}
      />
      {status === "loading" ? (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
      {status === "error" ? (
        <View style={[StyleSheet.absoluteFill, styles.center, styles.errorBox]} pointerEvents="none">
          <Text style={styles.errorTitle}>Couldn't play this video</Text>
          <Text style={styles.errorText}>{error?.message || "The file may have moved or expired. Try again."}</Text>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center" },
  errorBox: { paddingHorizontal: space.xl, gap: space.sm, backgroundColor: "#000" },
  errorTitle: { color: "#fff", fontSize: font.size.lg, fontFamily: font.family.semi, includeFontPadding: false, textAlign: "center" },
  errorText: { color: "rgba(255,255,255,0.7)", fontSize: font.size.base, includeFontPadding: false, textAlign: "center" },
  bar: {
    position: "absolute",
    left: space.lg,
    right: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  name: { flex: 1, color: "#fff", fontSize: font.size.base, fontFamily: font.family.medium, includeFontPadding: false },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  closePressed: { opacity: 0.7 },
});

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { apiFetch } from "../lib/api";
import { font, radius, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function ChatImageThumb({
  path,
  onPress,
}: {
  path: string;
  onPress?: (url: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/chat/image-url?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
          if (!canceled) setError(true);
          return;
        }
        const data = (await res.json()) as { signed_url?: string };
        if (canceled) return;
        if (data.signed_url) setUrl(data.signed_url);
        else setError(true);
      } catch {
        if (!canceled) setError(true);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [path]);

  if (error) {
    return (
      <View style={[styles.thumb, styles.fallback]}>
        <Text style={styles.fallbackText}>could not load image</Text>
      </View>
    );
  }
  if (!url) {
    return <View style={[styles.thumb, styles.fallback]} />;
  }
  const image = (
    <Image
      source={{ uri: url }}
      style={styles.thumb}
      contentFit="cover"
      accessibilityLabel="chat attachment"
    />
  );
  if (!onPress) return image;
  return (
    <Pressable onPress={() => onPress(url)} accessibilityRole="imagebutton" accessibilityLabel="Open image preview">
      {image}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  thumb: {
    width: 96,
    height: 96,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.soft,
  },
  fallback: { alignItems: "center", justifyContent: "center", padding: 6 },
  fallbackText: { fontSize: font.size.xs, color: colors.muted, textAlign: "center" },
});

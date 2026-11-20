import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { workspaceLogoUrl } from "../features/workspaces/logo";

export function WorkspaceLogo({
  website,
  size,
  fallback,
}: {
  website: string | null | undefined;
  size: number;
  fallback: ReactNode;
}) {
  const url = workspaceLogoUrl(website);
  const [loaded, setLoaded] = useState<string | null>(null);
  const ready = !!url && loaded === url;
  if (!url) return <>{fallback}</>;
  const box = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {ready ? null : fallback}
      <Image
        key={url}
        source={{ uri: url }}
        style={[StyleSheet.absoluteFill, box, !ready && styles.hidden]}
        contentFit="cover"
        cachePolicy="disk"
        onLoad={() => setLoaded(url)}
        onError={() => setLoaded(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({ hidden: { opacity: 0 } });

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { font, radius, space } from "../theme/tokens";
import { useTheme } from "../theme/theme";

export function VideoPoster({
  name,
  onPress,
  busy,
  compact,
}: {
  name: string;
  onPress?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const { colors } = useTheme();
  const button = compact ? 40 : 52;
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, pressed && !!onPress && styles.pressed]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`Play video ${name}`}
    >
      <View style={[styles.play, { width: button, height: button, borderRadius: button / 2 }]}>
        {busy ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <Svg width={button * 0.42} height={button * 0.42} viewBox="0 0 24 24">
            <Path
              d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z"
              fill={colors.ink}
            />
          </Svg>
        )}
      </View>
      <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: radius.lg,
    backgroundColor: "#111",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  pressed: { opacity: 0.85 },
  play: { backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center" },
  name: {
    position: "absolute",
    left: space.md,
    right: space.md,
    bottom: space.sm,
    fontSize: font.size.sm,
    includeFontPadding: false,
    color: "rgba(255,255,255,0.85)",
  },
  nameCompact: { fontSize: font.size.xs, includeFontPadding: false, left: space.sm, right: space.sm, bottom: 6 },
});

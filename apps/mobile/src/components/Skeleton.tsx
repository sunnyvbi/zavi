import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useReduceMotion } from "../lib/motion";
import { type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

const SWEEP_MS = 1200;

export function SkeletonBlock({
  width = "100%",
  height,
  radius = 6,
  style,
}: {
  width?: DimensionValue;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const [blockWidth, setBlockWidth] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: SWEEP_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep, reduceMotion]);

  const translateX = sweep.interpolate({ inputRange: [0, 1], outputRange: [-blockWidth, blockWidth] });

  return (
    <View
      style={[styles.block, { width, height, borderRadius: radius }, style]}
      onLayout={(e) => setBlockWidth(e.nativeEvent.layout.width)}
    >
      {blockWidth > 0 && !reduceMotion ? (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]}>
          <Svg width={blockWidth} height={height}>
            <Defs>
              <LinearGradient id="skeletonSweep" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={colors.shimmer} stopOpacity={0} />
                <Stop offset="0.5" stopColor={colors.shimmer} stopOpacity={0.65} />
                <Stop offset="1" stopColor={colors.shimmer} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#skeletonSweep)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  block: { overflow: "hidden", backgroundColor: colors.soft },
});

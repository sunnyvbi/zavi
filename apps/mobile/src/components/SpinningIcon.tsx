import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { Icon, type IconName } from "./Icon";
import { useReduceMotion } from "../lib/motion";

export function SpinningIcon({ name, size, color, spinning }: { name: IconName; size: number; color: string; spinning: boolean }) {
  const reduceMotion = useReduceMotion();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning || reduceMotion) {
      turn.stopAnimation();
      turn.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spinning, reduceMotion, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name={name} size={size} color={color} />
    </Animated.View>
  );
}

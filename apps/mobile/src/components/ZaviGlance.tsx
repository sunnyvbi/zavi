import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useReduceMotion } from "../lib/motion";

const IDLE = require("../../assets/images/mascot/zavi-idle.webp");
const WORKING = require("../../assets/images/mascot/zavi-working.webp");
const STILL = require("../../assets/images/mascot/zavi-still.webp");

export function ZaviGlance({ size = 28, working = false }: { size?: number; working?: boolean }) {
  const reduceMotion = useReduceMotion();
  const source = reduceMotion ? STILL : working ? WORKING : IDLE;
  return (
    <View
      style={{ width: size, height: size }}
      importantForAccessibility="no"
      accessibilityElementsHidden
    >
      <Image source={source} style={styles.fill} contentFit="contain" autoplay={!reduceMotion} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { width: "100%", height: "100%" },
});

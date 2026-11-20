import { Image } from "expo-image";

const ICON = require("../../assets/images/zavi-app-icon.png");

export function ZaviAppIcon({ size, radius }: { size: number; radius: number }) {
  return (
    <Image
      source={ICON}
      style={{ width: size, height: size, borderRadius: radius }}
      contentFit="cover"
      accessibilityLabel="Zavi"
    />
  );
}

import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ZaviGlance } from "./ZaviGlance";
import { font } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

export function LoadingScreen({ label }: { label?: string }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.root}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id="loadingWash" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={colors.loadingWash.from} />
            <Stop offset="100%" stopColor={colors.loadingWash.to} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#loadingWash)" />
      </Svg>
      <ZaviGlance size={120} />
      <ActivityIndicator size={26} color={colors.ink} style={styles.spinner} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    root: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    spinner: {
      marginTop: 12,
    },
    label: {
      fontFamily: font.family.regular,
      fontSize: 13,
      color: colors.muted,
      marginTop: 12,
    },
  });

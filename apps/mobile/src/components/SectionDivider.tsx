import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function SectionDivider({ style }: { style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.bar, style]} />;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  bar: { height: 5, backgroundColor: colors.sectionDivider },
});

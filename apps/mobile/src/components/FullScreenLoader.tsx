import { Modal, StyleSheet, Text, View } from "react-native";
import { ZaviGlance } from "./ZaviGlance";
import { font, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function FullScreenLoader({ visible, label }: { visible: boolean; label?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => {}}>
      <View style={styles.fill} accessibilityViewIsModal accessibilityLiveRegion="polite">
        <ZaviGlance size={120} working />
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  label: {
    marginTop: 16,
    fontFamily: font.family.medium,
    fontSize: font.size.base,
    includeFontPadding: false,
    color: colors.ink,
  },
});

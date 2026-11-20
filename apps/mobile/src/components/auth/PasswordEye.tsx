import { Image, StyleSheet } from "react-native";
import { useTheme } from "../../theme/theme";
const CLOSED = require("../../../assets/images/auth/eye-closed.png");
const OPEN = require("../../../assets/images/auth/eye-open.png");

export function PasswordEye({ visible, empty }: { visible: boolean; empty: boolean }) {
  const { colors } = useTheme();
  return <Image source={visible ? OPEN : CLOSED} style={[styles.icon, { tintColor: empty ? colors.form.eyeEmpty : colors.form.eye }]} />;
}

const styles = StyleSheet.create({ icon: { width: 16, height: 16 } });

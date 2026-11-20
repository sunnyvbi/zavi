import { Pressable, StyleSheet, Text, View } from "react-native";
import { font, type Colors } from "../theme/tokens";
import { useStyles } from "../theme/theme";

export function CrashScreen({ onRetry }: { onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.body}>Zavi hit a problem on this screen. We have been told about it.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonLabel}>Try again</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 16,
      backgroundColor: colors.bg,
    },
    title: {
      fontFamily: font.family.semi,
      fontSize: 20,
      lineHeight: 26,
      color: colors.ink,
      textAlign: "center",
    },
    body: {
      fontFamily: font.family.regular,
      fontSize: 14,
      lineHeight: 20,
      color: colors.textSecondary,
      textAlign: "center",
      marginTop: 8,
    },
    button: {
      height: 40,
      borderRadius: 12,
      paddingHorizontal: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.ink,
      marginTop: 20,
    },
    buttonPressed: {
      opacity: 0.8,
    },
    buttonLabel: {
      fontFamily: font.family.semi,
      fontSize: 14,
      lineHeight: 18,
      color: colors.onInk,
    },
  });

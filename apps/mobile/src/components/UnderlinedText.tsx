import type { ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { useTheme } from "../theme/theme";

export function UnderlinedText({
  style,
  children,
}: {
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const { lineHeight: _dropped, opacity, ...text } = StyleSheet.flatten(style) ?? {};
  return (
    <View style={[styles.line, { borderBottomColor: text.color ?? colors.ink, opacity }]}>
      <Text style={text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { borderBottomWidth: 1 },
});

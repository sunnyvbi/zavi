import { StyleSheet, Text, View } from "react-native";
import { font, radius, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { agentAvatarColor, agentInitials } from "../features/agents/registry";

export function Avatar({
  slug,
  name,
  size = 34,
  round = false,
  bg,
}: {
  slug: string;
  name: string;
  size?: number;
  round?: boolean;
  bg?: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.box,
        {
          width: size,
          height: size,
          borderRadius: round ? size / 2 : radius.md,
          backgroundColor: bg ?? agentAvatarColor(colors, slug),
        },
      ]}
    >
      {}
      <Text style={[styles.initials, { fontSize: Math.max(font.size.xs, Math.round(size * 0.32)) }]}>
        {agentInitials(name)}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center" },
  initials: { fontWeight: font.weight.regular, color: colors.ink },
});

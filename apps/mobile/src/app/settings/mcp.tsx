import { ScrollView, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../../components/Screen";
import { McpConnectCard } from "../../components/connections/McpConnectCard";
import { BackHeader, settingsStyles } from "../../components/settings/SettingsUI";
import { font, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export default function McpScreen() {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <BackHeader title="MCP" />
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <Text style={styles.intro}>Run your agents from Claude Code, claude.ai or ChatGPT.</Text>
        <McpConnectCard />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  intro: {
    marginBottom: 20,
    fontFamily: font.family.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
});

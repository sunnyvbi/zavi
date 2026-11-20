import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Screen } from "../../components/Screen";
import { BackHeader } from "../../components/settings/SettingsUI";
import { ConnectionsList } from "../../components/connections/ConnectionsList";
import { SkillsList } from "../../components/skill/SkillsList";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const TABS = [
  { id: "integrations", label: "Integrations" },
  { id: "skills", label: "Skills" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Connectors() {
  const styles = useStyles(makeStyles);
  const { tab: initial } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<TabId>(initial === "skills" ? "skills" : "integrations");

  return (
    <Screen>
      <BackHeader title="Connectors" />
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => {
          const selected = tab === t.id;
          return (
            <Pressable
              key={t.id}
              style={[styles.tab, selected && styles.tabSelected]}
              onPress={() => setTab(t.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.tabText, selected && styles.tabTextSelected]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.body}>{tab === "integrations" ? <ConnectionsList /> : <SkillsList />}</View>
    </Screen>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  tabs: {
    flexDirection: "row",
    gap: space.lg,
    marginHorizontal: space.lg,
    marginTop: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tab: { justifyContent: "center", minHeight: 44, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabSelected: { borderBottomColor: colors.ink },
  tabText: { fontFamily: font.family.semi, fontSize: 15, color: colors.muted },
  tabTextSelected: { color: colors.ink },
  body: { flex: 1 },
});

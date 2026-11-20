import { StyleSheet, Text, View } from "react-native";
import { miniPage, tileRadius, type SiteLook, type SitePreview } from "../../features/build/siteDesign";
import { font } from "../../theme/tokens";

export function WebsiteTile({ look, fallback }: { look: SiteLook; fallback: SitePreview | null }) {
  const page = miniPage(look, fallback);
  const c = look.swatches;
  const r = tileRadius(look.radius);
  const bold = look.layout === "bold";
  const heroBg = bold ? c.primary : c.background;
  const heroInk = bold ? c.background : c.foreground;
  const centered = page.hero === "centered";
  const Button = ({ label, ghost }: { label: string; ghost?: boolean }) => (
    <View
      style={[
        s.btn,
        { borderRadius: r, backgroundColor: ghost ? "transparent" : bold ? c.accent : c.primary },
        ghost && { borderWidth: StyleSheet.hairlineWidth, borderColor: heroInk },
      ]}
    >
      <Text numberOfLines={1} style={[s.btnText, { color: ghost ? heroInk : c.background }]}>
        {label}
      </Text>
    </View>
  );
  return (
    <View style={[s.page, { backgroundColor: c.background }]} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={[s.nav, { borderBottomColor: c.muted }]}>
        <Text numberOfLines={1} style={[s.brand, { color: c.foreground }]}>
          {page.name}
        </Text>
        <View style={s.links}>
          {page.links.map((l) => (
            <Text key={l} numberOfLines={1} style={[s.link, { color: c.foreground }]}>
              {l}
            </Text>
          ))}
        </View>
        <Button label={page.action} />
      </View>

      <View style={[s.hero, { backgroundColor: heroBg }, page.hero === "split" && s.heroSplit]}>
        <View style={[s.heroCopy, centered && s.centered]}>
          {page.eyebrow ? (
            <Text numberOfLines={1} style={[s.eyebrow, { color: bold ? c.background : c.primary }]}>
              {page.eyebrow}
            </Text>
          ) : null}
          <Text numberOfLines={2} style={[s.headline, { color: heroInk }, centered && s.textCenter]}>
            {page.headline}
          </Text>
          {page.subtitle ? (
            <Text numberOfLines={2} style={[s.sub, { color: heroInk }, centered && s.textCenter]}>
              {page.subtitle}
            </Text>
          ) : null}
          <View style={s.actions}>
            <Button label={page.action} />
            <Button label="Learn more" ghost />
          </View>
        </View>
        {page.hero === "split" ? <View style={[s.panel, { borderRadius: r, backgroundColor: c.accent }]} /> : null}
      </View>

      <View style={s.features}>
        {page.features.map((f, i) => (
          <View
            key={f.title}
            style={[
              s.feature,
              { borderRadius: r, borderColor: c.muted },
              bold && { backgroundColor: c.primary, borderColor: c.primary },
            ]}
          >
            {look.layout === "editorial" ? <Text style={[s.num, { color: c.primary }]}>{`0${i + 1}`}</Text> : null}
            <Text numberOfLines={1} style={[s.featureTitle, { color: bold ? c.background : c.foreground }]}>
              {f.title}
            </Text>
            {f.body ? (
              <Text numberOfLines={2} style={[s.featureBody, { color: bold ? c.background : c.foreground }]}>
                {f.body}
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      <View style={[s.band, { borderRadius: r, backgroundColor: page.band.kind === "quote" ? c.muted : c.primary }]}>
        <Text
          numberOfLines={2}
          style={[s.bandText, { color: page.band.kind === "quote" ? c.foreground : c.background }]}
        >
          {page.band.kind === "quote" ? `“${page.band.text}”` : page.band.text}
        </Text>
      </View>

      <View style={[s.footer, { borderTopColor: c.muted }]}>
        <Text numberOfLines={1} style={[s.footText, { color: c.foreground }]}>
          {page.name}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { overflow: "hidden", paddingBottom: 6 },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: { flexShrink: 1, fontFamily: font.family.semi, fontSize: 9, includeFontPadding: false },
  links: { flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  link: { maxWidth: 70, fontFamily: font.family.regular, fontSize: 7, opacity: 0.75, includeFontPadding: false },
  btn: { paddingHorizontal: 7, paddingVertical: 3, maxWidth: 110 },
  btnText: { fontFamily: font.family.semi, fontSize: 7, includeFontPadding: false },
  hero: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 14 },
  heroSplit: { alignItems: "center" },
  heroCopy: { flex: 1, gap: 4 },
  centered: { alignItems: "center" },
  textCenter: { textAlign: "center" },
  eyebrow: { fontFamily: font.family.semi, fontSize: 7, letterSpacing: 0.6, textTransform: "uppercase", includeFontPadding: false },
  headline: { fontFamily: font.family.bold, fontSize: 15, lineHeight: 18, includeFontPadding: false },
  sub: { fontFamily: font.family.regular, fontSize: 8, lineHeight: 11, opacity: 0.8, includeFontPadding: false },
  actions: { flexDirection: "row", gap: 5, marginTop: 4 },
  panel: { width: "38%", aspectRatio: 1.2, opacity: 0.85 },
  features: { flexDirection: "row", gap: 6, paddingHorizontal: 12, paddingTop: 4 },
  feature: { flex: 1, gap: 2, padding: 6, borderWidth: StyleSheet.hairlineWidth },
  num: { fontFamily: font.family.semi, fontSize: 7, includeFontPadding: false },
  featureTitle: { fontFamily: font.family.semi, fontSize: 8, includeFontPadding: false },
  featureBody: { fontFamily: font.family.regular, fontSize: 6.5, lineHeight: 8.5, opacity: 0.75, includeFontPadding: false },
  band: { marginHorizontal: 12, marginTop: 8, paddingHorizontal: 10, paddingVertical: 8 },
  bandText: { fontFamily: font.family.semi, fontSize: 9, lineHeight: 12, includeFontPadding: false },
  footer: { marginTop: 8, marginHorizontal: 12, paddingTop: 5, borderTopWidth: StyleSheet.hairlineWidth },
  footText: { fontFamily: font.family.medium, fontSize: 7, opacity: 0.7, includeFontPadding: false },
});

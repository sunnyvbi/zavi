import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { CONNECTOR_LOGO_XML } from "./connectorLogos.generated";
import { drawableLogoSvg } from "../../features/connectors/logoSvg";
import { font, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

const LOGO_ALIAS: Readonly<Record<string, string>> = {
  "composio.instagram": "instagram_social",
  "composio.youtube": "youtube_social",
};

export function ConnectorTile({
  slug,
  label,
  size = 40,
  logoUrl,
}: {
  slug: string;
  label: string;
  size?: number;
  logoUrl?: string;
}) {
  const styles = useStyles(makeStyles);
  const bundled = useMemo(() => drawableLogoSvg(CONNECTOR_LOGO_XML[LOGO_ALIAS[slug] ?? slug]), [slug]);
  const remote = useRemoteLogo(bundled ? undefined : logoUrl);
  const [drawFailed, setDrawFailed] = useState(false);
  const xml = drawFailed ? null : bundled ?? remote;
  const mark = Math.round(size * 0.6);
  const letter = (
    <Text style={[styles.letter, { fontSize: Math.round(size * 0.375) }]}>
      {label.replace(/^Your /, "").charAt(0).toUpperCase()}
    </Text>
  );
  return (
    <View style={[styles.tile, xml && styles.plate, { width: size, height: size, borderRadius: Math.round(size * 0.3) }]}>
      {xml ? (
        <LogoBoundary key={xml} onError={() => setDrawFailed(true)}>
          <SvgXml xml={xml} width={mark} height={mark} onError={() => setDrawFailed(true)} />
        </LogoBoundary>
      ) : (
        letter
      )}
    </View>
  );
}

const logoCache = new Map<string, string>();
const logoLoads = new Map<string, Promise<string | null>>();

function loadLogo(uri: string): Promise<string | null> {
  let load = logoLoads.get(uri);
  if (!load) {
    load = fetch(uri)
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        const xml = drawableLogoSvg(text);
        if (xml) logoCache.set(uri, xml);
        return xml;
      })
      .catch(() => null)
      .finally(() => logoLoads.delete(uri));
    logoLoads.set(uri, load);
  }
  return load;
}

function useRemoteLogo(uri: string | undefined): string | null {
  const [xml, setXml] = useState<string | null>(uri ? logoCache.get(uri) ?? null : null);
  useEffect(() => {
    const cached = uri ? logoCache.get(uri) : undefined;
    setXml(cached ?? null);
    if (!uri || cached) return;
    let live = true;
    void loadLogo(uri).then((loaded) => {
      if (live) setXml(loaded);
    });
    return () => {
      live = false;
    };
  }, [uri]);
  return xml;
}

class LogoBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  tile: { backgroundColor: colors.wire.tint, alignItems: "center", justifyContent: "center" },
  plate: { backgroundColor: colors.wire.logoPlate },
  letter: { fontFamily: font.family.bold, color: colors.wire.text, includeFontPadding: false },
});

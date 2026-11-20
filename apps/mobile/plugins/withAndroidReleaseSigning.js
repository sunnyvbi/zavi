const fs = require("fs");
const path = require("path");
const { withGradleProperties, withAppBuildGradle, withDangerousMod } = require("expo/config-plugins");

const ZAVI_KEYS = [
  "ZAVI_RELEASE_STORE_FILE",
  "ZAVI_RELEASE_KEY_ALIAS",
  "ZAVI_RELEASE_STORE_PASSWORD",
  "ZAVI_RELEASE_KEY_PASSWORD",
];

function readSecretsProperties(mobileDir) {
  const propsPath = path.join(mobileDir, ".secrets", "release-signing.properties");
  if (!fs.existsSync(propsPath)) return null;
  const values = {};
  for (const line of fs.readFileSync(propsPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function resolveZaviValues(mobileDir) {
  const fromFile = readSecretsProperties(mobileDir) || {};
  const values = {};
  for (const key of ZAVI_KEYS) {
    values[key] = process.env[key] || fromFile[key] || null;
  }
  return values;
}

const withAndroidReleaseSigning = (config) => {
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const mobileDir = path.join(cfg.modRequest.projectRoot);
      const androidDir = cfg.modRequest.platformProjectRoot;
      const keystorePath =
        process.env.ZAVI_RELEASE_KEYSTORE_PATH ||
        path.join(mobileDir, ".secrets", "release.keystore");
      const destPath = path.join(androidDir, "app", "release.keystore");
      if (!fs.existsSync(destPath) && fs.existsSync(keystorePath)) {
        fs.copyFileSync(keystorePath, destPath);
      } else if (!fs.existsSync(destPath)) {
        console.warn(
          "[withAndroidReleaseSigning] No release keystore found (checked .secrets/release.keystore and ZAVI_RELEASE_KEYSTORE_PATH). " +
            "Release builds will be unsigned until it's added — see docs/android-release-signing-setup.md.",
        );
      }
      return cfg;
    },
  ]);

  config = withGradleProperties(config, (cfg) => {
    const values = resolveZaviValues(cfg.modRequest.projectRoot);
    if (!values.ZAVI_RELEASE_STORE_FILE) values.ZAVI_RELEASE_STORE_FILE = "release.keystore";
    for (const key of ZAVI_KEYS) {
      const value = values[key];
      if (!value) continue;
      const existing = cfg.modResults.find((item) => item.type === "property" && item.key === key);
      if (existing) {
        existing.value = value;
      } else {
        cfg.modResults.push({ type: "property", key, value });
      }
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes("ZAVI_RELEASE_STORE_FILE")) return cfg;
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        release {
            storeFile file(ZAVI_RELEASE_STORE_FILE)
            storePassword ZAVI_RELEASE_STORE_PASSWORD
            keyAlias ZAVI_RELEASE_KEY_ALIAS
            keyPassword ZAVI_RELEASE_KEY_PASSWORD
        }`,
    );
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /release\s*\{\s*\n\s*signingConfig signingConfigs\.debug/,
      "release {\n            signingConfig signingConfigs.release",
    );
    return cfg;
  });

  return config;
};

module.exports = withAndroidReleaseSigning;

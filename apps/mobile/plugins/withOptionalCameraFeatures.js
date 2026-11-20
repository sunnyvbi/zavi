const { withAndroidManifest } = require("expo/config-plugins");

const OPTIONAL_FEATURES = ["android.hardware.camera", "android.hardware.camera.autofocus"];

module.exports = function withOptionalCameraFeatures(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const features = manifest["uses-feature"] ?? [];
    for (const name of OPTIONAL_FEATURES) {
      const existing = features.find((item) => item.$["android:name"] === name);
      if (existing) existing.$["android:required"] = "false";
      else features.push({ $: { "android:name": name, "android:required": "false" } });
    }
    manifest["uses-feature"] = features;
    return cfg;
  });
};

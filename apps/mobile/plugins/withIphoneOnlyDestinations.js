const { withXcodeProject } = require("expo/config-plugins");

module.exports = function withIphoneOnlyDestinations(config) {
  return withXcodeProject(config, (cfg) => {
    const buildConfigs = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(buildConfigs)) {
      const settings = entry && entry.buildSettings;
      if (!settings || !settings.PRODUCT_BUNDLE_IDENTIFIER) continue;
      settings.SUPPORTS_MACCATALYST = "NO";
      settings.SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = "NO";
      settings.SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD = "NO";
    }
    return cfg;
  });
};

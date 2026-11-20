const { withXcodeProject } = require("expo/config-plugins");

module.exports = function withIosVersionBuildSettings(config) {
  return withXcodeProject(config, (cfg) => {
    const version = config.ios?.version ?? config.version;
    const buildNumber = config.ios?.buildNumber;
    const buildConfigs = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(buildConfigs)) {
      const settings = entry && entry.buildSettings;
      if (!settings || !settings.PRODUCT_BUNDLE_IDENTIFIER) continue;
      if (version) settings.MARKETING_VERSION = version;
      if (buildNumber) settings.CURRENT_PROJECT_VERSION = buildNumber;
    }
    return cfg;
  });
};

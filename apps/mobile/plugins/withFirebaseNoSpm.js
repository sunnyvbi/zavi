const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const LINE = "$RNFirebaseDisableSPM = true";

module.exports = function withFirebaseNoSpm(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes(LINE)) fs.writeFileSync(podfile, `${LINE}\n${contents}`);
      return cfg;
    },
  ]);
};

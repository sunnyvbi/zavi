const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = false;

config.resolver.extraNodeModules = {
  react: path.dirname(require.resolve("react/package.json", { paths: [projectRoot] })),
  "react-dom": path.dirname(require.resolve("react-dom/package.json", { paths: [projectRoot] })),
};

module.exports = config;

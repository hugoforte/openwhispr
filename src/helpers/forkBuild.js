// Fork builds keep upstream's plain X.Y.Z app version, because the server's
// version checks and the policy headers require exactly that. The build number
// package.json carries (`forkBuild`, set by the fork's release workflow) is what
// orders two fork builds of one upstream version for the updater.
function forkUpdateVersion(appVersion, forkBuild) {
  const build = Number(forkBuild);
  return Number.isInteger(build) && build > 0 ? `${appVersion}-hf.${build}` : null;
}

module.exports = { forkUpdateVersion };

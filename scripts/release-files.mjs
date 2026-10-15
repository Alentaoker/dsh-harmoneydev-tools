// Session implementation modules belong in a source release; session data does not.
const deniedNames = /^(?:native-inputs\.json|client-inputs\.json|routes\.ts|local\.properties|\.npmrc|\.git-credentials)$/i;
const deniedSuffixes = /\.(?:pyc|log|p12|p7b|cer|pem|key)$/i;
const sourceSuffixes = /\.(?:[cm]?[jt]sx?|css|scss|md)$/i;
export function includeReleaseFile(name) {
  if (deniedNames.test(name) || deniedSuffixes.test(name) || /^\.env/i.test(name)) return false;
  return !/^session/i.test(name) || sourceSuffixes.test(name);
}

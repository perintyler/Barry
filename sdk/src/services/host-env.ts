/**
 * OS essentials, the Barry instance's location and the CLI program it names for
 * hooks (`BARRY_HOOK_DISPATCHER`), and the Node linked checkout wrappers run
 * (`BARRY_NODE`); credentials are selected separately.
 */
const HOST_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL", "BARRY_HOME", "BARRY_DIR",
  "BARRY_HOOK_DISPATCHER", "BARRY_NODE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
] as const;

export function hostEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return Object.fromEntries(HOST_ENVIRONMENT_NAMES.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]]));
}

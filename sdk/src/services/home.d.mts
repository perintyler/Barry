/** `~/Library/Application Support/Barry`, or `$BARRY_HOME/app-support`. */
export declare function barryAppSupportDir(): string;
/** `~/Library/Caches/Barry`, or `$BARRY_HOME/cache`. */
export declare function barryCacheDir(): string;
/** A registered bag name as one directory segment; extensions use +. */
export declare function bagSegment(bag: string): string;
/** `<app support>/data/<bag>`, created 0700. Extensions use + in place of /. */
export declare function bagDataDir(bag: string, options?: { create?: boolean }): string;
/** `~/Library/Logs/Barry`, or `$BARRY_HOME/logs`. */
export declare function barryLogsDir(): string;
/** `<logs>/<bag>`. Not created. */
export declare function bagLogsDir(bag: string): string;
/** `$XDG_CONFIG_HOME/barry` (default `~/.config/barry`), or `$BARRY_HOME/config`. */
export declare function barryConfigDir(): string;
/** 8-hex-char id for this instance, derived from its root. Unique per instance, stable across calls. */
export declare function instanceId(): string;
/** `$TMPDIR/barry-<hash of the instance root>`, for sockets and pid files. */
export declare function barryRunDir(): string;
/** `<app support>/env`, the instance's secrets file. */
export declare function barryEnvPath(): string;
/** `<app support>/adapters.json`, the harness adapters this installation has. */
export declare function barryAdaptersPath(): string;

export function barryStoresDir(): string;
export function barryArchivesDir(): string;
export function barryBackupsDir(): string;

/** Explicitly selected model adapter packages for this installation. */
export declare function barryVendorAdaptersPath(): string;
export declare function barryModelVendorsPath(): string;

export declare function barryReleasesDir(): string;
export declare function barryCurrentDir(): string;
export declare function installationRoot(): string;
export declare function installationPath(path: string): string;

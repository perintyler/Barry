/** The registered name of an add-on to one bag. */
export function extensionName(parent: string, name: string): string {
  return `${parent}/${name}`;
}

/** The parent of an extension, or null for a plain bag. */
export function parentOf(bag: string): string | null {
  const slash = bag.indexOf("/");
  return slash < 0 ? null : bag.slice(0, slash);
}

export function registeredName(manifest: { name: string; extends?: string }): string {
  return manifest.extends ? extensionName(manifest.extends, manifest.name) : manifest.name;
}

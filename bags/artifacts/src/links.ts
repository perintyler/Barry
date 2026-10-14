import { serviceAddress, ServiceRegistryError } from "@barry-rocks/sdk/services";

export function artifactWebAddress(): string {
  return serviceAddress("artifacts.web").replace(/\/$/, "");
}

export function artifactLink<Key extends string>(key: Key, path: string): Partial<Record<Key, string>> {
  try {
    return { [key]: `${artifactWebAddress()}${path}` } as Record<Key, string>;
  } catch (error) {
    if (error instanceof ServiceRegistryError) return {};
    throw error;
  }
}

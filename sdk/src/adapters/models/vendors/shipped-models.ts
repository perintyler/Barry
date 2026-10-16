import { readFileSync } from "node:fs";
import { parseVendorModels } from "./models.js";
import type { Vendor } from "./index.js";

export const SHIPPED_VENDORS_YAML: string = readFileSync(
  new URL("./shipped-models.yaml", import.meta.url),
  "utf8",
);

export const SHIPPED_VENDORS: Vendor[] = parseVendorModels(SHIPPED_VENDORS_YAML);
export const SHIPPED_MODELS: Vendor[] = SHIPPED_VENDORS;


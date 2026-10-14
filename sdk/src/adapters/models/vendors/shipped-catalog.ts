import { readFileSync } from "node:fs";
import { parseVendorCatalog } from "./catalog.js";
import type { Vendor } from "./index.js";

export const SHIPPED_VENDORS_YAML: string = readFileSync(
  new URL("./shipped-catalog.yaml", import.meta.url),
  "utf8",
);

export const SHIPPED_VENDORS: Vendor[] = parseVendorCatalog(SHIPPED_VENDORS_YAML);

import { BarryClient } from "./platypus.js";
import type { BarryClientOptions } from "./http.js";
import { localConnection } from "../services/local-connection.js";

/** Connect through the selected instance's registry and installation credential references. */
export async function connectLocal(options: BarryClientOptions = {}): Promise<BarryClient> {
  return new BarryClient(await localConnection(options));
}

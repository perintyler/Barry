import type { IncomingHttpHeaders } from "node:http";

const TOKEN = /^[\x21-\x7e]{1,4096}$/;

export function requestCredential(request: { headers: IncomingHttpHeaders; rawHeaders?: readonly string[] }): string | null {
  // Node can discard duplicate Authorization fields; inspect the original fields as well.
  const counts = new Map<string, number>();
  for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
    const name = request.rawHeaders![index].toLowerCase();
    if (name !== "authorization" && name !== "x-barry-secret") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (counts.get(name)! > 1) return null;
  }
  const authorization = request.headers.authorization;
  const secret = request.headers["x-barry-secret"];
  if (authorization !== undefined && typeof authorization !== "string") return null;
  if (secret !== undefined && (typeof secret !== "string" || !TOKEN.test(secret))) return null;
  const bearer = authorization === undefined ? undefined : /^Bearer ([\x21-\x7e]{1,4096})$/i.exec(authorization)?.[1];
  if (authorization !== undefined && bearer === undefined) return null;
  if (bearer !== undefined && secret !== undefined && bearer !== secret) return null;
  return bearer ?? secret ?? null;
}

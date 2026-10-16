import { appendFileSync } from "node:fs";
const forbidden = /(?:express|@modelcontextprotocol\/sdk|esbuild|@inquirer\/|@ag-ui\/core)/;
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  // tsx itself requires esbuild to transpile sources; distinguish that
  // unavoidable loader dependency from application imports.
  const loaderEsbuild = result.url.includes("/esbuild") && context.parentURL?.includes("/tsx/");
  if (process.env.BARRY_IMPORT_LOG && !loaderEsbuild) appendFileSync(process.env.BARRY_IMPORT_LOG, result.url + "\n");
  return result;
}
export async function load(url, context, next) {
  const result = await next(url, context);
  // Bundled modules no longer have separate resolutions. esbuild preserves
  // their source identifiers as comments, so check the loaded chunks too.
  if (url.includes("/cli/dist/") && result.source && process.env.BARRY_IMPORT_LOG) {
    for (const line of result.source.toString().split("\n")) {
      if (line.startsWith("// ") && forbidden.test(line)) appendFileSync(process.env.BARRY_IMPORT_LOG, line + "\n");
    }
  }
  return result;
}

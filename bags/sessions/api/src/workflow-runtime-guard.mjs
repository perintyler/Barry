/** Declared dependency integrity for trusted retained code, not OS containment. */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(realpathSync(fileURLToPath(import.meta.url)));
const bytes = readFileSync(join(root, ".closure.json"));
const hash = value => createHash("sha256").update(value).digest("hex");
if (hash(bytes) !== process.env.BARRY_WORKFLOW_CLOSURE_SHA256) throw new Error("WorkflowRuntimeIdentityMismatch");
const manifest = JSON.parse(bytes);
if (manifest.version !== 2 || manifest.protocol !== 1 || manifest.nodeVersion !== process.version || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error("WorkflowRuntimeABIUnavailable");
const files = new Map(manifest.files.map(file => [resolve(root, file.path), file.content]));
function read(url) {
  if (url.startsWith("node:")) return undefined;
  if (!url.startsWith("file:")) throw new Error("WorkflowRuntimeExternalModuleForbidden");
  const path = realpathSync(fileURLToPath(url)), expected = files.get(path);
  if (!expected) throw new Error("WorkflowRuntimeExternalModuleForbidden");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.bytes) throw new Error("WorkflowRuntimeModuleChanged");
    const buffer = Buffer.alloc(expected.bytes + 1);let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length);if (!count) break;length += count; }
    const content = buffer.subarray(0, length);
    if (content.length !== expected.bytes || hash(content) !== expected.digest) throw new Error("WorkflowRuntimeModuleChanged");
    return content;
  } finally { closeSync(fd); }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);read(result.url);return result;
  },
  load(url, context, nextLoad) {
    const content = read(url), result = nextLoad(url, context);
    // Evaluate the same verified bytes, including CommonJS/createRequire.
    // Node's synchronous CommonJS loader intentionally leaves both formats
    // undefined for .js in a package without "type". Preserve that choice and
    // its syntax detection while supplying the same verified JavaScript bytes.
    const ordinaryJavaScript = result.format === undefined && context.format === undefined && content && fileURLToPath(url).endsWith(".js");
    if (content && (["module", "commonjs", "json"].includes(result.format) || ordinaryJavaScript)) return { ...result, source: content };
    if (!content && result.format === "builtin") return result;
    // Native addons use the separately checked private native mapping. Node
    // opens that private image; this hook does not claim to sandbox dlopen.
    if (content && result.format === "addon") return result;
    throw new Error("WorkflowRuntimeModuleFormatUnsupported");
  },
});

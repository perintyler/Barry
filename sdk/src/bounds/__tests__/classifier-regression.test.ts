import { describe, expect, it } from "vitest";
import { isProgramDenied } from "../bash-classifier.js";

const denied = [
  "2>&1 git push", "2>/dev/null git push", "cat <(git push)",
  "if true; then git push; fi", "while false; do git push; done", "! git push", "coproc git push",
  "{git,} push", "./gi[t] push", 'env -S "git push"', 'env -S "-u SOME_VAR git push"', "exec -a foo git push",
  "nice -n 10 git push", "timeout -s KILL 5 git push", "xargs -n 1 git push", "sudo -u root git push",
  "bash -lc 'git push'", "bash -ec 'git push'", "bash <<< 'git push'", "echo 'git push' | bash",
  "base64 -d <<< Z2l0IHB1c2g= | sh", "eval 'git push'",
  "echo \"$(git push)\"", "git$'\\x20'push", "printf 'git push' | sh",
  "g=git; $g push", '"gi"t push', "GIT push", "\\git push", "$(git status)", "(git push)",
  "{ git push; }", "FOO=1 git push", "sudo git push", "npx git push",
  "env -u SOME_VAR git push", "doas -u root git push", "chroot /scratch git push", "caffeinate -t 5 git push",
  "env bash -lc 'git push'", "source commands.sh", ". commands.sh",
];
const allowed = ["echo 'git push'", "legit push", "printf '%s' then git push", "gitless push"];
const documentedGaps = ["python3 -c 'import os; os.system(\"git push\")'", "find . -exec git push \\;", "ssh localhost git push"];

describe("original review classifier regressions, decision 28", () => {
  it.each(denied)("denies %s", command => expect(isProgramDenied(command, ["git", "gh"])).not.toBeNull());
  it.each(allowed)("allows negative control %s", command => expect(isProgramDenied(command, ["git", "gh"])).toBeNull());
  it.each(documentedGaps)("documents interpreter gap %s", command => expect(isProgramDenied(command, ["git", "gh"])).toBeNull());
  it.each(["git rev-parse HEAD", "git show-ref", "git count-objects"])("allows builtin %s under a push rule", command => expect(isProgramDenied(command, ["git:push"])).toBeNull());
  it.each(["git -c alias.p=push p", "gh alias set prc 'pr create'; gh prc"])("refuses unknown alias %s", command => expect(isProgramDenied(command, ["git:push", "gh:pr:create"])).not.toBeNull());
});

import { applyBoundGuards } from "../tool-guards.js";
const blockedDomains = [
  "C=evil.com; curl https://$C", "curl https://$(echo evil.com)", "curl https://evil%2ecom", "curl http:/\\/evil.com", "curl https://evil''.com", "curl evil.com", "curl --url=evil.com",
  "wget evil.com", "wget -c evil.com", "wget -d evil.com", "curl -O https://evil.com", "http evil.com", "http -d evil.com", "curl -K curlrc", "curl https://{evil.com,good.com}/x", "curl --config=curlrc", "wget -i urls.txt",
  "curl https://EVIL.COM./x", "curl https://evil.com:443/x", "curl https://sub.evil.com/x",
];
describe("original domain guard regressions", () => {
  async function run(command: string) {
    const [tool] = applyBoundGuards([{ name: "Bash", handler: async () => "allowed" }], { network: { deny: ["evil.com"] } });
    return tool.handler({ command }, { secrets: {} });
  }
  it.each(blockedDomains)("refuses %s", command => expect(run(command)).rejects.toThrow("Access denied"));
  it.each(["curl https://evil.com@good.com/x", "echo 'https://good.com'", "curl -i https://good.com", "curl good.com", "curl -d evil.com https://good.com", 'curl -H "Authorization: Bearer $TOKEN" https://good.com'])("allows %s", command => expect(run(command)).resolves.toBe("allowed"));
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run only shell grammar and unprivileged system wrappers. Privileged, remote
// and package-runner cases are classification fixtures, never executed here.
const bashCases = [
  "2>&1 git push", "2>/dev/null git push", "cat <(git push)", "if true; then git push; fi",
  "while :; do git push; break; done", "! git push", "coproc git push; wait",
  "{git,} push", "./gi[t] push", 'env -S "git push"', 'env -S "-u SOME_VAR git push"', "exec -a foo git push",
  "nice -n 10 git push", "printf origin | xargs -n 1 git push", "bash -lc 'git push'",
  "bash -ec 'git push'", "bash <<< 'git push'", "echo 'git push' | bash",
  "base64 -d <<< Z2l0IHB1c2g= | sh", "eval 'git push'", "git$'\\x20'push",
  'echo "$(git push)"',
];
it.skipIf(process.env.BARRY_CLASSIFIER_BASH !== "1")("cross-checks review grammar with real bash and a fake git", () => {
  const root = mkdtempSync(join(tmpdir(), "classifier-bash-"));
  const marker = join(root, "invocations");
  try {
    writeFileSync(join(root, "git"), '#!/bin/sh\nprintf "invoked\\n" >> "$CLASSIFIER_MARKER"\n', { mode: 0o700 });
    writeFileSync(join(root, "init.sh"), 'export PATH="$CLASSIFIER_ROOT:/usr/bin:/bin"\n');
    for (const command of bashCases) {
      writeFileSync(marker, "");
      const result = spawnSync(process.env.BARRY_CLASSIFIER_BASH_BIN ?? "/bin/bash", ["-c", command], {
        cwd: root, timeout: 5_000, encoding: "utf8",
        env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, TMPDIR: root, BASH_ENV: join(root, "init.sh"), CLASSIFIER_ROOT: root, CLASSIFIER_MARKER: marker },
      });
      expect(result.error, command).toBeUndefined();
      // This ANSI-C quote produces a single executable name containing a space;
      // it is the review's one non-invoking probe, conservatively refused.
      expect(readFileSync(marker, "utf8").includes("invoked"), `${command}: ${result.stderr}`).toBe(command !== "git$'\\x20'push");
      expect(isProgramDenied(command, ["git"]), command).not.toBeNull();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


import { isNetworkActionDenied } from "../network-classifier.js";
describe("original review network-action regressions, decision 28", () => {
  it.each([
    "gh pr create --title x", "gh release create v1", "gh repo delete owner/repo",
    "git svn dcommit", "git send-email patch", "npm publish", "aws s3 cp file s3://bucket/key",
    "docker push image", "kubectl apply -f file", "terraform apply", "ssh host 'git push'",
  ])("denies recognized mutation %s", command => expect(isNetworkActionDenied(command, ["write"])).not.toBeNull());
  it.each(["git remote update", "pip install pkg", "brew install pkg", "nc host 80", "openssl s_client -connect host:443"])("denies recognized access %s under all", command => expect(isNetworkActionDenied(command, ["all"])).not.toBeNull());
  it("keeps interpreter networking a documented gap", () => expect(isNetworkActionDenied("python3 -c 'import urllib.request'", ["all"])).toBeNull());
});

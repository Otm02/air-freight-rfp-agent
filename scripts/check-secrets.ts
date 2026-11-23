import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface SecretRule {
  name: string;
  regex: RegExp;
}

const SECRET_RULES: readonly SecretRule[] = [
  { name: "Google/Gemini API Key", regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "OpenAI Secret Key", regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub Personal Access Token", regex: /\bgh[psu]_[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub Fine-Grained Token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "Private Key PEM Block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

function runGit(args: readonly string[], cwd: string): string {
  const fullArgs = ["-c", "safe.directory=*", ...args];
  return execFileSync("git", fullArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function isBinaryBuffer(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 1024));
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) {
      return true;
    }
  }
  return false;
}

function main(): void {
  const repoRoot = process.cwd();
  const findings: string[] = [];

  const trackedRaw = runGit(["ls-files", "-z"], repoRoot);
  const trackedFiles = trackedRaw
    .split("\0")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  for (const relPath of trackedFiles) {
    const base = path.posix.basename(relPath.replaceAll("\\", "/"));
    if (base.startsWith(".env") && base !== ".env.example") {
      findings.push(`Tracked environment file forbidden: ${relPath}`);
    }

    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
      continue;
    }
    const buf = fs.readFileSync(absPath);
    if (isBinaryBuffer(buf)) {
      continue;
    }
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      for (const rule of SECRET_RULES) {
        if (rule.regex.test(line)) {
          findings.push(
            `Working tree match [${rule.name}] at ${relPath}:${i + 1}`,
          );
        }
      }
    }
  }

  let hasHead = true;
  try {
    runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
  } catch {
    hasHead = false;
  }

  if (hasHead) {
    const envHistoryRaw = runGit(
      ["log", "--all", "--name-only", "--pretty=format:__COMMIT__%H", "--", ".env", ".env.local", ".env.*.local"],
      repoRoot,
    );
    let currentCommit = "";
    for (const rawLine of envHistoryRaw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("__COMMIT__")) {
        currentCommit = line.slice("__COMMIT__".length);
        continue;
      }
      if (path.posix.basename(line) !== ".env.example") {
        findings.push(`Git history contains forbidden env file ${line} in commit ${currentCommit.slice(0, 8)}`);
      }
    }

    const patchLog = runGit(["log", "--all", "-p", "--no-textconv"], repoRoot);
    let commitHash = "unknown";
    let currentFile = "unknown";
    for (const line of patchLog.split(/\r?\n/)) {
      if (line.startsWith("commit ")) {
        commitHash = line.slice(7, 15);
        continue;
      }
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6);
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++")) {
        continue;
      }
      for (const rule of SECRET_RULES) {
        if (rule.regex.test(line)) {
          findings.push(
            `Git history match [${rule.name}] in commit ${commitHash} (${currentFile})`,
          );
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error("SECRET SCAN FAILED:");
    for (const f of findings) {
      console.error(` - ${f}`);
    }
    process.exit(1);
  }

  console.log(
    `Secret scan passed: ${trackedFiles.length} tracked files and full git history scanned with 0 findings.`,
  );
}

main();

#!/usr/bin/env node
// Secret scan: looks for credentials in every file git would commit (tracked + untracked-but-not-ignored). Used by `npm run scan:secrets` and CI.
// It prints file:line and the KIND of finding, never the secret itself. Add a line to ALLOW (below) only for values that are deliberately fake test fixtures.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);

const RULES = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['AWS secret access key assignment', /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/i],
  ['private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ['Anthropic / OpenAI style API key', /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['database URL with a password', /postgres(?:ql)?:\/\/[^:\s'"`]+:(?!(?:PASS|PASSWORD|pass|password|yourpassword|YOUR_PASSWORD|USER|user|changeme)\b|\*+|\.\.\.|…|<|\$\{)[^@\s'"`]{3,}@/],
  ['JWT secret assignment with a real-looking value', /JWT_SECRET\s*=\s*["']?(?!replace_with|your_|changeme|x{8}|\$\{|<)[A-Za-z0-9+/=_-]{24,}/],
  ['SMTP password assignment', /SMTP_PASS\s*=\s*["']?(?!s3cret-pass-xyz|\$\{|<|["']?\s*$)[^\s"']{6,}/],
];
// deliberately fake values used by the test suites
const ALLOW = [/sk-test-ai-key-123/, /s3cret-pass-xyz/, /ci-only-password/, /ci-only-jwt-secret/, /\$\{POSTGRES_PASSWORD\}/, /change-me-to-a-long-random-password/, /postgresql:\/\/…\//, /postgresql:\/\/USER:PASS@/];
const SKIP_DIR = /(^|\/)(node_modules|dist|\.git)\//;
const SKIP_EXT = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|zip|lock)$|package-lock\.json$/i;

let findings = 0;
for (const f of files) {
  if (SKIP_DIR.test(f) || SKIP_EXT.test(f)) continue;
  const full = path.join(repo, f);
  let text; try { const st = fs.statSync(full); if (!st.isFile() || st.size > 2_000_000) continue; text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  if (/\.env$|\.env\.[a-z]+$/.test(f) && !/\.example$/.test(f)) { console.log(`${f}: an environment file is not ignored by git`); findings += 1; continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const [kind, re] of RULES) if (re.test(line)) { console.log(`${f}:${i + 1}: possible ${kind}`); findings += 1; }
  });
}
console.log(`secret scan: ${files.length} files checked, ${findings} findings`);
process.exit(findings ? 1 : 0);

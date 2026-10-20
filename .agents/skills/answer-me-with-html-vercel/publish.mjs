#!/usr/bin/env node
// Project compatibility wrapper: the global skill owns shared Vercel publishing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const skill = process.env.ANSWER_ME_WITH_HTML_SKILL_DIR ??
  path.join(homedir(), '.agents', 'skills', 'answer-me-with-html');
const entry = path.join(skill, 'scripts', 'publish.mjs');
if (!existsSync(entry)) {
  process.stderr.write('Missing global answer-me-with-html publisher: ' + entry + '\n');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) process.stderr.write(result.error.message + '\n');
  process.exitCode = result.status ?? 1;
}

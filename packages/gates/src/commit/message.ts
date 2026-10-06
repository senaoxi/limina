import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const convention = '.github/commit-convention.md';

function fail(message: string): never {
  throw new Error(message);
}

function getCommentPrefix(): string {
  const result = spawnSync(
    'git',
    ['config', '--get-regexp', String.raw`^core\.comment(char|string)$`],
    { encoding: 'utf8' },
  );
  if (result.status === 1) return '#';
  if (result.status !== 0) fail('cannot read the Git comment configuration');
  const prefixes = result.stdout
    .trimEnd()
    .split('\n')
    .map((entry) => entry.slice(entry.indexOf(' ') + 1))
    .filter((prefix) => prefix && prefix !== 'auto');
  prefixes.push('#');
  // Probe Git itself: older versions ignore commentString, and aliases can overlap.
  const candidates = [...new Set(prefixes)].toSorted(
    (left, right) => left.length - right.length,
  );
  for (const prefix of candidates) {
    const probe = spawnSync('git', ['stripspace', '--strip-comments'], {
      encoding: 'utf8',
      input: `${prefix} comment\n`,
    });
    if (probe.status !== 0) fail('cannot resolve the Git comment prefix');
    if (probe.stdout === '') return prefix;
  }
  return fail('cannot resolve the Git comment prefix');
}

function getLines(message: string): string[] {
  const commentPrefix = getCommentPrefix();
  const cleanup = spawnSync('git', ['config', '--get', 'commit.cleanup'], {
    encoding: 'utf8',
  });
  if (cleanup.status !== 0 && cleanup.status !== 1)
    fail('cannot read the Git message cleanup configuration');
  const configured = cleanup.stdout.trim();
  const mode =
    configured && configured !== 'default'
      ? configured
      : process.env.GIT_EDITOR === ':'
        ? 'whitespace'
        : 'strip';
  let lines = message.replaceAll('\r\n', '\n').split('\n');
  if (mode === 'scissors' && process.env.GIT_EDITOR !== ':') {
    const scissors = lines.indexOf(
      `${commentPrefix} ------------------------ >8 ------------------------`,
    );
    if (scissors !== -1) lines = lines.slice(0, scissors);
  }
  if (mode === 'strip')
    lines = lines.filter((line) => !line.startsWith(commentPrefix));
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

function checkMessage(lines: string[]): void {
  if (lines.length === 0) fail('the commit message must not be empty');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('@commitlint/cli/cli.js')),
      '--config',
      fileURLToPath(
        new URL('../../../../commitlint.config.mjs', import.meta.url),
      ),
      '--strict',
      '--color=false',
    ],
    { encoding: 'utf8', input: lines.join('\n') },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    fail(result.stderr.trim() || result.stdout.trim() || 'commitlint failed');
}

try {
  const messageFile = process.argv[2];
  if (!messageFile || process.argv.length !== 3)
    fail('usage: node packages/gates/src/commit/message.ts <message-file>');
  checkMessage(getLines(readFileSync(messageFile, 'utf8')));
} catch (error) {
  const detail =
    error instanceof Error
      ? error.message
      : 'cannot validate the commit message';
  process.stderr.write(`commit-msg: ${detail}\nSee ${convention}\n`);
  process.exitCode = 1;
}

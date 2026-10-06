import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicensePolicy } from '../repo.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length > 1 ||
    (arguments_.length === 1 && arguments_[0] !== '--staged')
  ) {
    throw new Error('usage: gates:check [--staged]');
  }
  const isStaged = arguments_.includes('--staged');
  const read = (file: string): string =>
    isStaged
      ? execFileSync('git', ['show', `:${file}`], {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : readFileSync(path.join(repo, file), 'utf8');
  checkLicensePolicy(
    read('.agents/docs/license-policy.md'),
    read('.github/dependency-review-config.yml'),
  );
  if (isStaged) {
    execFileSync('git', ['diff', '--cached', '--check'], {
      cwd: repo,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  process.stdout.write(
    `Repository gates passed (${isStaged ? 'index' : 'worktree'}).\n`,
  );
} catch (error) {
  const detail =
    error instanceof Error ? error.message : 'cannot check repository gates';
  process.stderr.write(`pre-commit: ${detail}\n`);
  process.exitCode = 1;
}

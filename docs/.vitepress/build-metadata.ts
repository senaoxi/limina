import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function resolveCommitId(): string | null {
  if (process.env.LIMINA_DOCS_BUILD !== '1') return 'dev';
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

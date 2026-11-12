import path from 'node:path';

/**
The task's bounded direct-invocation language, not a general shell parser.
*/
export function workflowCommand(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) return undefined;
  const tokens = value.trim().match(/"[^"\r\n]*"|'[^'\r\n]*'|[^ \t]+/gu);
  // Whole quoted words still need whitespace separators: the shell concatenates
  // adjacent fragments, so splitting them would execute a different command.
  if (!tokens || tokens.join(' ') !== value.trim().replaceAll(/[ \t]+/gu, ' '))
    return undefined;
  const words = tokens.map((token) =>
    /^(["']).*\1$/u.test(token) ? token.slice(1, -1) : token,
  );
  if (words[0] === 'pnpm' && words[1] === 'exec') words.splice(0, 2);
  if (words.shift() !== 'limina') return undefined;
  if (words[0] === 'check')
    return words.length === 1 || (words.length === 2 && words[1] === '--force')
      ? words
      : undefined;
  if (words.length === 2 && words[0] === 'checker' && words[1] === 'typecheck')
    return words;
  const prefix = words[0] === 'checker' && words[1] === 'build' ? 2 : 1;
  if (prefix === 1 && words[0] !== 'build') return undefined;
  if (words.length === prefix) return prefix === 2 ? words : undefined;
  if (words.length !== prefix + 1) return undefined;
  const entry = words[prefix]!;
  const normalized = path.posix.normalize(entry);
  // No shell expansion, absolute paths, traversal, other entries, or flags.
  return !/^[a-z./]+$/iu.test(entry) ||
    path.posix.isAbsolute(entry) ||
    entry.split('/').includes('..') ||
    !['.', 'tsconfig.json'].includes(normalized === './' ? '.' : normalized)
    ? undefined
    : words;
}

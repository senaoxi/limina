import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const rules = [
  [
    'personal-path',
    /(?<![\w./-])\/(?:Users|home)\/[^/\s"'<>]+|(?<![\w.-])[a-z]:[\\/]Users[\\/][^\\/\s"'<>]+/iu,
  ],
  [
    'machine-path',
    /(?<![\w./-])\/(?:workspace|opt|tmp|private\/tmp|private\/var\/folders|var\/folders|home\/runner)\//u,
  ],
  ['local-file-link', /(?:file|vscode(?:-insiders)?|smb):\/\//iu],
  [
    'private-host',
    /\b[\w.-]{1,253}\.(?:local|internal|corp|lan)\b|\b(?:10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/iu,
  ],
  ['shell-identity', /\b[\w.-]+@[\w.-]+:(?:~|\/|[a-z]:)/iu],
  ['url-credentials', /[a-z][\w+.-]{0,31}:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@/iu],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u],
  [
    'credential-token',
    /\b(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[baprs]-[\w-]{20,}|AKIA[A-Z\d]{16}|sk-[\w-]{32,})\b/u,
  ],
  [
    'credential-assignment',
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*["'][\w/+.-]{20,}["']/iu,
  ],
] as const;

// Opt-in for PCR prose: ordinary product users, dates and task names remain valid.
const contextRules = [
  [
    'conversation-attribution',
    /\b(?:user|maintainer)\s+(?:(?:explicitly|additionally|then)\s+)?(?:requested|asked|clarified|stated)\b/iu,
  ],
  [
    'conversation-attribution',
    /(?:用户|维护者)(?:在|于)?\s*20\d{2}-\d{2}-\d{2}[^\n]{0,60}(?:要求|请求|提出|告知|选定|指定)|20\d{2}-\d{2}-\d{2}[\s，,]{0,6}(?:用户|维护者)[^\n]{0,12}(?:要求|请求|提出|告知|指定)/u,
  ],
  [
    'conversation-attribution',
    /^(?:Source|来源)\s*[:：][^\n]{0,60}(?:user's\s+(?:request|conversation|chat)|(?:用户|维护者)[^\n]{0,16}(?:请求|对话|会话|要求|提出))/imu,
  ],
  [
    'private-run-identifier',
    /\b(?:source_(?:thread|task)_id|(?:codex[_-])?(?:conversation|session|thread)[_-]?id)\s*[:=]\s*["']?[\w-]{8,}/iu,
  ],
] as const;

function decodeText(input: string): string {
  let text = input;
  for (let round = 0; round < 3; round++) {
    text = text
      .replaceAll(
        /\\u([\da-f]{4})|\\x([\da-f]{2})/giu,
        (_, unicode: string, hex: string) =>
          String.fromCodePoint(Number.parseInt(unicode ?? hex, 16)),
      )
      .replaceAll('\\\\', '\\')
      .replaceAll(String.raw`\/`, '/')
      .replaceAll(
        /&#(?:x([\da-f]+)|(\d+));/giu,
        (entity: string, hex: string, decimal: string) => {
          const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
          return value <= 0x10_ff_ff ? String.fromCodePoint(value) : entity;
        },
      )
      .replaceAll(
        /&(?:sol|bsol|colon);/gu,
        (entity) => ({ '&sol;': '/', '&bsol;': '\\', '&colon;': ':' })[entity]!,
      )
      .replaceAll(/(?:%[\da-f]{2})+/giu, (encoded) => {
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      });
  }
  return text;
}

// Locations/categories only: neither matches nor surrounding text are reported.
export function privacyIssues(
  input: string,
  shouldCheckContextRecords = false,
): { category: string; line: number }[] {
  const text = decodeText(input);
  const issues: { category: string; line: number }[] = [
    ...rules,
    ...(shouldCheckContextRecords ? contextRules : []),
  ].flatMap(([category, pattern]) =>
    text
      .matchAll(new RegExp(pattern.source, `${pattern.flags}g`))
      .map((match) => ({
        category,
        line: text.slice(0, match.index).split('\n').length,
      }))
      .toArray(),
  );
  for (const match of text.matchAll(
    /data:(?:application\/json|image\/svg\+xml|text\/[\w+-])[^,\s]*;base64,([\w+/=]+)/gu,
  )) {
    const embeddedIssues = privacyIssues(
      Buffer.from(match[1]!, 'base64').toString('utf8'),
      shouldCheckContextRecords,
    );
    for (const issue of embeddedIssues)
      issues.push({
        ...issue,
        line: text.slice(0, match.index).split('\n').length,
      });
  }
  return issues;
}

function pngMetadata(buffer: Buffer): string[] {
  if (
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return [];
  const metadata: string[] = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('Truncated PNG metadata');
    const data = buffer.subarray(offset + 8, end - 4);
    if (type === 'zTXt') {
      const start = data.indexOf(0) + 2;
      metadata.push(
        inflateSync(data.subarray(start), {
          maxOutputLength: 16 * 1024 * 1024,
        }).toString('utf8'),
      );
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      const languageEnd = data.indexOf(0, keywordEnd + 3);
      const translatedEnd = data.indexOf(0, languageEnd + 1);
      const content = data.subarray(translatedEnd + 1);
      metadata.push(
        (data[keywordEnd + 1] === 1
          ? inflateSync(content, { maxOutputLength: 16 * 1024 * 1024 })
          : content
        ).toString('utf8'),
      );
    }
    offset = end;
  }
  return metadata;
}

export async function scanDocumentation(
  root: string,
  excludes: readonly string[] = [],
  shouldCheckContextRecords = false,
): Promise<{
  files: number;
  issues: { file: string; category: string; line: number }[];
}> {
  let files = 0;
  const issues: { file: string; category: string; line: number }[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (
        excludes.some(
          (exclude) =>
            relative === exclude || relative.startsWith(`${exclude}/`),
        )
      )
        continue;
      const file =
        privacyIssues(relative, shouldCheckContextRecords).length > 0
          ? '[redacted file name]'
          : relative;
      if (entry.isSymbolicLink()) {
        issues.push({ file, category: 'symbolic-link', line: 1 });
      } else if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        files++;
        let buffer = await readFile(target);
        if (entry.name.endsWith('.gz'))
          buffer = gunzipSync(buffer, { maxOutputLength: 16 * 1024 * 1024 });
        if (entry.name.endsWith('.br'))
          buffer = brotliDecompressSync(buffer, {
            maxOutputLength: 16 * 1024 * 1024,
          });
        for (const text of [
          relative,
          buffer.toString('utf8'),
          ...pngMetadata(buffer),
        ])
          for (const issue of privacyIssues(text, shouldCheckContextRecords))
            issues.push({ file, ...issue });
      }
    }
  }
  await visit(root);
  return { files, issues };
}

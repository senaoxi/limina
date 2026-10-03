import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { privacyIssues } from './privacy';
import { publicTerminalChunks } from './public-terminal';
import { terminalFrames } from './terminal-frames';

it('refuses a public capture workspace and its filesystem alias before creating raw logs or local links', async () => {
  const script = fileURLToPath(
    new URL('capture-command-transcripts.ts', import.meta.url),
  );
  const publicRoot = fileURLToPath(
    new URL('../../docs/public/', import.meta.url),
  );
  const root = await mkdtemp(path.join(tmpdir(), 'limina-docs-capture-'));
  const alias = path.join(root, 'public');
  const name = `capture-fixture-${randomUUID()}`;
  const publicWorkspace = path.join(publicRoot, name);
  try {
    await symlink(
      publicRoot,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    for (const directory of [publicRoot, alias]) {
      const workspace = path.join(directory, name);
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), script, workspace],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /Capture workspace must be outside the documentation source tree/u,
      );
      assert.equal(existsSync(workspace), false);
    }
  } finally {
    await rm(publicWorkspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes runnable relative commands even when PTY reads split private paths', async () => {
  const workspace = '/Users/docs-fixture/projects/demo-workspace';
  const node = '/opt/node-fixture/bin/node';
  const cli = '/home/docs-fixture/repo/packages/limina/dist/bin/limina.js';
  const raw = `Ready\r\nQuery: ${node} ${cli} --config ${workspace}/limina.config.mjs\r\n`;
  const chunks = Array.from(
    { length: Math.ceil(raw.length / 7) },
    (_, index) => ({
      atMs: index * 25,
      text: raw.slice(index * 7, (index + 1) * 7),
    }),
  );
  const published = publicTerminalChunks(
    chunks,
    new Map([
      [node, 'node'],
      [cli, 'node_modules/limina/bin/limina.js'],
      [workspace, '.'],
    ]),
  );
  assert.equal(
    published.map((chunk) => chunk.text).join(''),
    'Ready\r\nQuery: node node_modules/limina/bin/limina.js --config ./limina.config.mjs\r\n',
  );
  const frames = await terminalFrames(published, 100, 20);
  assert.deepEqual(frames.at(-1)?.lines, [
    'Ready',
    'Query: node node_modules/limina/bin/limina.js --config ./limina.config.mjs',
  ]);
  assert.ok(frames.length > 1, 'recorded animation remains available');
  assert.deepEqual(privacyIssues(JSON.stringify(frames)), []);
});

it('detects privacy in metadata, encoded links, maps and credentials without treating public project identity as private', () => {
  const cases: [string, string][] = [
    ['/Users/docs-fixture/project', 'personal-path'],
    ['/home/docs-fixture/project', 'personal-path'],
    [String.raw`C:\Users\docs-fixture\project`, 'personal-path'],
    [
      JSON.stringify(String.raw`C:\Users\docs-fixture\project`),
      'personal-path',
    ],
    ['/workspace/build/docs', 'machine-path'],
    ['/private/var/folders/demo/build', 'machine-path'],
    ['file:///project/config.json', 'local-file-link'],
    ['vscode://file/project/config.json', 'local-file-link'],
    ['https://service.internal/project', 'private-host'],
    ['http://192.168.1.2/project', 'private-host'],
    ['http://10.1.2.3/project', 'private-host'],
    ['http://172.16.1.2/project', 'private-host'],
    ['demo@fixture-host:~/project $', 'shell-identity'],
    [
      'https://fixture-user:fixture-password@example.invalid/',
      'url-credentials',
    ],
    [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private-key'],
    ['ghp_' + 'x'.repeat(36), 'credential-token'],
    [`api_key="${'x'.repeat(24)}"`, 'credential-assignment'],
    [JSON.stringify({ apiKey: 'x'.repeat(24) }), 'credential-assignment'],
    ['%252FUsers%252Fdocs-fixture%252Fproject', 'personal-path'],
    [String.raw`\u002fUsers\u002fdocs-fixture\u002fproject`, 'personal-path'],
    ['&#47;Users&#47;docs-fixture&#47;project', 'personal-path'],
    [
      'data:application/json;base64,' +
        Buffer.from(
          JSON.stringify({ sources: ['/home/docs-fixture/source.ts'] }),
        ).toString('base64'),
      'personal-path',
    ],
  ];
  for (const [input, category] of cases)
    assert.ok(
      privacyIssues(input).some((issue) => issue.category === category),
      category,
    );
  assert.deepEqual(
    privacyIssues(
      'https://github.com/senaoxi/limina https://senao.me/repos/limina/ https://packages.example.com/ @repo/core packages/core/src/index.ts https://www.w3.org/2000/svg',
    ),
    [],
  );
});

it('fails the real scan command for nested public output and compressed PNG metadata while keeping diagnostics redacted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'limina-docs-privacy-'));
  const scan = () =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('check-privacy.ts', import.meta.url)),
        root,
      ],
      { encoding: 'utf8' },
    );
  const privatePath = '/Users/docs-fixture/private-project';
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(
      path.join(root, 'index.html'),
      '<a href="https://github.com/senaoxi/limina">Limina</a>',
    );
    assert.equal(scan().status, 0);
    await writeFile(
      path.join(root, 'assets/search.js'),
      JSON.stringify({ source: encodeURIComponent(privatePath) }),
    );
    const rejected = scan();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /assets\/search\.js:1 \[personal-path\]/u);
    assert.ok(
      !rejected.stderr.includes(privatePath) &&
        !rejected.stderr.includes('docs-fixture'),
    );
    await rm(path.join(root, 'assets/search.js'));
    const metadata = Buffer.concat([
      Buffer.from('Description\0\0'),
      deflateSync(Buffer.from(privatePath)),
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(metadata.length);
    // Only metadata parsing is exercised; pixel rendering is outside this guard.
    await writeFile(
      path.join(root, 'diagram.png'),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        length,
        Buffer.from('zTXt'),
        metadata,
        Buffer.alloc(4),
      ]),
    );
    const imageRejected = scan();
    assert.equal(imageRejected.status, 1);
    assert.match(imageRejected.stderr, /diagram\.png:1 \[personal-path\]/u);
    assert.ok(!imageRejected.stderr.includes('docs-fixture'));
    await rm(path.join(root, 'diagram.png'));
    assert.equal(scan().status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

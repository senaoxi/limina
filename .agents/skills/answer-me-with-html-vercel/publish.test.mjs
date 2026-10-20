import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish.mjs');
const page = (title, text) => '<!doctype html><html><head><title>' + title +
  '</title></head><body>' + text + '</body></html>';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'am-vercel-'));
  const home = path.join(base, 'home');
  const sources = path.join(base, 'sources');
  await mkdir(sources);
  return {
    base, home, sources,
    run(...args) {
      return spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        env: { ...process.env, AM_HOME: home },
      });
    },
    async write(name, html) {
      const filename = path.join(sources, name);
      await writeFile(filename, html);
      return filename;
    },
    async dispose() {
      await rm(base, { force: true, recursive: true });
    },
  };
}

test('selected pages accumulate, gallery escapes titles and never includes unrelated pages', async () => {
  const f = await fixture();
  try {
    const first = await f.write('first.html', page('Require & Bindings', 'first'));
    const second = await f.write('second.html', page('<script>unsafe</script>', 'second'));
    const third = await f.write('not-selected.html', page('Private draft', 'private'));
    assert.equal(f.run('stage', first, '--slug', 'require-bindings').status, 0);
    assert.equal(f.run('stage', second, '--slug', 'module-resolution').status, 0);
    const files = await readdir(path.join(f.home, 'vercel-shared-site', 'pages'));
    assert.deepEqual(files.sort(), ['module-resolution.html', 'require-bindings.html']);
    const index = await readFile(path.join(f.home, 'vercel-shared-site', 'index.html'), 'utf8');
    assert.match(index, /Require &amp; Bindings/);
    assert.match(index, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.doesNotMatch(index, /Private draft/);
    assert.equal(await readFile(path.join(f.home, 'vercel-shared-site', 'pages', 'require-bindings.html'), 'utf8'), page('Require & Bindings', 'first'));
    void third;
  } finally {
    await f.dispose();
  }
});

test('a changed existing slug requires --replace and preserves old bytes on rejection', async () => {
  const f = await fixture();
  try {
    const first = await f.write('first.html', page('First', 'before'));
    const second = await f.write('second.html', page('Second', 'after'));
    const pagePath = path.join(f.home, 'vercel-shared-site', 'pages', 'stable.html');
    assert.equal(f.run('stage', first, '--slug', 'stable').status, 0);
    const denied = f.run('stage', second, '--slug', 'stable');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /--replace/);
    assert.equal(await readFile(pagePath, 'utf8'), page('First', 'before'));
    assert.equal(f.run('stage', second, '--slug', 'stable', '--replace').status, 0);
    assert.equal(await readFile(pagePath, 'utf8'), page('Second', 'after'));
  } finally {
    await f.dispose();
  }
});

test('invalid traversal, non-HTML and missing slug cannot stage files', async () => {
  const f = await fixture();
  try {
    const first = await f.write('first.html', page('Safe', 'safe'));
    const other = await f.write('other.txt', 'secret');
    assert.notEqual(f.run('stage', first, '--slug', '../outside').status, 0);
    assert.notEqual(f.run('stage', first).status, 0);
    assert.notEqual(f.run('stage', other, '--slug', 'other').status, 0);
    const pages = path.join(f.home, 'vercel-shared-site', 'pages');
    await assert.rejects(readdir(pages), { code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});

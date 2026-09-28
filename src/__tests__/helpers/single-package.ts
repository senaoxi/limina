import { loadConfig } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixturePathResolver } from './path';

export async function createSinglePackageFixture(
  files: Record<string, string> = {},
) {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-single-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  const write = async (file: string, contents: string) => {
    await mkdir(path.dirname(fixturePath(file)), { recursive: true });
    await writeFile(fixturePath(file), contents);
  };
  for (const [file, contents] of Object.entries({
    'package.json': '{}',
    'limina.config.mjs': 'export default {};',
    ...files,
  }))
    await write(file, contents);
  return {
    rootDir: fixturePath(),
    path: fixturePath,
    write,
    load: (
      configPath = fixturePath('limina.config.mjs'),
      cwd = fixturePath(),
    ) => loadConfig({ configPath, cwd }),
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

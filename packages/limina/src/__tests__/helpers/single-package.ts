import { loadConfig } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixturePathResolver } from './path';

export async function createSinglePackageFixture(
  files: Record<string, string> = {},
) {
  const rootDirectoryTemporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-single-'),
  );
  const rootDirectory = await realpath(rootDirectoryTemporaryPath);
  const fixturePath = createFixturePathResolver(rootDirectory);
  const write = async (file: string, contents: string) => {
    await mkdir(path.dirname(fixturePath(file)), { recursive: true });
    await writeFile(fixturePath(file), contents);
  };
  const fixtureEntries1 = Object.entries({
    'package.json': '{}',
    'limina.config.mjs': 'export default {};',
    ...files,
  });
  for (const [file, contents] of fixtureEntries1) await write(file, contents);
  return {
    rootDir: fixturePath(),
    path: fixturePath,
    write,
    load: (
      configPath = fixturePath('limina.config.mjs'),
      cwd = fixturePath(),
    ) => loadConfig({ configPath, cwd }),
    cleanup: () => rm(rootDirectory, { recursive: true, force: true }),
  };
}

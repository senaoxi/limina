import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createFixturePathResolver } from './path';

export async function linkSemanticWorkspacePackages(
  root: string,
  packages: readonly string[],
): Promise<void> {
  const fixturePath = createFixturePathResolver(root);
  for (const name of packages) {
    const installed = fixturePath(`node_modules/@example/${name}`);
    await mkdir(path.dirname(installed), { recursive: true });
    await symlink(fixturePath(`packages/${name}`), installed, 'junction');
  }
}

export async function createSemanticRepairFixture(
  files: Record<string, string>,
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-semantic-repair-')),
  );
  const fixturePath = createFixturePathResolver(root);
  for (const [name, content] of Object.entries(files)) {
    const file = fixturePath(name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return {
    root,
    path: fixturePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
    parse: (name = 'tsconfig.json') => {
      const configPath = fixturePath(name);
      return ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(String(diagnostic.messageText));
          },
        },
      )!;
    },
  };
}

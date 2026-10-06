import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function installGatesFixture(root: string): void {
  const source = fileURLToPath(new URL('../packages/gates/', import.meta.url));
  const target = path.join(root, 'packages/gates');
  mkdirSync(target, { recursive: true });
  for (const file of ['src', 'dist', 'package.json']) {
    cpSync(path.join(source, file), path.join(target, file), {
      recursive: true,
    });
  }
  const manifest = JSON.parse(
    readFileSync(path.join(source, 'package.json'), 'utf8'),
  ) as {
    devDependencies: Record<string, string>;
  };
  for (const name of Object.keys(manifest.devDependencies)) {
    const destination = path.join(target, 'node_modules', name);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(
      realpathSync(path.join(source, 'node_modules', name)),
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const entry = path.join(root, 'node_modules/@limina/gates');
  mkdirSync(path.dirname(entry), { recursive: true });
  symlinkSync(target, entry, process.platform === 'win32' ? 'junction' : 'dir');
}

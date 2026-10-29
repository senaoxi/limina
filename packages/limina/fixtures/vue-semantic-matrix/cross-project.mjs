import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The existing one-config matrix cannot detect missing per-source option
// receipts. Exercise module and path-only requests across composite boundaries.
export function checkCrossProjectRequests(
  caseDirectory,
  liminaCli,
  temporaryParent = tmpdir(),
) {
  const root = mkdtempSync(path.join(temporaryParent, 'limina-vue-requests-'));
  const requireFromCase = createRequire(
    path.join(caseDirectory, 'package.json'),
  );
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  try {
    write('package.json', {
      name: 'vue-request-fixture',
      private: true,
      type: 'module',
    });
    for (const name of ['typescript', 'vue-tsc', 'vue']) {
      const target = path.dirname(
        requireFromCase.resolve(`${name}/package.json`),
      );
      mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      symlinkSync(target, path.join(root, 'node_modules', name), 'junction');
    }
    mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    const vueCli = path.join(
      path.dirname(requireFromCase.resolve('vue-tsc/package.json')),
      'bin/vue-tsc.js',
    );
    if (process.platform === 'win32')
      write(
        'node_modules/.bin/vue-tsc.cmd',
        `@"${process.execPath}" "${vueCli}" %*\r\n`,
      );
    else symlinkSync(vueCli, path.join(root, 'node_modules/.bin/vue-tsc'));
    write(
      'limina.config.mjs',
      `export default {scope:{source:{include:['*/**/*.ts','*/**/*.vue']},checkers:{'vue-tsc':{include:['*/tsconfig.json']}}}};`,
    );
    const options = {
      composite: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
      strict: true,
      rootDir: '.',
      outDir: 'dist',
    };
    for (const name of [
      'module',
      'path',
      'provider',
      'consumer',
      'declarations',
    ]) {
      write(`${name}/tsconfig.json`, {
        compilerOptions: options,
        include: ['*.ts', '*.vue'],
      });
    }
    write(
      'module/index.ts',
      'import { value } from "../provider/value"; export const result = value;',
    );
    write(
      'path/index.ts',
      '/// <reference path="../provider/global.ts" />\nexport const result: FixtureGlobal = { value: 1 };',
    );
    write('provider/value.ts', 'export const value = 1;');
    write('provider/global.ts', 'interface FixtureGlobal { value: number }');
    // Exercise the actual vue-tsc candidate adapter, including its declaration
    // output naming. A Language Service-only observation cannot prove this map.
    write(
      'consumer/App.vue',
      '<script setup lang="ts">import type { Model, Button } from "../declarations/api"; defineProps<{ model: Model; button: Button }>();</script>',
    );
    write(
      'declarations/api.d.ts',
      'export type Model = typeof import("../provider/value").value; export type Button = typeof import("./Button.vue").default;',
    );
    write(
      'declarations/Button.vue',
      '<script setup lang="ts">defineProps<{ label: string }>();</script>',
    );
    // TS 5.4 has no per-file options accessor and skips the resolver callback
    // for a type-only declaration under noResolve. The candidate must preserve
    // that suppression without inventing an unavailable request or graph edge.
    write('suppressed/tsconfig.json', {
      compilerOptions: { ...options, noResolve: true },
      files: ['api.d.ts', 'types.d.ts'],
    });
    write(
      'suppressed/api.d.ts',
      '/// <reference types="./types.d.ts" />\nexport interface Api {}',
    );
    write('suppressed/types.d.ts', 'export interface Model {}');
    const result = spawnSync(process.execPath, [liminaCli, 'check'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Vue cross-project module/path requests failed:\n${result.stdout}\n${result.stderr}`,
      );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

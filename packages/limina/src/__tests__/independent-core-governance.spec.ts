import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';
import { analyzeProjectDependencies } from '../core/build-graph/prepare';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';
const json = (value: unknown) => JSON.stringify(value);
const options = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  types: [],
  composite: true,
  ignoreDeprecations: '6.0',
};
const config = (files: string[]) => json({ compilerOptions: options, files });
function expectEqual(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
}
it.each([false, true])(
  'retains independent Vue relations when leaf governance is invalid=%s',
  async (invalid) => {
    const f = await createSemanticRepairFixture({
      'package.json': json({
        name: 'review-vue-workspace',
        type: 'module',
        private: true,
      }),
      'limina.config.mjs': 'export default {};',
      'tsconfig.json': json({
        files: [],
        references: [
          { path: './tsconfig.bad.json' },
          { path: './tsconfig.vue.json' },
          { path: './tsconfig.b.json' },
        ],
      }),
      'tsconfig.bad.json': json({
        compilerOptions: options,
        files: ['bad.ts'],
        ...(invalid && { references: [{ path: './tsconfig.b.json' }] }),
      }),
      'tsconfig.vue.json': config(['App.vue']),
      'tsconfig.b.json': config(['b.ts']),
      'bad.ts': 'export const bad=1;',
      'App.vue':
        '<script setup lang="ts">import {b} from "./b.js"; const value=b;</script><template>{{value}}</template>',
      'b.ts': 'export const b=1;',
    });
    try {
      const request = createRequire(
        new URL('../../package.json', import.meta.url),
      );
      await mkdir(f.path('node_modules'), { recursive: true });
      await symlink(
        path.dirname(request.resolve('vue-tsc/package.json')),
        f.path('node_modules/vue-tsc'),
        'junction',
      );
      const config = withFixtureGovernanceRoot({
        configPath: f.path('limina.config.mjs'),
        rootDir: f.root,
      });
      const analysis = await analyzeProjectDependencies(config, {
        artifactNamespace: createLiminaArtifactNamespace({
          generation: 0,
          rootDir: f.root,
        }),
      });
      expectEqual(
        analysis.facts.some(
          (v) =>
            v.fromConfigPath === f.path('tsconfig.vue.json') &&
            v.toConfigPath === f.path('tsconfig.b.json'),
        ),
        true,
      );
      expectEqual(analysis.outcome?.execution, 'completed');
      if (invalid)
        expectEqual(analysis.outcome?.graphTransaction.state, 'blocked');
    } finally {
      await f.cleanup();
    }
  },
);

it.each(['direct', 'solution', 'same-family'] as const)(
  'keeps independent work when explicit authority conflicts through %s',
  async (mode) => {
    const entry =
      mode === 'solution' ? 'solution/tsconfig.json' : 'bad/tsconfig.json';
    const second = mode === 'same-family' ? 'tsgo' : 'vue-tsc';
    const f = await createSemanticRepairFixture({
      'package.json': json({
        name: 'authority-fixture',
        type: 'module',
        private: true,
      }),
      'limina.config.mjs': 'export default {};',
      'bad/tsconfig.json': config(['bad.ts']),
      'tsconfig.json': json({
        files: [],
        references: [
          { path: './solution/tsconfig.json' },
          { path: './healthy/tsconfig.json' },
          { path: './b/tsconfig.json' },
        ],
      }),
      'healthy/tsconfig.json': config(['healthy.ts']),
      'b/tsconfig.json': config(['b.ts']),
      'solution/tsconfig.json': json({
        files: [],
        references: [{ path: '../bad/tsconfig.json' }],
      }),
      'bad/bad.ts': 'export const bad=1;',
      'healthy/healthy.ts':
        'import {b} from "../b/b.js"; export const healthy=b;',
      'b/b.ts': 'export const b=1;',
    });
    try {
      const input = withFixtureGovernanceRoot({
        configPath: f.path('limina.config.mjs'),
        rootDir: f.root,
        scope: {
          checkers: {
            tsc: {
              include: [entry, 'healthy/tsconfig.json', 'b/tsconfig.json'],
            },
            [second]: { include: [entry] },
          },
        },
      });
      const analysis = await analyzeProjectDependencies(input, {
        artifactNamespace: createLiminaArtifactNamespace({
          rootDir: f.root,
          generation: 0,
        }),
      });
      const work = analysis.outcome!.core.entries.find(
        (item) =>
          item.phase === 'locked' &&
          item.configPath === f.path('bad/tsconfig.json'),
      )!;
      expect(work, JSON.stringify(analysis)).toBeDefined();
      expectEqual(
        work.eligibility,
        mode === 'same-family' ? 'eligible' : 'unavailable',
      );
      expectEqual(
        work.execution,
        mode === 'same-family' ? 'completed' : 'not-run',
      );
      expectEqual(analysis.outcome!.execution, 'completed');
      expectEqual(analysis.outcome!.core.executionFailureIds, []);
      expectEqual(analysis.outcome!.governance.state, 'violations');
      expectEqual(analysis.outcome!.buildAdmission.state, 'denied');
      expectEqual(
        analysis.facts.some(
          (fact) =>
            fact.fromConfigPath === f.path('healthy/tsconfig.json') &&
            fact.toConfigPath === f.path('b/tsconfig.json'),
        ),
        true,
      );
    } finally {
      await f.cleanup();
    }
  },
);

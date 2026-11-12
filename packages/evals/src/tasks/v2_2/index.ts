import { fileURLToPath } from 'node:url';
import type {
  CalibrationCase,
  TaskDefinition,
} from '../../controller/calibration.ts';
import { gradeInitialization } from '../../graders/v2_2/I01.ts';
import { gradeCheckerRouting } from '../../graders/v2_2/K01.ts';
import { gradeMissingPeer } from '../../graders/v2_2/K03.ts';
import { gradePackageExports } from '../../graders/v2_2/P01.ts';
import { gradeDeclarationConditions } from '../../graders/v2_2/R02.ts';
import { gradePublicEntry } from '../../graders/v2_2/S02.ts';
import { gradeOutputWorkflow } from '../../graders/v2_2/W02.ts';
import { availableV21DevelopmentTasks } from '../v2_1/index.ts';

const graders: Record<string, TaskDefinition['grade']> = {
  I01: gradeInitialization,
  K01: gradeCheckerRouting,
  K03: gradeMissingPeer,
  P01: gradePackageExports,
  R02: gradeDeclarationConditions,
  S02: gradePublicEntry,
  W02: gradeOutputWorkflow,
};
const addedAssertions: Record<string, string[]> = {
  I01: ['workflow-runs', 'workflow-detects-error'],
  K01: ['checker-build-passes'],
  P01: ['explicit-root-conditions', 'explicit-type-consumption'],
  R02: ['checker-declaration-diagnostic'],
  S02: ['public-type-consumption', 'public-type-error'],
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const script = (
  edits: CalibrationCase['edits'],
  name: string,
  value: string,
) => {
  const edit = edits.find((entry) => entry.path === 'package.json')!;
  const manifest = JSON.parse(edit.content!);
  manifest.scripts[name] = value;
  edit.content = json(manifest);
};

/**
Earlier editions remain unchanged; a bank still requires all nine private tasks.
*/
export function createV22Definition(
  original: TaskDefinition,
  prompt?: string,
): TaskDefinition {
  const isDevelopment = availableV21DevelopmentTasks.some(
    (task) => task.id === original.id,
  );
  const definition: TaskDefinition = {
    ...original,
    files: { ...original.files },
    sourceFiles: [
      ...original.sourceFiles,
      ...(isDevelopment ? [fileURLToPath(import.meta.url)] : []),
    ],
    graderFiles: [...original.graderFiles],
    cases: structuredClone(original.cases),
    createTask(fixture, identities) {
      const task = original.createTask(fixture, identities);
      const result = {
        ...task,
        bankRevision: 'v2.2' as const,
        prompt: prompt ?? task.prompt,
      };
      if (isDevelopment) {
        result.gradingContract = {
          ...task.gradingContract,
          requiredAssertions: [
            ...task.gradingContract.requiredAssertions.filter(
              (id) =>
                (task.id !== 'K01' ||
                  !['checker-ownership', 'both-checkers-pass'].includes(id)) &&
                (task.id !== 'S02' || id !== 'public-static-import') &&
                (task.id !== 'P01' || id !== 'built-export-targets'),
            ),
            ...(addedAssertions[task.id] ?? []),
          ],
        };
        // Scratch permission was already excluded by every capture policy. Make it
        // visible to the solver without authorizing dependency or deliverable edits.
        result.prompt +=
          ' Temporary investigation files may be created and removed under .eval-tmp/; they are not deliverables and installation remains unauthorized.';
        if (task.capturePolicy.excludedRoots.includes('.limina'))
          result.prompt +=
            ' Installed checks may generate temporary .limina cache state.';
        switch (task.id) {
          case 'W02': {
            result.prompt +=
              ' A positional tsconfig entry or equivalent relative root directory is allowed for either build command; quoting the entry is allowed. No flags, shell expansion, command separators or traversal outside the project are allowed.';
            break;
          }
          case 'I01': {
            result.prompt +=
              ' Deliver at least one package script that directly invokes a Limina check or checker command on one line, optionally prefixed by pnpm exec. A relative root tsconfig entry is allowed for checker build and --force is allowed for check. The delivered workflow itself must detect a real source type error. No shell chains or pre/post hooks on that workflow.';
            break;
          }
          case 'S01': {
            result.prompt =
              'Declare the production TypeScript import at its actual source owner, packages/app/package.json. Only dependencies.typescript in that app manifest may change, using the already installed version 6.0.3. Preserve the root development-tool declarations and every other manifest field, workspace input, source, compiler setting and governance rule. Root-only, redundant root and development-only declarations do not satisfy this production ownership contract. Demonstrate source governance and checker validity. No installation, lockfiles, hooks, exemptions, replacement tools, background jobs or subagents. Temporary investigation files may be created and removed under .eval-tmp/ and installed tools may generate .limina cache state; neither is a deliverable.';
            result.mutationPolicy = {
              protectedRoots: [
                ...task.mutationPolicy.protectedRoots,
                'package.json',
              ],
              rules: task.mutationPolicy.rules.filter(
                (rule) => rule.path !== 'package.json',
              ),
            };
            result.dependencyPolicy = {
              ...task.dependencyPolicy,
              variants: task.dependencyPolicy.variants.filter((variant) =>
                ['unchanged', 'owner-declaration'].includes(variant.id),
              ),
            };

            break;
          }
          case 'S02': {
            result.prompt +=
              ' Public imports, namespace imports and public re-exports are allowed when they preserve total(a: number, b: number): number and provider delegation.';
            break;
          }
          case 'K01': {
            result.prompt +=
              ' A single checker may cover both projects if actual ordinary TypeScript and Vue-template diagnostics are retained; distinct native and Vue checker ownership is not required.';
            break;
          }
          case 'K03': {
            result.prompt +=
              ' Equivalent relative directory spellings such as . and ./ are allowed; absolute paths and parent traversal are not.';
            break;
          }
          case 'P01': {
            result.prompt +=
              ' The root export may use a . subpath object or the equivalent top-level conditional exports object. Actual Node and TypeScript consumption must work.';
            // No default
            break;
          }
        }
      }
      return result;
    },
  };
  if (!isDevelopment) return definition;
  const grade = graders[original.id];
  if (grade) {
    definition.grade = grade;
    definition.graderFiles.push(
      fileURLToPath(
        new URL(`../../graders/v2_2/${original.id}.ts`, import.meta.url),
      ),
    );
    if (['I01', 'W02'].includes(original.id))
      definition.graderFiles.push(
        fileURLToPath(
          new URL('../../graders/v2_2/workflow-command.ts', import.meta.url),
        ),
      );
  }
  const positive = original.cases.find((entry) => entry.expected === 'passed');
  if (!positive)
    throw new Error('Versioned tasks require a positive calibration');
  const variant = (
    id: string,
    expected: CalibrationCase['expected'],
    edit: (edits: CalibrationCase['edits']) => void,
    assertions?: string[],
  ) => {
    const entry: CalibrationCase = {
      id,
      expected,
      edits: structuredClone(positive.edits),
      ...(assertions && { expectedFailedAssertions: assertions }),
    };
    edit(entry.edits);
    definition.cases.push(entry);
  };
  switch (original.id) {
    case 'W02': {
      for (const [id, value] of [
        ['explicit-checker-entry', 'limina checker build tsconfig.json'],
        [
          'quoted-relative-checker-entry',
          'pnpm exec limina checker build "./tsconfig.json"',
        ],
        ['directory-checker-entry', 'limina checker build .'],
      ])
        variant(id!, 'passed', (edits) => script(edits, 'check:types', value!));
      variant('directory-output-entry', 'passed', (edits) =>
        script(edits, 'build', 'limina build ./'),
      );
      for (const [id, name, value] of [
        [
          'internal-command-as-user-build',
          'build',
          'limina checker build tsconfig.json',
        ],
        [
          'user-command-as-internal-build',
          'check:types',
          'limina build tsconfig.json',
        ],
        [
          'shell-chain',
          'build',
          'limina build tsconfig.json && node clean.mjs',
        ],
        [
          'unauthorized-force-flag',
          'check:types',
          'limina checker build --force',
        ],
        ['wrong-clean-entry', 'clean', 'node src/index.ts'],
        ['concatenated-quoted-command', 'check:types', '"limina"checker build'],
      ])
        variant(id!, 'failed', (edits) => script(edits, name!, value!), [
          'workflow-roles',
        ]);
      break;
    }
    case 'I01': {
      const manifest = JSON.parse(
        positive.edits.find((edit) => edit.path === 'package.json')!.content!,
      );
      const name = Object.keys(manifest.scripts)[0]!;
      for (const [id, value] of [
        ['full-check-force', 'pnpm exec limina check --force'],
        ['explicit-checker-entry', 'limina checker build "./tsconfig.json"'],
      ])
        variant(id!, 'passed', (edits) => script(edits, name, value!));
      variant('additional-disabled-workflow', 'passed', (edits) => {
        const edit = edits.find((entry) => entry.path === 'package.json')!;
        const value = JSON.parse(edit.content!);
        value.scripts = {
          optional: 'limina checker typecheck',
          ...value.scripts,
        };
        edit.content = json(value);
      });
      variant(
        'disabled-typescript-workflow',
        'failed',
        (edits) => script(edits, name, 'limina checker typecheck'),
        ['workflow-detects-error'],
      );
      variant(
        'shell-fake-workflow',
        'failed',
        (edits) => script(edits, name, 'limina check || true'),
        ['workflow-created'],
      );
      break;
    }
    case 'S01': {
      for (const entry of definition.cases)
        if (['wrong-owner', 'redundant-root-dependency'].includes(entry.id)) {
          entry.expected = 'unsafe';
          entry.expectedViolationCodes = ['protected'];
        }
      break;
    }
    case 'S02': {
      for (const [id, content] of [
        ['public-re-export', "export { add as total } from '@eval/math';\n"],
        [
          'public-dynamic-import',
          "export const total = (await import('@eval/math')).add;\n",
        ],
        [
          'namespace-delegation',
          "import * as math from '@eval/math';\nexport const total = (a: number, b: number): number => math.add(a,b);\n",
        ],
        [
          'overloaded-public-delegation',
          "import {add} from '@eval/math';\nexport function total(a: 1, b: 2): number;\nexport function total(a: number, b: number): number;\nexport function total(a: number, b: number): number {return add(a,b);}\n",
        ],
      ])
        variant(id!, 'passed', (edits) => {
          edits[0]!.content = content!;
        });
      for (const [id, signature, assertion] of [
        [
          'narrow-public-api',
          '(a: 2, b: 3): number',
          'public-type-consumption',
        ],
        [
          'wide-public-return',
          '(a: number, b: number): number | undefined',
          'public-type-consumption',
        ],
        [
          'unchecked-public-api',
          '(a: any, b: any): number',
          'public-type-error',
        ],
        [
          'unchecked-public-return',
          '(a: number, b: number): any',
          'public-type-error',
        ],
      ])
        variant(
          id!,
          'failed',
          (edits) => {
            edits[0]!.content = `import {add} from '@eval/math';\nexport const total = ${signature} => add(a,b);\n`;
          },
          [assertion!],
        );
      break;
    }
    case 'K01': {
      variant('root-vue-checker', 'passed', (edits) => {
        edits[0]!.content = `export default {scope:{source:{include:['node/**/*.ts','ui/**/*.ts','ui/**/*.vue']},checkers:{auto:{exclude:['**/tsconfig.json']},'vue-tsc':{include:['tsconfig.json']}}}};\n`;
      });
      break;
    }
    case 'K03': {
      for (const [id, scope, expected] of [
        ['relative-root-alias', './', 'passed'],
        ['wrong-package-owner', 'src', 'failed'],
        ['parent-traversal', '../workspace', 'failed'],
      ] as const)
        variant(
          id,
          expected,
          (edits) => {
            const edit = edits.find(
              (value) => value.path === 'diagnosis.json',
            )!;
            edit.content = json({ ...JSON.parse(edit.content!), scope });
          },
          expected === 'failed' ? ['missing-peer-diagnosed'] : undefined,
        );
      break;
    }
    case 'P01': {
      variant('root-conditional-exports', 'passed', (edits) => {
        for (const edit of edits)
          if (edit.path.endsWith('package.json')) {
            const manifest = JSON.parse(edit.content!);
            manifest.exports = manifest.exports['.'];
            edit.content = json(manifest);
          }
      });
      variant('nested-import-condition', 'passed', (edits) => {
        for (const edit of edits)
          if (edit.path.endsWith('package.json')) {
            const manifest = JSON.parse(edit.content!);
            const entry = manifest.exports['.'];
            entry.import = { default: entry.import };
            edit.content = json(manifest);
          }
      });
      variant(
        'missing-explicit-type-condition',
        'failed',
        (edits) => {
          for (const edit of edits)
            if (edit.path.endsWith('package.json')) {
              const manifest = JSON.parse(edit.content!);
              delete manifest.exports['.'].types;
              edit.content = json(manifest);
            }
        },
        ['explicit-root-conditions'],
      );
      variant(
        'missing-types-target-fresh-output',
        'failed',
        (edits) => {
          for (const edit of edits)
            if (edit.path.endsWith('package.json')) {
              const manifest = JSON.parse(edit.content!);
              manifest.exports['.'].types = './index.d.ts';
              edit.content = json(manifest);
            }
        },
        ['explicit-type-consumption'],
      );
      break;
    }
    case 'R02': {
      variant('irrelevant-custom-condition', 'passed', (edits) => {
        const edit = edits.find(
          (value) => value.path === 'tsconfig.consumer.json',
        )!;
        const config = JSON.parse(edit.content!);
        config.compilerOptions.customConditions = ['compatibility'];
        edit.content = json(config);
      });
      break;
    }
  }
  return definition;
}

export const availableV22DevelopmentTasks = availableV21DevelopmentTasks.map(
  (task) => createV22Definition(task),
);

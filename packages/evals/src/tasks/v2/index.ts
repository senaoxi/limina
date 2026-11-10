import { fileURLToPath } from 'node:url';
import type { TaskDefinition } from '../../controller/calibration.ts';
import { gradeTypescriptApi } from '../../graders/v2/N01.ts';
import { availableDevelopmentTasks } from '../index.ts';

// Permissions and observable deliverables stay explicit. Answers and investigation routes do not.
const prompts: Record<string, string> = {
  I01: 'Integrate Limina into this single-package TypeScript project and its existing package workflow. A full project check must succeed and still detect real TypeScript errors. Preserve all source bytes, dependencies, strict checking and production coverage. You may add a data-only Limina configuration and .gitignore, update package scripts, and adjust TypeScript source membership and ambient type selection. No functions or executable setup in configuration, diagnostic suppression, installation, replacement tools, background jobs or subagents. Deliver the working integration and run the installed project workflow.',
  I03: 'Determine whether the requested initialization from nested/app is safe in this workspace. Inspect the actual local boundaries. Only diagnosis.json may be added: status (blocked or ready), target (workspace-relative directory), nearestManifest (workspace-relative path), reason (invalid_manifest, missing_manifest, outside_workspace or ready). Preserve all existing files. Repairing manifests, initializing other locations, installation, tool replacement, background jobs and subagents are unauthorized. Deliver a decision supported by the current project state.',
  C01: 'The runtime project is intended to obey the existing central dependency policy, but the observed check does not enforce it. Diagnose the configuration ownership and activate the existing policy for the intended project. Only project-local graph-rule bindings in the allowed app tsconfig files may change. Preserve central rules, every source file and declared project reference. The prohibited relation must remain visible and be rejected, while unrelated relations remain allowed. No exclusions, weakened policy, dependency changes, installation, replacement tools, background jobs or subagents.',
  C02: 'Repair the checker entry configuration so the root solution checks the client and API production and test environments. Preserve all four leaf compiler configurations, strictness, sources and nested solution layers. You may change the checker entry selector in limina.settings.json, root solution references, and rename the API solution configuration. Deliver one unambiguous solution wiring and demonstrate coverage. Do not flatten projects, change ownership or dependencies, install tools, suppress errors, create background jobs or use subagents.',
  R02: 'Restore the compatibility consumer against the library release already delivered in dist. Local development and delivered release APIs are both present. Only consumer export-condition selection in tsconfig.consumer.json may change. Preserve all source and built bytes, compiler strictness, solution membership and governance. Do not rebuild the release, change dependencies or introduce project references as a workaround. Demonstrate both checking and runtime compatibility using the prepared tools. No installation, background jobs or subagents.',
  R03: 'Restore complete checker coverage through the selected root solution. The direct-entry exclusion policy is intentional and must remain. Only root solution references may change; retain all existing members, leaf compiler options, source bytes and coverage. Demonstrate that errors in every intended leaf are detected. Do not change exclusions, configuration policy, dependencies or tools. No installation, background jobs or subagents.',
  K01: 'The current checker configuration does not provide the required ordinary TypeScript and Vue template coverage. Diagnose ownership from the existing solution and restore it using only the data-only limina.config.mjs. Preserve sources, strictness, references, source coverage and discovery exclusions. A green result that omits an environment is insufficient. Dependencies are fixed; do not install, weaken checks, replace tools, create background jobs or use subagents.',
  K03: 'Determine whether this workspace can perform its required Vue checks using the prepared environment. Preserve all project files; installation, dependency edits, narrowing coverage and changing checker policy are unauthorized. Write diagnosis.json only: status (blocked or ready), dependency (required package), scope (workspace-relative owning package directory, . for root), action (request_install_authorization or none). Report the actual blocker and the authorized next step. Do not replace tools, create background jobs or use subagents.',
  S01: 'Restore authorized production dependency ownership for the existing workspace import. Only dependencies.typescript in the root or app manifest may change. Use the exact already-admitted installed version. Preserve root development-tool declarations, source, exports, compiler settings and governance. Do not add redundant production declarations, exemptions, install hooks, lockfiles or dependencies elsewhere. No installation, tool replacement, background jobs or subagents. Deliver the correct owning manifest and demonstrate source and checker validity.',
  S02: 'Restore the app package boundary while preserving total(a,b):number and its delegation to the provider public add API, including future provider behavior. Only packages/app/src/index.ts may change. Preserve all exports, dependency ownership, compiler settings and governance. Do not copy the provider implementation, use private entries or add exemptions. Use the prepared workspace links and tools; no installation, background jobs or subagents.',
  T01: 'The installed native Limina loader cannot check this CommonJS package. Existing consumers must continue to require runtime.js. Diagnose and repair the configuration loading boundary. Only the existing Limina configuration filename may change; preserve its exact bytes and leave a single native configuration. Package type, source, dependencies and tools are fixed. No custom loaders, execution flags, installation, background jobs or subagents. Demonstrate native loading and preserved CommonJS consumption.',
  T03: 'Investigate the failed current invocation alongside the retained .limina state and restore strict checking of exactly src/**/*.ts. Only the data-only limina.config.mjs, diagnosis.json and generated .limina state may change. Preserve source, compiler and package inputs. diagnosis.json must record initialRunSucceeded, retainedManifestProvesCurrentSuccess, cause (invalid-scope-source-include, stale-cache or missing-peer), repair (configuration, cache or dependencies), and rerun (graph-and-checker or manifest-only). Justify the current result using fresh observations. No installation, replacement tools, background jobs or subagents.',
  W02: 'Restore the three package workflows: check:types verifies internal declarations without delivering user dist, build delivers the configured user artifacts, and clean runs the protected clean.mjs through node. Each script must be a single-line direct invocation, optionally pnpm exec, without shell chains or extra flags; use limina for checking and building. Only these scripts and generated dist may change. Deliver artifacts consistent with a clean build and consumable by a separate TypeScript client. Preserve sources, compiler/output settings, cleaner and dependencies. No installation, replacement tools, background jobs or subagents.',
  W03: 'Assess the migration plan for this project using the installed CLI without applying it. Source repair, installation and migration writes are unauthorized. Write migration-report.json only: status (preview_complete or preview_incomplete), scope, create/update/isolated path arrays, migrationApplied, auditWritten, diskVerification (not_run or passed). Preserve every original input and base the report on the actual plan and observed state. No new migration artifacts, replacement tools, background jobs or subagents.',
  P01: 'Restore the library package boundary so separate ESM Node and TypeScript consumers can use its public API by package name after the existing build. Only source package.json exports and generated dist may change. Preserve the source API, generator, compiler, package checks and dependency-free distribution manifest. Deliver dist consistent with a fresh build; keep explicit types and import root conditions pointing to real files. No hand-patched artifacts, dependency changes, installation, replacement tools, background jobs or subagents.',
  P02: 'Make the delivered distribution consumable as an npm package while retaining both runtime dependencies. Only packages/app/dist/package.json dependencies may change. Resolve all nonpublishable dependency protocols from the frozen workspace inputs at their exact admitted versions. Source manifests, exports, JS, declarations, build tools and compiler settings must remain unchanged. Packing and separate Node/TypeScript consumption must work. Do not build, publish, install, download, remove dependencies, widen types, replace tools, create background jobs or use subagents.',
};
export function createV2Definition(
  original: TaskDefinition,
  prompt?: string,
): TaskDefinition {
  const self = fileURLToPath(import.meta.url);
  const definition: TaskDefinition = {
    ...original,
    files: { ...original.files },
    sourceFiles: [
      ...new Set([
        ...original.sourceFiles,
        ...(availableDevelopmentTasks.some((t) => t.id === original.id)
          ? [self]
          : []),
      ]),
    ],
    graderFiles: [...original.graderFiles],
    createTask(fixture, identities) {
      const task = original.createTask(fixture, identities);
      return { ...task, bankRevision: 'v2', prompt: prompt ?? task.prompt };
    },
    cases: structuredClone(original.cases),
  };
  switch (original.id) {
    case 'C01': {
      definition.files['limina.config.mts'] = definition.files[
        'limina.config.mts'
      ]!.replace(
        'rules: { runtime:',
        "rules: { tooling: { deny: { refs: [{ path: 'app/tsconfig.runtime.json', reason: 'Tooling must not consume runtime internals' }] } }, runtime:",
      );
      const baseCreate = definition.createTask;
      definition.createTask = (fixture, identities) => {
        const task = baseCreate(fixture, identities);
        task.mutationPolicy.protectedRoots =
          task.mutationPolicy.protectedRoots.filter(
            (root) => root !== 'app/tsconfig.node.json',
          );
        return task;
      };
      definition.cases.push({
        id: 'wrong-existing-rule',
        expected: 'failed',
        expectedFailedAssertions: ['rule-rejects-forbidden-reference'],
        edits: [
          {
            path: 'app/tsconfig.runtime.json',
            content: `${JSON.stringify({
              ...JSON.parse(definition.files['app/tsconfig.runtime.json']!),
              liminaOptions: { graphRules: ['tooling'] },
            })}\n`,
          },
        ],
      });
      // The Node leaf is a real referenced owner, not an unrelated distractor.
      const create = definition.createTask;
      definition.createTask = (fixture, identities) => {
        const task = create(fixture, identities);
        task.mutationPolicy.rules.push({
          path: 'app/tsconfig.node.json',
          operations: ['modify'],
          jsonFields: ['/liminaOptions/graphRules'],
        });
        return task;
      };

      break;
    }
    case 'C02': {
      definition.files['tsconfig.strict.json'] =
        `${JSON.stringify({ compilerOptions: { strict: true } })}\n`;
      for (const name of [
        'client/tsconfig.app.json',
        'client/tsconfig.test.json',
        'api/tsconfig.lib.json',
        'api/tsconfig.test.json',
      ]) {
        const config = JSON.parse(definition.files[name]!);
        delete config.compilerOptions.strict;
        config.extends = '../tsconfig.strict.json';
        definition.files[name] = `${JSON.stringify(config, null, 2)}\n`;
      }

      break;
    }
    case 'N01': {
      definition.grade = gradeTypescriptApi;
      definition.graderFiles.push(
        fileURLToPath(new URL('../../graders/v2/N01.ts', import.meta.url)),
      );
      const create = definition.createTask;
      definition.createTask = (fixture, identities) => {
        const task = create(fixture, identities);
        task.gradingContract.requiredAssertions.push('public-types-preserved');
        return task;
      };
      const source = original.cases
        .find((c) => c.expected === 'passed')!
        .edits.find((entry) => entry.path === 'src/greet.ts')!.content!;
      for (const [id, from, to] of [
        ['narrow-parameter', 'name: string', 'name: "Mira"'],
        ['wide-return', '): string', '): string | undefined'],
        [
          'required-extra-parameter',
          'name: string)',
          'name: string, extra: number)',
        ],
      ])
        definition.cases.push({
          id: id!,
          expected: 'failed',
          expectedFailedAssertions: ['public-types-preserved'],
          edits: [
            { path: 'src/greet.ts', content: source.replace(from!, () => to!) },
          ],
        });

      break;
    }
    // No default
  }
  return definition;
}
export const availableV2DevelopmentTasks = availableDevelopmentTasks.map((t) =>
  createV2Definition(t, prompts[t.id]),
);

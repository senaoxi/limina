import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type {
  DeclarationContextDecision,
  DeclarationContextReceipt,
} from '../../domain/analysis/declaration-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import { NativeObservationError } from '../typescript-semantic/native-observation-failure';
import { createNativeSemanticContext } from '../typescript-semantic/native-semantic-factory';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import { observeNativeReference } from '../typescript-semantic/reference-redirect';
import { createWorkspaceSourceBoundary } from '../typescript-semantic/workspace-source-boundary';
import { declarationFileKey } from './declaration-context-decisions';
import type { DependencyAnalysisResult } from './types';

export interface DeclarationValidationTarget {
  sourceConfig: string;
  generatedConfig: string;
  checker: string;
}
export interface DeclarationValidationInput {
  analysis: DependencyAnalysisResult;
  files: ReadonlyMap<string, string>;
  coverage?: SourceConfigCoverageIndex;
  targets: readonly DeclarationValidationTarget[];
  metrics?: AnalysisMetricsRecorder;
  phase?: 'generation' | 'restore';
}
interface CandidateProject extends DeclarationValidationTarget {
  parsed: ts.ParsedCommandLine;
}
class UnavailableDeclarationContext extends Error {}
class DeclarationContextConflict extends Error {}

/** One candidate pass, with unchanged roots. Its observations never become
 * source-analysis facts or new consumer edges. */
export function validateDeclarationContexts(
  input: DeclarationValidationInput,
): void {
  const decisions = input.analysis.declarationContexts ?? [];
  if (decisions.length === 0) return;
  const result: NonNullable<DependencyAnalysisResult['declarationValidation']> =
    {
      state: 'admitted',
      diagnostics: [],
      receipts: [],
    };
  input.analysis.declarationValidation = result;
  try {
    if (input.coverage === undefined)
      throw new UnavailableDeclarationContext(
        'Declaration Coverage is unavailable.',
      );
    const projects = readProjects(input);
    for (const project of projects.values()) {
      const closure = referenceClosure(project, projects);
      const applicable = decisions.filter(
        (decision) =>
          closure.some(
            (member) => member.sourceConfig === decision.consumerConfig,
          ) ||
          (decision.selection.state === 'selected' &&
            decision.selection.config === project.sourceConfig),
      );
      const localInputs = relevantDeclarationRoots(input, project, decisions);
      if (applicable.length === 0 && localInputs.length === 0) continue;
      const start = performance.now();
      try {
        result.receipts.push(
          validateProject(input, project, closure, applicable, localInputs),
        );
      } finally {
        input.metrics?.record({
          name: 'declaration-candidate',
          kind: input.phase ?? 'generation',
          count: 1,
          durationMs: performance.now() - start,
        });
      }
    }
    compareDelegatedRequests(result.receipts);
  } catch (error) {
    if (
      !(error instanceof UnavailableDeclarationContext) &&
      !(error instanceof DeclarationContextConflict)
    )
      throw error;
    result.state =
      error instanceof UnavailableDeclarationContext ? 'unavailable' : 'denied';
    result.diagnostics.push(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function readProjects(
  input: DeclarationValidationInput,
): Map<string, CandidateProject> {
  return new Map(
    input.targets.map((target) => {
      const system = observedCompilerSystem(ts, target.generatedConfig);
      const parsed = ts.getParsedCommandLineOfConfigFile(
        target.generatedConfig,
        {},
        {
          ...system,
          readFile: (file) =>
            input.files.get(normalizeAbsolutePath(file)) ??
            system.readFile(file),
          fileExists: (file) =>
            input.files.has(normalizeAbsolutePath(file)) ||
            system.fileExists(file),
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new DeclarationContextConflict(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            );
          },
        },
      );
      if (parsed === undefined || parsed.errors.length > 0)
        throw new DeclarationContextConflict(
          `Cannot parse declaration context candidate: ${target.generatedConfig}`,
        );
      return [target.generatedConfig, { ...target, parsed }];
    }),
  );
}

function referenceClosure(
  root: CandidateProject,
  projects: ReadonlyMap<string, CandidateProject>,
): CandidateProject[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const result: CandidateProject[] = [];
  const visit = (project: CandidateProject): void => {
    if (active.has(project.generatedConfig))
      throw new DeclarationContextConflict(
        `Declaration context reference cycle: ${project.generatedConfig}`,
      );
    if (visited.has(project.generatedConfig)) return;
    active.add(project.generatedConfig);
    result.push(project);
    const references = project.parsed.projectReferences ?? [];
    for (const reference of references) {
      const target = projects.get(
        normalizeAbsolutePath(ts.resolveProjectReferencePath(reference)),
      );
      if (target === undefined)
        throw new UnavailableDeclarationContext(
          `Unbound declaration context reference: ${reference.path}`,
        );
      visit(target);
    }
    active.delete(project.generatedConfig);
    visited.add(project.generatedConfig);
  };
  visit(root);
  return result;
}

function fileKey(input: DeclarationValidationInput, file: string): string {
  return declarationFileKey(
    observeNativeFileIdentity(file, input.coverage!.inputVersion),
  );
}
function relevantDeclarationRoots(
  input: DeclarationValidationInput,
  project: CandidateProject,
  decisions: readonly DeclarationContextDecision[],
): string[] {
  const consumed = new Set(
    decisions.map((decision) => declarationFileKey(decision.file)),
  );
  return project.parsed.fileNames.filter(
    (file) => isDeclarationFile(file) && consumed.has(fileKey(input, file)),
  );
}
function expectedContexts(
  input: DeclarationValidationInput,
  project: CandidateProject,
  closure: readonly CandidateProject[],
  decisions: readonly DeclarationContextDecision[],
  localInputs: readonly string[],
): Map<string, CandidateProject> {
  const expected = new Map<string, CandidateProject>();
  for (const decision of decisions) {
    const selection = decision.selection;
    if (selection.state !== 'selected' && selection.state !== 'local')
      throw new UnavailableDeclarationContext(
        `${decision.consumerConfig}: ${decision.file.lexicalPath}: ${selection.reason}`,
      );
    const owner = closure.find(
      (candidate) => candidate.sourceConfig === selection.config,
    );
    if (owner === undefined)
      throw new DeclarationContextConflict(
        `Missing declaration context provider: ${selection.config}`,
      );
    const previous = expected.get(decision.file.lexicalPath);
    if (
      previous !== undefined &&
      previous.generatedConfig !== owner.generatedConfig
    )
      throw new DeclarationContextConflict(
        `Conflicting declaration contexts: ${decision.file.lexicalPath}`,
      );
    expected.set(decision.file.lexicalPath, owner);
    checkOwner(owner, selection.state === 'selected');
  }
  // A root may be remapped by references even without an import in that root.
  for (const file of localInputs) expected.set(file, project);
  for (const [file, owner] of expected) {
    const key = fileKey(input, file);
    const providers = closure.filter(
      (candidate) =>
        candidate !== project &&
        candidate.parsed.fileNames.some(
          (member) => fileKey(input, member) === key,
        ),
    );
    if (
      providers.some(
        (candidate) => candidate.generatedConfig !== owner.generatedConfig,
      )
    )
      throw new DeclarationContextConflict(
        `Competing declaration input mappings for ${file}: ${providers.map((candidate) => candidate.sourceConfig).join(', ')}; selected ${owner.sourceConfig}.`,
      );
    if (
      owner.parsed.fileNames.every((member) => fileKey(input, member) !== key)
    )
      throw new DeclarationContextConflict(
        `Declaration is no longer an input of ${owner.sourceConfig}: ${file}`,
      );
  }
  return expected;
}

function checkOwner(owner: CandidateProject, isDelegated: boolean): void {
  if (owner.checker !== 'tsc')
    throw new UnavailableDeclarationContext(
      `Declaration context checking is not qualified for ${owner.checker}: ${owner.sourceConfig}`,
    );
  const options = owner.parsed.options;
  if (isDelegated && (options.skipLibCheck || options.noCheck))
    throw new DeclarationContextConflict(
      `Declaration context owner must check declarations (skipLibCheck/noCheck): ${owner.sourceConfig}`,
    );
  if (!options.composite || options.declaration === false || options.noEmit)
    throw new DeclarationContextConflict(
      `Invalid declaration context reference target: ${owner.generatedConfig}`,
    );
}

function validateProject(
  input: DeclarationValidationInput,
  project: CandidateProject,
  closure: readonly CandidateProject[],
  decisions: readonly DeclarationContextDecision[],
  localInputs: readonly string[],
): DeclarationContextReceipt {
  if (project.checker !== 'tsc')
    throw new UnavailableDeclarationContext(
      `Declaration context consumption is not qualified for ${project.checker}: ${project.sourceConfig}`,
    );
  const expected = expectedContexts(
    input,
    project,
    closure,
    decisions,
    localInputs,
  );
  const context = createNativeSemanticContext(
    {
      configPath: project.generatedConfig,
      fileNames: project.parsed.fileNames,
      options: project.parsed.options,
      projectReferences: project.parsed.projectReferences,
      virtualFiles: input.files,
      declarationContextValidation: {
        sourceConfig: project.sourceConfig,
        allowedDeclarations: expected.keys().toArray(),
      },
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        closure.flatMap((member) => member.parsed.fileNames),
        undefined,
        input.coverage,
      ),
    },
    undefined,
    input.metrics,
  );
  try {
    const failure = context.nativeEvidence!.failures[0];
    if (failure !== undefined)
      throw new NativeObservationError(failure.kind, failure.detail);
    if (context.nativeEvidence!.run !== 'completed')
      throw new UnavailableDeclarationContext(
        'Candidate declaration observation is incomplete.',
      );
    for (const decision of decisions) {
      if (
        decision.consumerConfig === project.sourceConfig &&
        context.getSourceFile(decision.file.lexicalPath) === undefined
      )
        throw new UnavailableDeclarationContext(
          `Selected declaration was not loaded: ${decision.file.lexicalPath}`,
        );
    }
    for (const decision of decisions) {
      if (
        decision.selection.state === 'selected' &&
        decision.selection.config === project.sourceConfig &&
        project.parsed.options.skipDefaultLibCheck &&
        context.getSourceFile(decision.file.lexicalPath)?.hasNoDefaultLib
      )
        throw new DeclarationContextConflict(
          `Declaration context owner skips this default library: ${decision.file.lexicalPath}`,
        );
    }
    const mappings = [...expected].map(([file, owner]) => {
      const observation = observeNativeReference(context.program, file, ts);
      if (
        observation.state === 'unavailable' ||
        !observation.canProveMissingReference
      )
        throw new UnavailableDeclarationContext(
          `TypeScript ${ts.version} cannot qualify declaration input mapping: ${file}`,
        );
      const actual = observation.referenceConfig ?? project.generatedConfig;
      if (actual !== owner.generatedConfig)
        throw new DeclarationContextConflict(
          `Declaration context mismatch: ${file}; selected ${owner.generatedConfig}, actual ${actual}.`,
        );
      return {
        file,
        sourceConfig: owner.sourceConfig,
        referenceConfig: actual,
        loaded: context.getSourceFile(file) !== undefined,
      };
    });
    return {
      version: 2,
      contextId: context.nativeEvidence!.contexts[0]!.id,
      ...projectIdentity(project),
      compilerVersion: ts.version,
      inputFingerprint: nativeFingerprint(
        closure.map((member) => [
          member.generatedConfig,
          effectiveCompilerOptions(member.parsed.options),
          member.parsed.fileNames,
          member.parsed.projectReferences,
        ]),
      ),
      decisionsFingerprint: nativeFingerprint(decisions),
      mappings,
      requests: observedDeclarationRequests(context.nativeEvidence!, expected),
    };
  } finally {
    context.dispose();
  }
}
function projectIdentity(
  project: CandidateProject,
): DeclarationValidationTarget {
  return {
    sourceConfig: project.sourceConfig,
    generatedConfig: project.generatedConfig,
    checker: project.checker,
  };
}

function observedDeclarationRequests(
  snapshot: NativeEvidenceSnapshot,
  expected: ReadonlyMap<string, CandidateProject>,
): DeclarationContextReceipt['requests'] {
  return snapshot.requests.flatMap((request) => {
    if (
      request.entry.kind !== 'source' ||
      !expected.has(request.entry.file.lexicalPath)
    )
      return [];
    if (
      snapshot.contexts.length !== 1 ||
      request.consumerContextId !== snapshot.contexts[0]!.id
    )
      throw new UnavailableDeclarationContext(
        `Unbound declaration request: ${request.specifier}`,
      );
    const resolution = snapshot.resolutions.find(
      (item) => item.requestId === request.id,
    );
    if (resolution === undefined || resolution.state === 'unavailable')
      throw new UnavailableDeclarationContext(
        `Unavailable declaration request: ${request.specifier}`,
      );
    return [
      {
        file: request.entry.file.lexicalPath,
        position: request.entry.position,
        channel: request.channel,
        specifier: request.specifier,
        mode: request.resolutionMode,
        target: resolution.target?.lexicalPath ?? null,
        resolutionState: resolution.state,
        redirects: resolution.rawRedirectEvidenceIds,
      },
    ];
  });
}
function compareDelegatedRequests(
  receipts: readonly DeclarationContextReceipt[],
): void {
  for (const receipt of receipts)
    for (const mapping of receipt.mappings) {
      if (
        !mapping.loaded ||
        mapping.referenceConfig === receipt.generatedConfig
      )
        continue;
      const owner = receipts.find(
        (candidate) => candidate.generatedConfig === mapping.referenceConfig,
      );
      if (owner === undefined)
        throw new UnavailableDeclarationContext(
          `Missing owner observation: ${mapping.referenceConfig}`,
        );
      const requests = (value: DeclarationContextReceipt) =>
        value.requests.filter((request) => request.file === mapping.file);
      const consumer = requests(receipt);
      const expected = requests(owner);
      const key = (request: DeclarationContextReceipt['requests'][number]) =>
        nativeFingerprint([
          request.position,
          request.channel,
          request.specifier,
          request.mode,
          request.resolutionState,
          request.target,
        ]);
      if (
        nativeFingerprint(consumer.map(key).sort(compareCodeUnits)) !==
        nativeFingerprint(expected.map(key).sort(compareCodeUnits))
      )
        throw new DeclarationContextConflict(
          `Declaration request context differs from its selected owner: ${mapping.file}`,
        );
      for (const request of consumer) {
        // The inventory's own-ambient proof is independent of a resolver
        // callback. A null target or an empty redirect alone proves nothing.
        if (
          request.resolutionState === 'ambient' &&
          request.channel === 'module'
        ) {
          if (
            request.target !== null ||
            request.redirects.some(
              (redirect) => redirect !== mapping.referenceConfig,
            )
          )
            throw new DeclarationContextConflict(
              `Conflicting ambient declaration context: ${mapping.file}`,
            );
          continue;
        }
        if (
          ['module', 'type-directive'].includes(request.channel) &&
          !request.redirects.includes(mapping.referenceConfig)
        )
          throw new DeclarationContextConflict(
            `Declaration request did not use the selected reference: ${mapping.file} -> ${request.specifier}`,
          );
      }
    }
}

import type { VueProjectSemanticIdentity } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import {
  createVueProjectSemanticIdentity,
  vueCompilerPathPolicy,
} from '../../checker/vue-semantic-identity';
import type {
  DeclarationContextDecision,
  DeclarationContextReceipt,
} from '../../domain/analysis/declaration-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import {
  declarationCandidateRequests,
  DeclarationObservationUnavailable,
} from '../declaration-governance/candidate';
import { observeNativeDeclarationCandidate } from '../declaration-governance/native-candidate';
import { createDeclarationValidationScope } from '../declaration-governance/validation-scope';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { compilerFileKey } from '../typescript-semantic/compiler-coverage';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import { observeVueDeclarationCandidate } from '../vue-semantic/declaration-candidate';
import {
  declarationPackageFiles,
  validateDeclarationPackageFormat,
} from './declaration-package-format';
import {
  implementationReferenceInputs,
  validateImplementationMappings,
} from './implementation-reference-mapping';
import {
  moduleProjectionInputs,
  validateModuleProjection,
} from './module-projection';
import type {
  DependencyAnalysisResult,
  GeneratedDependencyEdge,
} from './types';

export interface DeclarationValidationTarget {
  sourceConfig: string;
  generatedConfig: string;
  checker: string;
  executionRoot?: string;
  executionIdentity?: VueProjectSemanticIdentity;
  preset?: string;
}
export interface DeclarationValidationInput {
  analysis: DependencyAnalysisResult;
  dependencyEdges?: readonly GeneratedDependencyEdge[];
  files: ReadonlyMap<string, string>;
  coverage?: SourceConfigCoverageIndex;
  targets: readonly DeclarationValidationTarget[];
  metrics?: AnalysisMetricsRecorder;
  phase?: 'generation' | 'restore';
}
interface CandidateProject extends DeclarationValidationTarget {
  parsed: ts.ParsedCommandLine;
}
class UnavailableDeclarationContext extends DeclarationObservationUnavailable {}
class DeclarationContextConflict extends Error {}

/** One candidate pass, with unchanged roots. Its observations never become
 * source-analysis facts or new consumer edges. */
export function validateDeclarationContexts(
  input: DeclarationValidationInput,
): void {
  const decisions = input.analysis.declarationContexts ?? [];
  // Structural rejection already owns the diagnostic; a cyclic or unbound
  // candidate cannot yet support implementation mapping proof.
  const canObserveImplementations =
    input.analysis.referenceValidation === undefined ||
    input.analysis.referenceValidation.state === 'admitted';
  const referenceInputs = implementationReferenceInputs(
    canObserveImplementations ? (input.dependencyEdges ?? []) : [],
  );
  const moduleInputs = moduleProjectionInputs(input.analysis);
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
    const scope = createDeclarationValidationScope({
      decisions,
      evidence: input.analysis.declarationEvidence ?? [],
      fileKey: (file, config) => fileKey(input, file, config),
    });
    for (const project of projects.values()) {
      const packageFiles = declarationPackageFiles({
        ...project,
        files: input.files,
        compiler: project.executionIdentity?.toolchain.tsModule,
        vueProfiles: project.executionIdentity?.profilesByFileName,
      });
      for (const [file, content] of packageFiles)
        if (input.files.get(file) !== content)
          throw new UnavailableDeclarationContext(
            `Declaration package format projection changed: ${file}`,
          );
      validateModuleProjection({
        ...project,
        files: input.files,
        requests: moduleInputs.get(project.sourceConfig) ?? [],
      });
      const applicable = scope(project.sourceConfig);
      const localInputs = relevantDeclarationRoots(input, project, decisions);
      const implementations = referenceInputs.get(project.sourceConfig) ?? [];
      if (
        applicable.length === 0 &&
        localInputs.length === 0 &&
        implementations.length === 0
      )
        continue;
      const closure = referenceClosure(project, projects);
      const start = performance.now();
      try {
        result.receipts.push(
          validateProject(
            input,
            project,
            closure,
            applicable,
            localInputs,
            implementations,
          ),
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
    compareDelegatedRequests(input, result.receipts);
  } catch (error) {
    if (
      !(error instanceof DeclarationObservationUnavailable) &&
      !(error instanceof DeclarationContextConflict)
    )
      throw error;
    result.state =
      error instanceof DeclarationObservationUnavailable
        ? 'unavailable'
        : 'denied';
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
      if ((target.preset ?? target.checker) === 'vue-tsc') {
        const { parsed } = createVueProjectSemanticIdentity({
          configPath: target.generatedConfig,
          projectRootDir:
            target.executionRoot ?? path.dirname(target.sourceConfig),
          virtualFiles: input.files,
        });
        if (parsed.errors.length > 0)
          throw new DeclarationContextConflict(
            `Cannot parse Vue declaration context candidate: ${target.generatedConfig}`,
          );
        return [target.generatedConfig, { ...target, parsed }];
      }
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

function fileKey(
  input: DeclarationValidationInput,
  file: string,
  config: string,
): string {
  const identity = input.targets.find(
    (target) => target.sourceConfig === config,
  )?.executionIdentity;
  return identity === undefined
    ? compilerFileKey(file)
    : vueCompilerPathPolicy(identity).key(file);
}

function relevantDeclarationRoots(
  input: DeclarationValidationInput,
  project: CandidateProject,
  decisions: readonly DeclarationContextDecision[],
): string[] {
  const consumed = new Set(
    decisions.map((decision) =>
      fileKey(input, decision.file.lexicalPath, project.sourceConfig),
    ),
  );
  return project.parsed.fileNames.filter(
    (file) =>
      isDeclarationFile(file) &&
      consumed.has(fileKey(input, file, project.sourceConfig)),
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
  const direct = new Set(
    decisions
      .filter((decision) => decision.consumerConfig === project.sourceConfig)
      .map((decision) =>
        fileKey(input, decision.file.lexicalPath, project.sourceConfig),
      ),
  );
  for (const decision of decisions) {
    // A descendant's independent checking context does not override this
    // consumer's explicit/local selection for the same declaration input.
    if (
      decision.consumerConfig !== project.sourceConfig &&
      direct.has(
        fileKey(input, decision.file.lexicalPath, project.sourceConfig),
      )
    )
      continue;
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
    const previousEntry = [...expected].find(
      ([file]) =>
        fileKey(input, file, project.sourceConfig) ===
        fileKey(input, decision.file.lexicalPath, project.sourceConfig),
    );
    const previous = previousEntry?.[1];
    if (
      previous !== undefined &&
      previous.generatedConfig !== owner.generatedConfig
    )
      throw new DeclarationContextConflict(
        `Conflicting declaration contexts: ${decision.file.lexicalPath}`,
      );
    if (previousEntry !== undefined) expected.delete(previousEntry[0]);
    expected.set(decision.file.lexicalPath, owner);
    checkOwner(owner, selection.state === 'selected');
  }
  // A root may be remapped by references even without an import in that root.
  for (const file of localInputs) expected.set(file, project);
  for (const [file, owner] of expected) {
    const key = fileKey(input, file, project.sourceConfig);
    if (
      owner.parsed.fileNames.every(
        (member) => fileKey(input, member, project.sourceConfig) !== key,
      )
    )
      throw new DeclarationContextConflict(
        `Declaration is no longer an input of ${owner.sourceConfig}: ${file}`,
      );
  }
  return expected;
}

function checkOwner(owner: CandidateProject, isDelegated: boolean): void {
  if (!['tsc', 'vue-tsc'].includes(owner.preset ?? owner.checker))
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
  implementations: readonly { file: string; provider: string }[],
): DeclarationContextReceipt {
  const expected = expectedContexts(
    input,
    project,
    closure,
    decisions,
    localInputs,
  );
  const observe =
    (project.preset ?? project.checker) === 'tsc' ||
    ((project.preset ?? project.checker) === 'tsgo' && expected.size === 0)
      ? observeNativeDeclarationCandidate
      : (project.preset ?? project.checker) === 'vue-tsc'
        ? observeVueDeclarationCandidate
        : undefined;
  if (observe === undefined)
    throw new UnavailableDeclarationContext(
      `Declaration context consumption is not qualified for ${project.checker}: ${project.sourceConfig}`,
    );
  const observation = observe({
    ...project,
    files: input.files,
    coverage: input.coverage!,
    roots: closure.flatMap((member) => member.parsed.fileNames),
    configs: closure.map((member) => member.generatedConfig),
    declarations: expected.keys().toArray(),
    referenceInputs: implementations.map((item) => item.file),
    referenceProjects: closure,
    requiresDelegationProof: decisions.some(
      (decision) => decision.selection.state === 'selected',
    ),
    metrics: input.metrics,
  });
  validateImplementationMappings(implementations, closure, observation);
  for (const mapping of observation.mappings) {
    if (
      !mapping.qualified ||
      mapping.declarationOutput === null ||
      isDeclarationFile(mapping.file)
    )
      continue;
    const provider = closure.find(
      (member) => member.generatedConfig === mapping.referenceConfig,
    );
    if (provider === undefined || !provider.parsed.options.emitDeclarationOnly)
      continue;
    validateDeclarationPackageFormat({
      sourceConfig: provider.sourceConfig,
      sourceFile: mapping.file,
      outputFile: mapping.declarationOutput,
      files: input.files,
      compiler: provider.executionIdentity?.toolchain.tsModule,
      vueProfiles: provider.executionIdentity?.profilesByFileName,
    });
  }
  const sources = new Map(
    observation.sources.map((source) => [
      fileKey(input, source.file, project.sourceConfig),
      source,
    ]),
  );
  for (const decision of decisions) {
    if (
      decision.consumerConfig === project.sourceConfig &&
      !sources.has(
        fileKey(input, decision.file.lexicalPath, project.sourceConfig),
      )
    )
      throw new UnavailableDeclarationContext(
        `Selected declaration was not loaded: ${decision.file.lexicalPath}`,
      );
    if (
      decision.selection.state === 'selected' &&
      decision.selection.config === project.sourceConfig &&
      project.parsed.options.skipDefaultLibCheck &&
      sources.get(
        fileKey(input, decision.file.lexicalPath, project.sourceConfig),
      )?.defaultLibrary
    )
      throw new DeclarationContextConflict(
        `Declaration context owner skips this default library: ${decision.file.lexicalPath}`,
      );
  }
  const mappings = [...expected].map(([file, owner]) => {
    const mapping = observation.mappings.find(
      (item) =>
        fileKey(input, item.file, project.sourceConfig) ===
        fileKey(input, file, project.sourceConfig),
    );
    if (!mapping?.qualified)
      throw new UnavailableDeclarationContext(
        `Checker cannot qualify declaration input mapping: ${file}`,
      );
    const actual = mapping.referenceConfig ?? project.generatedConfig;
    if (actual !== owner.generatedConfig)
      throw new DeclarationContextConflict(
        `Declaration context mismatch: ${file}; selected ${owner.generatedConfig}, actual ${actual}.`,
      );
    return {
      file,
      sourceConfig: owner.sourceConfig,
      referenceConfig: actual,
      loaded: sources.has(fileKey(input, file, project.sourceConfig)),
    };
  });
  return {
    version: 3,
    authority: observation.authority,
    contextId: observation.contextId,
    ...projectIdentity(project),
    compilerVersion: observation.compilerVersion,
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
    referenceMappings: observation.mappings,
    requests: observation.requests,
  };
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

function compareDelegatedRequests(
  input: DeclarationValidationInput,
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
      // Compare each observation under its own Checker/Host policy. Keep
      // original spellings in the receipts, including transitive requests.
      const consumerKey = (file: string) =>
        fileKey(input, file, receipt.sourceConfig);
      const ownerKey = (file: string) =>
        fileKey(input, file, owner.sourceConfig);
      const consumer = declarationCandidateRequests(
        [mapping.file],
        receipt.requests,
        consumerKey,
      );
      const expected = declarationCandidateRequests(
        [mapping.file],
        owner.requests,
        ownerKey,
      );
      const key =
        (pathKey: (file: string) => string) =>
        (request: DeclarationContextReceipt['requests'][number]) =>
          nativeFingerprint([
            pathKey(request.file),
            request.position,
            request.channel,
            request.specifier,
            request.mode,
            request.resolutionState,
            request.target === null ? null : pathKey(request.target),
            declarationInputPermissions(request.environment),
            request.externalLibrary,
          ]);
      if (
        nativeFingerprint(
          consumer.map(key(consumerKey)).sort(compareCodeUnits),
        ) !==
        nativeFingerprint(expected.map(key(ownerKey)).sort(compareCodeUnits))
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
          consumerKey(request.file) === consumerKey(mapping.file) &&
          ['module', 'type-directive'].includes(request.channel) &&
          !request.redirects.includes(mapping.referenceConfig)
        )
          throw new DeclarationContextConflict(
            `Declaration request did not use the selected reference: ${mapping.file} -> ${request.specifier}`,
          );
      }
    }
}

/** Compare independently observed outcomes, not the spelling of configuration
 * addresses. paths/conditions and mode are exercised by each real resolver;
 * rootDir/outDir/configFilePath need not be equal across consumers. Retain raw
 * environments in the receipt and bind them to candidate/input fingerprints.
 * Input suppression is independent of a successful resolution. */
function declarationInputPermissions(
  options: Readonly<Record<string, unknown>>,
) {
  return [
    Boolean(options.noResolve),
    Boolean(options.allowJs ?? options.checkJs),
    Boolean(options.noEmitForJsFiles),
  ];
}

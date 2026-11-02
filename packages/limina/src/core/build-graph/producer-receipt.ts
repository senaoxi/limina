import { isBuildCapablePreset } from '#checkers';
import { readAnalysisInput } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import { graphExecutionInputScope } from '../analysis-cache/execution-inputs';
import { vueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import { parseTypeScriptProjectConfig } from '../typescript-semantic/project-references';
import { observeNativeReferenceMapping } from '../typescript-semantic/reference-redirect';
import { withVirtualResolutionFiles } from '../typescript-semantic/virtual-resolution-host';
import { observeVueDeclarationCandidate } from '../vue-semantic/declaration-candidate';
import type { PreparedTsconfigGraph, ProducerBuildPlan } from './types';

export interface ProducerDeclaration {
  checker: string;
  sourceConfig: string;
  generatedConfig: string;
  sourceFile: string;
  outputFile: string;
  content: string;
  contentIdentity: string;
}

export type ProducerOutputMapping = Omit<
  ProducerDeclaration,
  'content' | 'contentIdentity'
>;

export interface ProducerBuildInputs {
  readonly semantics: string;
  readonly ownership: string;
  readonly inputs: ReadonlyMap<string, string>;
}

/**
Invocation-local evidence; a persisted manifest cannot mint this receipt.
*/
export interface ProducerBuildReceipt extends ProducerBuildInputs {
  readonly identity: string;
  readonly plan: ProducerBuildPlan;
  readonly declarations: readonly ProducerDeclaration[];
}

const issued = new WeakMap<ProducerBuildReceipt, string>();
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function content(file: string): string {
  return readAnalysisInput(file, () => readFileSync(file, 'utf8'));
}

export function producerSemantics(graph: PreparedTsconfigGraph): string {
  const units = graph.governedSources
    .values()
    .flatMap((group) => group.values())
    .filter((unit) => isBuildCapablePreset(unit.primaryCheckerName))
    .toArray()
    .sort((a, b) => a.configPath.localeCompare(b.configPath));
  return hash(
    JSON.stringify(
      units.map((unit) => {
        const generated = graph.sourceToDts
          .get(unit.primaryCheckerName)
          ?.get(unit.configPath);
        return {
          config: unit.configPath,
          checker: unit.primaryCheckerName,
          authority: unit.semanticAuthority,
          roots: unit.ownedFileNames,
          declarations: graph.dependencyAnalysis?.declarationContexts
            ?.filter((decision) => decision.consumerConfig === unit.configPath)
            .map((decision) =>
              JSON.stringify({
                kind: decision.kind,
                file: decision.file.lexicalPath,
                selection: decision.selection,
                owners: decision.coverage.members
                  .map((member) => member.configId)
                  .sort((a, b) => a.localeCompare(b)),
              }),
            )
            .sort((a, b) => a.localeCompare(b)),
          generated,
          configContent:
            generated === undefined
              ? null
              : graph.generatedFiles.get(generated),
          toolchain: unit.context.vueSemanticIdentity?.toolchain.paths,
          outgoing: graph.dependencyEdges.filter(
            (edge) => edge.fromConfigPath === unit.configPath,
          ),
        };
      }),
    ),
  );
}

function ownershipIdentity(graph: PreparedTsconfigGraph): string {
  return hash(
    JSON.stringify(
      graph.governedSources
        .values()
        .flatMap((units) => units.values())
        .map((unit) => [
          unit.configPath,
          unit.primaryCheckerName,
          unit.semanticAuthority,
          unit.packageRootDir,
          unit.ownedFileNames,
        ])
        .toArray()
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
}

export function captureProducerBuildInputs(
  plan: ProducerBuildPlan,
): ProducerBuildInputs {
  const inputs = new Map<string, string>();
  const producers = plan.governedSources
    .values()
    .flatMap((units) => units.values())
    .filter((unit) => isBuildCapablePreset(unit.primaryCheckerName))
    .toArray();
  const configs = new Set(producers.map((unit) => unit.configPath));
  const scope = graphExecutionInputScope(plan, configs, new Set<string>());
  const observed = new Set(scope.paths);
  for (const unit of producers) {
    if (unit.semanticAuthority.family !== 'vue') continue;
    const vueInputs = vueExecutionInputs(unit.context.vueSemanticIdentity);
    for (const file of vueInputs.paths) observed.add(file);
  }
  const outputs = new Set(
    plan.declarationOutputs?.map((entry) => entry.outputFile),
  );
  // Retain actual compiler input contents, including external declarations.
  // Generated configs are already bound by semantics; producer outputs are
  // expected to change during the build and receive their own output identity.
  for (const file of observed) {
    if (
      plan.generatedFiles.has(file) ||
      outputs.has(file) ||
      file.endsWith('.tsbuildinfo')
    )
      continue;
    if (statSync(file, { throwIfNoEntry: false })?.isFile())
      inputs.set(file, hash(content(file)));
  }
  const fromRuntime = createRequire(import.meta.url);
  for (const specifier of [
    'typescript',
    'typescript/bin/tsc',
    'typescript/package.json',
  ]) {
    const file = fromRuntime.resolve(specifier);
    inputs.set(file, hash(content(file)));
  }
  const splitCompiler = path.join(
    path.dirname(fromRuntime.resolve('typescript')),
    '_tsc.js',
  );
  if (existsSync(splitCompiler))
    inputs.set(splitCompiler, hash(content(splitCompiler)));
  // Include the ownership inputs too: a later consumer relation may not recolor
  // the already admitted producer closure.
  for (const units of plan.governedSources.values())
    for (const unit of units.values()) {
      const parsed = parseTypeScriptProjectConfig({
        configPath: unit.configPath,
        tsModule: ts,
      });
      const config = parsed?.options.configFile as
        | ts.TsConfigSourceFile
        | undefined;
      const files = [
        unit.configPath,
        ...unit.ownedFileNames,
        ...Object.values(
          unit.context.vueSemanticIdentity?.toolchain.paths ?? {},
        ),
        ...((
          config as
            | (ts.TsConfigSourceFile & { extendedSourceFiles?: string[] })
            | undefined
        )?.extendedSourceFiles ?? []),
        ...(unit.svelteSemanticProject?.configClosure?.map(
          (entry) => entry.filePath,
        ) ?? []),
        ...(unit.context.vueSemanticIdentity?.configClosure.map(
          (entry) => entry.filePath,
        ) ?? []),
      ];
      for (const file of files) inputs.set(file, hash(content(file)));
    }
  return {
    semantics: producerSemantics(plan),
    ownership: ownershipIdentity(plan),
    inputs,
  };
}

function assertInputs(inputs: ReadonlyMap<string, string>): void {
  for (const [file, identity] of inputs)
    if (hash(content(file)) !== identity)
      throw new Error(`Producer build input changed: ${file}`);
}

export function observeProducerOutputMappings(
  plan: ProducerBuildPlan,
  projectRootDirectory: string,
): ProducerOutputMapping[] {
  const declarations: ProducerOutputMapping[] = [];
  for (const [checker, configs] of plan.sourceToDts) {
    if (configs.size === 0) continue;
    const probe = normalizeAbsolutePath(
      path.join(projectRootDirectory, '.limina', 'producer-reference-map.json'),
    );
    const files = new Map(plan.generatedFiles);
    files.set(
      probe,
      JSON.stringify({
        files: [],
        references: configs
          .values()
          .map((config) => ({ path: config }))
          .toArray(),
      }),
    );
    const parsed = parseTypeScriptProjectConfig({
      configPath: probe,
      tsModule: ts,
      virtualFiles: files,
    })!;
    const units = plan.governedSources.get(checker)!;
    const sourceInputs = configs
      .keys()
      .flatMap((source) => units.get(source)?.ownedFileNames ?? [])
      .toArray();
    const host = withVirtualResolutionFiles(
      ts.createCompilerHost(parsed.options),
      files,
    );
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (
      file,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const virtual = files.get(normalizeAbsolutePath(file));
      return virtual === undefined
        ? getSourceFile(
            file,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          )
        : ts.createSourceFile(file, virtual, languageVersion);
    };
    const mappings =
      checker === 'vue-tsc'
        ? observeVueDeclarationCandidate({
            checker,
            sourceConfig: configs.keys().toArray()[0]!,
            generatedConfig: probe,
            executionRoot: projectRootDirectory,
            parsed,
            files,
            coverage: plan.sourceConfigCoverage!,
            roots: [],
            configs: files
              .keys()
              .filter((file) => file.endsWith('.json'))
              .toArray(),
            declarations: [],
            referenceInputs: sourceInputs,
            requiresDelegationProof: false,
          }).mappings
        : (() => {
            const program = ts.createProgram({
              rootNames: [],
              options: parsed.options,
              projectReferences: parsed.projectReferences,
              host,
            });
            return sourceInputs.map((file) => ({
              file,
              ...observeNativeReferenceMapping(program, file, ts),
            }));
          })();
    for (const mapping of mappings) {
      if (
        /\.d\.[cm]?ts$/iu.test(mapping.file) ||
        mapping.file.endsWith('.json')
      )
        continue;
      const output = mapping.declarationOutput;
      const sourceConfig = [...configs].find(
        ([, generated]) => generated === mapping.referenceConfig,
      )?.[0];
      if (output == null || sourceConfig === undefined || !mapping.qualified)
        throw new Error(
          `Producer has no qualified declaration output mapping: ${mapping.file}`,
        );
      declarations.push({
        checker,
        sourceConfig,
        generatedConfig: mapping.referenceConfig!,
        sourceFile: mapping.file,
        outputFile: output,
      });
    }
  }
  return declarations;
}

export function issueProducerBuildReceipt(
  plan: ProducerBuildPlan,
  baseline: ProducerBuildInputs,
  projectRootDirectory: string,
): ProducerBuildReceipt {
  assertInputs(baseline.inputs);
  if (producerSemantics(plan) !== baseline.semantics)
    throw new Error('Producer compilation semantics changed during build.');
  const mappings = observeProducerOutputMappings(plan, projectRootDirectory);
  if (JSON.stringify(mappings) !== JSON.stringify(plan.declarationOutputs))
    throw new Error(
      'Producer declaration output mapping changed during build.',
    );
  const declarations = mappings.map((mapping) => {
    const text = content(mapping.outputFile);
    return { ...mapping, content: text, contentIdentity: hash(text) };
  });
  assertInputs(baseline.inputs);
  const receipt: ProducerBuildReceipt = {
    ...baseline,
    plan,
    declarations,
    identity: hash(
      JSON.stringify([
        baseline.semantics,
        baseline.ownership,
        [...baseline.inputs],
        declarations.map((entry) => [
          entry.sourceConfig,
          entry.sourceFile,
          entry.outputFile,
          entry.contentIdentity,
        ]),
      ]),
    ),
  };
  issued.set(receipt, receiptIdentity(receipt));
  return receipt;
}

export function assertProducerBuildReceipt(
  receipt: ProducerBuildReceipt,
  finalGraph?: PreparedTsconfigGraph,
): void {
  if (issued.get(receipt) !== receiptIdentity(receipt))
    throw new Error('Producer receipt was not issued by this invocation.');
  if (producerSemantics(receipt.plan) !== receipt.semantics)
    throw new Error('Producer compilation semantics changed after build.');
  assertInputs(receipt.inputs);
  for (const declaration of receipt.declarations)
    if (hash(content(declaration.outputFile)) !== declaration.contentIdentity)
      throw new Error(
        `Producer declaration changed after build: ${declaration.outputFile}`,
      );
  if (
    finalGraph !== undefined &&
    ownershipIdentity(finalGraph) !== receipt.ownership
  )
    throw new Error(
      'Final reference graph changes frozen checker ownership or semantic authority.',
    );
  if (
    finalGraph !== undefined &&
    producerSemantics(finalGraph) !== receipt.semantics
  )
    throw new Error(
      'Final reference graph changes the already built producer compilation semantics.',
    );
}

function receiptIdentity(receipt: ProducerBuildReceipt): string {
  return hash(
    JSON.stringify([
      receipt.identity,
      receipt.semantics,
      receipt.ownership,
      [...receipt.inputs],
      receipt.declarations,
    ]),
  );
}

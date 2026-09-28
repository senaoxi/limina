import { prepareAstroSemanticDependencies } from '../astro-semantic/preparation';
import type {
  FrameworkSemanticDependencyPreparation,
  FrameworkSemanticFailureStage,
} from '../framework-semantic/contracts';
import { prepareVueSemanticDependencies } from '../vue-semantic/preparation';
import type { ProviderDependencies } from './resolution-provider-types';
import type {
  ImportAnalysisContext,
  ImportResolveContextFields,
} from './types';

type PreparationOptions = Parameters<
  ImportAnalysisContext['prepareCheckerSemanticDependencies']
>[0] & { dependencies: ProviderDependencies };

interface ContextFailure {
  failure: FrameworkSemanticDependencyPreparation;
  kind: 'failure';
}

interface VuePreparationContext {
  identity: NonNullable<PreparationOptions['context']['vueSemanticIdentity']>;
  kind: 'ready';
  manager: NonNullable<ProviderDependencies['vueSemanticContexts']>;
}

interface AstroPreparationContext {
  kind: 'ready';
  manager: NonNullable<ProviderDependencies['astroSemanticContexts']>;
  project: NonNullable<PreparationOptions['context']['astroSemanticProject']>;
}

interface SveltePreparationContext {
  kind: 'ready';
  manager: NonNullable<ProviderDependencies['svelteSemanticContexts']>;
  project: NonNullable<PreparationOptions['context']['svelteSemanticProject']>;
}

function unsupported(options: {
  framework: 'astro' | 'svelte' | 'vue';
  reason: string;
}): FrameworkSemanticDependencyPreparation {
  return {
    kind: 'unsupported',
    reason: options.reason,
    stage: 'context-creation',
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyToolchainFailure(
  error: unknown,
): Extract<
  FrameworkSemanticFailureStage,
  'context-creation' | 'toolchain-compatibility' | 'toolchain-resolution'
> {
  const message = formatError(error);
  if (/unsupported .* semantic toolchain/iu.test(message)) {
    return 'toolchain-compatibility';
  }
  if (/dependency|package|resolve|toolchain/iu.test(message)) {
    return 'toolchain-resolution';
  }
  return 'context-creation';
}

function getVueContext(
  options: PreparationOptions,
): ContextFailure | VuePreparationContext {
  const identity = options.context.vueSemanticIdentity;
  const manager = options.dependencies.vueSemanticContexts;
  if (identity === undefined) {
    return {
      failure: unsupported({
        framework: 'vue',
        reason:
          'Locked Vue semantic authority has no Vue project semantic identity.',
      }),
      kind: 'failure',
    };
  }
  if (manager === undefined) {
    return {
      failure: unsupported({
        framework: 'vue',
        reason:
          'Locked Vue semantic authority has no Vue semantic context manager.',
      }),
      kind: 'failure',
    };
  }
  return { identity, kind: 'ready', manager };
}

function runVuePreparation(
  options: PreparationOptions & {
    identity: NonNullable<PreparationOptions['context']['vueSemanticIdentity']>;
    manager: NonNullable<ProviderDependencies['vueSemanticContexts']>;
  },
): FrameworkSemanticDependencyPreparation {
  try {
    return prepareVueSemanticDependencies({
      context: options.manager.acquire(options.identity),
      filePath: options.filePath,
      managedOutputLookup: options.managedOutputLookup,
    });
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: formatError(error),
      stage: classifyToolchainFailure(error),
    };
  }
}

function prepareVue(
  options: PreparationOptions,
): FrameworkSemanticDependencyPreparation {
  const context = getVueContext(options);
  if (context.kind === 'failure') return context.failure;
  return runVuePreparation({ ...options, ...context });
}

function getAstroContext(
  options: PreparationOptions,
): AstroPreparationContext | ContextFailure {
  const project = options.context.astroSemanticProject;
  const manager = options.dependencies.astroSemanticContexts;
  if (project === undefined) {
    return {
      failure: unsupported({
        framework: 'astro',
        reason:
          'Locked Astro semantic authority has no Astro semantic project.',
      }),
      kind: 'failure',
    };
  }
  if (manager === undefined) {
    return {
      failure: unsupported({
        framework: 'astro',
        reason:
          'Locked Astro semantic authority has no Astro semantic context manager.',
      }),
      kind: 'failure',
    };
  }
  return { kind: 'ready', manager, project };
}

function runAstroPreparation(
  options: PreparationOptions & {
    manager: NonNullable<ProviderDependencies['astroSemanticContexts']>;
    project: NonNullable<PreparationOptions['context']['astroSemanticProject']>;
  },
): FrameworkSemanticDependencyPreparation {
  try {
    return prepareAstroSemanticDependencies({
      context: options.manager.acquire(options.project),
      filePath: options.filePath,
      managedOutputLookup: options.managedOutputLookup,
    });
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: formatError(error),
      stage: classifyToolchainFailure(error),
    };
  }
}

function prepareAstro(
  options: PreparationOptions,
): FrameworkSemanticDependencyPreparation {
  const context = getAstroContext(options);
  if (context.kind === 'failure') return context.failure;
  return runAstroPreparation({ ...options, ...context });
}

function getSvelteContext(
  options: PreparationOptions,
): ContextFailure | SveltePreparationContext {
  const project = options.context.svelteSemanticProject;
  const manager = options.dependencies.svelteSemanticContexts;
  if (project === undefined) {
    return {
      failure: unsupported({
        framework: 'svelte',
        reason:
          'Locked Svelte semantic authority has no Svelte semantic project.',
      }),
      kind: 'failure',
    };
  }
  if (manager === undefined) {
    return {
      failure: unsupported({
        framework: 'svelte',
        reason:
          'Locked Svelte semantic authority has no Svelte semantic context manager.',
      }),
      kind: 'failure',
    };
  }
  return { kind: 'ready', manager, project };
}

function runSveltePreparation(
  options: PreparationOptions & {
    manager: NonNullable<ProviderDependencies['svelteSemanticContexts']>;
    project: NonNullable<
      PreparationOptions['context']['svelteSemanticProject']
    >;
  },
): FrameworkSemanticDependencyPreparation {
  try {
    return options.manager
      .acquire(options.project)
      .prepare(options.filePath, options.managedOutputLookup);
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: formatError(error),
      stage: classifyToolchainFailure(error),
    };
  }
}

function prepareSvelte(
  options: PreparationOptions,
): FrameworkSemanticDependencyPreparation {
  const context = getSvelteContext(options);
  if (context.kind === 'failure') return context.failure;
  return runSveltePreparation({ ...options, ...context });
}

function prepareTypeScript(): FrameworkSemanticDependencyPreparation {
  return {
    directSourceRecords: [],
    facts: [],
    kind: 'supported',
    unmapped: [],
  };
}

const PREPARERS = {
  astro: prepareAstro,
  svelte: prepareSvelte,
  typescript: prepareTypeScript,
  vue: prepareVue,
} satisfies Record<
  NonNullable<ImportResolveContextFields['semanticFamily']>,
  (options: PreparationOptions) => FrameworkSemanticDependencyPreparation
>;

export function createCheckerDependencyPreparation(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['prepareCheckerSemanticDependencies'] {
  return (options) => {
    const family = options.context.semanticFamily ?? 'typescript';
    return PREPARERS[family]({ ...options, dependencies });
  };
}

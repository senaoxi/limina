import type { BuiltinTaskName } from '#config/runner';

export type FactProduct =
  | 'workspace'
  | 'config'
  | 'membership'
  | 'occurrence'
  | 'native'
  | 'framework'
  | 'runtime-only'
  | 'resource'
  | 'ownership'
  | 'graph';

export type PackageArtifactProduct =
  | 'workspace'
  | 'manifest'
  | 'distribution'
  | 'archive';

export type FactStage = 'stage-a' | 'stage-b1' | 'stage-b2';

export type GovernanceCapabilityId = BuiltinTaskName | 'dependency-graph';

export type GovernanceRuleId =
  | 'graph:routes'
  | 'graph:project-references'
  | 'graph:reference-completeness'
  | 'source:routes'
  | 'source:tsconfig-governance'
  | 'source:project-ownership'
  | 'source:import-authority'
  | 'source:knip'
  | 'proof:expected-source-files'
  | 'proof:project-routes'
  | 'proof:source-coverage'
  | 'dependency-graph:export'
  | 'package:boundary'
  | 'package:tarball'
  | 'release:consistency';

export interface RuleSubscription<
  Products extends readonly FactProduct[] = readonly FactProduct[],
> {
  readonly capability: GovernanceCapabilityId;
  readonly products: Products;
  readonly requiresSemanticFacts: boolean;
  readonly rule: GovernanceRuleId;
}

export interface FactProducerDescriptor {
  readonly id: string;
  readonly stage: FactStage;
  readonly supplies: readonly FactProduct[];
  readonly requires: readonly FactProduct[];
}

export interface CapabilitySubscription<
  Products extends readonly FactProduct[] = readonly FactProduct[],
> {
  readonly capability: GovernanceCapabilityId;
  readonly products: Products;
  readonly requiresSemanticFacts: boolean;
}

/**
 * Canonical causal producer DAG:
 * - Stage A: workspace -> config + frozen semantic authority -> membership/coverage -> occurrence -> native/framework/runtime-only/resource
 * - Stage B1: ownership (requires Stage A facts including compilation obligation & declaration context inputs)
 * - Stage B2: graph (reference graph, framework scheduling, candidate validation, artifact plan)
 */
export const CORE_FACT_PRODUCERS: readonly FactProducerDescriptor[] =
  Object.freeze([
    {
      id: 'workspace-discovery',
      stage: 'stage-a',
      supplies: ['workspace'],
      requires: [],
    },
    {
      id: 'config-and-authority',
      stage: 'stage-a',
      supplies: ['config'],
      requires: ['workspace'],
    },
    {
      id: 'source-membership',
      stage: 'stage-a',
      supplies: ['membership'],
      requires: ['workspace', 'config'],
    },
    {
      id: 'source-occurrence',
      stage: 'stage-a',
      supplies: ['occurrence'],
      requires: ['membership'],
    },
    {
      id: 'native-semantic',
      stage: 'stage-a',
      supplies: ['native'],
      requires: ['workspace', 'config', 'membership', 'occurrence'],
    },
    {
      id: 'framework-semantic',
      stage: 'stage-a',
      supplies: ['framework'],
      requires: ['workspace', 'config', 'membership', 'occurrence'],
    },
    {
      id: 'runtime-only',
      stage: 'stage-a',
      supplies: ['runtime-only'],
      requires: ['workspace', 'config', 'membership', 'occurrence', 'native'],
    },
    {
      id: 'resource-observation',
      stage: 'stage-a',
      supplies: ['resource'],
      requires: ['workspace', 'config', 'occurrence'],
    },
    {
      id: 'ownership-finalization',
      stage: 'stage-b1',
      supplies: ['ownership'],
      requires: ['workspace', 'config', 'membership', 'native', 'framework'],
    },
    {
      id: 'graph-derivation',
      stage: 'stage-b2',
      supplies: ['graph'],
      requires: ['workspace', 'membership', 'native', 'framework', 'ownership'],
    },
  ]);

export const BUILTIN_CAPABILITY_SUBSCRIPTIONS: Readonly<
  Record<GovernanceCapabilityId, CapabilitySubscription>
> = Object.freeze({
  'graph:prepare': {
    capability: 'graph:prepare',
    products: [
      'workspace',
      'config',
      'membership',
      'occurrence',
      'native',
      'framework',
      'ownership',
      'graph',
    ],
    requiresSemanticFacts: true,
  },
  'graph:check': {
    capability: 'graph:check',
    products: [
      'workspace',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
      'ownership',
      'graph',
    ],
    requiresSemanticFacts: true,
  },
  'source:check': {
    capability: 'source:check',
    products: [
      'workspace',
      'config',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
      'resource',
      'ownership',
    ],
    requiresSemanticFacts: true,
  },
  'proof:check': {
    capability: 'proof:check',
    products: ['workspace', 'config', 'membership', 'ownership', 'graph'],
    requiresSemanticFacts: true,
  },
  'checker:build': {
    capability: 'checker:build',
    products: ['workspace', 'ownership', 'graph'],
    requiresSemanticFacts: true,
  },
  'checker:typecheck': {
    capability: 'checker:typecheck',
    products: ['workspace', 'ownership', 'graph'],
    requiresSemanticFacts: true,
  },
  'dependency-graph': {
    capability: 'dependency-graph',
    products: [
      'workspace',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
    ],
    requiresSemanticFacts: true,
  },
  'package:check': {
    capability: 'package:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
  },
  'release:check': {
    capability: 'release:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
  },
});

export const BUILTIN_RULE_SUBSCRIPTIONS: Readonly<
  Record<GovernanceRuleId, RuleSubscription>
> = Object.freeze({
  'graph:routes': {
    capability: 'graph:check',
    products: ['workspace', 'ownership'],
    requiresSemanticFacts: true,
    rule: 'graph:routes',
  },
  'graph:project-references': {
    capability: 'graph:check',
    products: ['workspace', 'config', 'ownership', 'graph'],
    requiresSemanticFacts: true,
    rule: 'graph:project-references',
  },
  'graph:reference-completeness': {
    capability: 'graph:check',
    products: [
      'workspace',
      'config',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
      'ownership',
      'graph',
    ],
    requiresSemanticFacts: true,
    rule: 'graph:reference-completeness',
  },
  'source:routes': {
    capability: 'source:check',
    products: ['workspace', 'ownership', 'graph'],
    requiresSemanticFacts: true,
    rule: 'source:routes',
  },
  'source:tsconfig-governance': {
    capability: 'source:check',
    products: ['workspace', 'config', 'ownership'],
    requiresSemanticFacts: true,
    rule: 'source:tsconfig-governance',
  },
  'source:project-ownership': {
    capability: 'source:check',
    products: ['workspace', 'membership', 'ownership'],
    requiresSemanticFacts: true,
    rule: 'source:project-ownership',
  },
  'source:import-authority': {
    capability: 'source:check',
    products: [
      'workspace',
      'config',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
      'resource',
      'ownership',
    ],
    requiresSemanticFacts: true,
    rule: 'source:import-authority',
  },
  'source:knip': {
    capability: 'source:check',
    products: ['workspace', 'membership', 'ownership', 'graph'],
    requiresSemanticFacts: true,
    rule: 'source:knip',
  },
  'proof:expected-source-files': {
    capability: 'proof:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
    rule: 'proof:expected-source-files',
  },
  'proof:project-routes': {
    capability: 'proof:check',
    products: ['workspace', 'config', 'ownership', 'graph'],
    requiresSemanticFacts: true,
    rule: 'proof:project-routes',
  },
  'proof:source-coverage': {
    capability: 'proof:check',
    products: ['workspace', 'config', 'membership', 'ownership', 'graph'],
    requiresSemanticFacts: true,
    rule: 'proof:source-coverage',
  },
  'dependency-graph:export': {
    capability: 'dependency-graph',
    products: [
      'workspace',
      'membership',
      'occurrence',
      'native',
      'framework',
      'runtime-only',
    ],
    requiresSemanticFacts: true,
    rule: 'dependency-graph:export',
  },
  'package:boundary': {
    capability: 'package:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
    rule: 'package:boundary',
  },
  'package:tarball': {
    capability: 'package:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
    rule: 'package:tarball',
  },
  'release:consistency': {
    capability: 'release:check',
    products: ['workspace'],
    requiresSemanticFacts: false,
    rule: 'release:consistency',
  },
});

export interface SubscriptionPlan {
  readonly capabilities: readonly GovernanceCapabilityId[];
  readonly products: readonly FactProduct[];
  readonly producers: readonly FactProducerDescriptor[];
  readonly requiresSemanticFacts: boolean;
  readonly requiresStageB2: boolean;
  readonly rules?: readonly GovernanceRuleId[];
}

function buildSubscriptionPlan(options: {
  capabilities: readonly GovernanceCapabilityId[];
  initialProducts: ReadonlySet<FactProduct>;
  requiresSemanticFacts: boolean;
  rules?: readonly GovernanceRuleId[];
}): SubscriptionPlan {
  const producerByProduct = new Map<FactProduct, FactProducerDescriptor>();
  for (const producer of CORE_FACT_PRODUCERS) {
    for (const product of producer.supplies) {
      if (producerByProduct.has(product)) {
        throw new Error(
          `Duplicate Core fact producer for product "${product}".`,
        );
      }
      producerByProduct.set(product, producer);
    }
  }

  const requiredProducts = new Set<FactProduct>(options.initialProducts);
  const orderedProducers: FactProducerDescriptor[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (product: FactProduct): void => {
    const producer = producerByProduct.get(product);
    if (producer === undefined) {
      throw new Error(`Missing Core fact producer for product "${product}".`);
    }
    if (visited.has(producer.id)) return;
    if (visiting.has(producer.id)) {
      throw new Error(
        `Cyclic Core fact producer dependency at "${producer.id}".`,
      );
    }
    visiting.add(producer.id);
    for (const dependency of producer.requires) {
      requiredProducts.add(dependency);
      visit(dependency);
    }
    visiting.delete(producer.id);
    visited.add(producer.id);
    orderedProducers.push(producer);
  };

  for (const product of requiredProducts) {
    visit(product);
  }

  return Object.freeze({
    capabilities: Object.freeze([...options.capabilities]),
    products: Object.freeze([...requiredProducts]),
    producers: Object.freeze(orderedProducers),
    requiresSemanticFacts: options.requiresSemanticFacts,
    requiresStageB2: requiredProducts.has('graph'),
    ...(options.rules !== undefined && {
      rules: Object.freeze([...options.rules]),
    }),
  });
}

export function planCapabilitySubscriptions(
  capabilities: readonly GovernanceCapabilityId[],
): SubscriptionPlan {
  const initialProducts = new Set<FactProduct>();
  let requiresSemanticFacts = false;
  for (const capability of capabilities) {
    const subscription = BUILTIN_CAPABILITY_SUBSCRIPTIONS[capability];
    if (subscription.requiresSemanticFacts) requiresSemanticFacts = true;
    for (const product of subscription.products) {
      initialProducts.add(product);
    }
  }
  return buildSubscriptionPlan({
    capabilities,
    initialProducts,
    requiresSemanticFacts,
  });
}

export function planRuleSubscriptions(
  rules: readonly GovernanceRuleId[],
): SubscriptionPlan {
  const capabilities = new Set<GovernanceCapabilityId>();
  const initialProducts = new Set<FactProduct>();
  let requiresSemanticFacts = false;
  for (const rule of rules) {
    const subscription = BUILTIN_RULE_SUBSCRIPTIONS[rule];
    capabilities.add(subscription.capability);
    if (subscription.requiresSemanticFacts) requiresSemanticFacts = true;
    for (const product of subscription.products) {
      initialProducts.add(product);
    }
  }
  return buildSubscriptionPlan({
    capabilities: [...capabilities],
    initialProducts,
    requiresSemanticFacts,
    rules,
  });
}

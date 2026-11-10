import { hashObject, invariant, object, sha } from './io.ts';
import type {
  Domain,
  DomainPlan,
  Execution,
  Identity,
  Plan,
  Tuple,
} from './types.ts';

export const domains: Domain[] = [
  'repository_gates',
  'core',
  'limina_unit',
  'migrate_unit',
  'tooling',
  'integration',
  'smoke',
  'windows',
  'checker_compatibility',
  'docs',
];
const all = domains.filter((domain) => domain !== 'repository_gates');
export const policy: Record<string, Domain[]> = {
  full_control: all,
  limina_source: all,
  limina_runtime: all,
  migrate_source: [
    'core',
    'limina_unit',
    'migrate_unit',
    'tooling',
    'integration',
    'smoke',
    'windows',
  ],
  migrate_runtime: [
    'core',
    'limina_unit',
    'migrate_unit',
    'tooling',
    'integration',
    'smoke',
    'windows',
  ],
  limina_unit: ['core', 'limina_unit', 'integration', 'windows'],
  migrate_unit: ['core', 'migrate_unit', 'integration', 'windows'],
  limina_integration: ['core', 'integration'],
  migrate_integration: ['core', 'integration'],
  limina_fixtures: [
    'core',
    'limina_unit',
    'migrate_unit',
    'integration',
    'smoke',
    'windows',
    'checker_compatibility',
  ],
  smoke: ['core', 'smoke', 'windows'],
  package_docs: ['core', 'smoke'],
  docs_markdown: ['docs'],
  docs_runtime: ['core', 'tooling', 'docs'],
  repository_docs: ['docs'],
};
export const fixedNode = '22.22.3';
export const controller = 'node packages/gates/src/ci/cli.ts';
export const files = {
  plan: '.reports/ci/plan.json',
  preparation: '.reports/ci/preparation.json',
  audit: '.reports/ci/audit.json',
  receipt: '.reports/ci/receipt.json',
  restored: '.reports/ci/restored',
  stage: '.reports/ci/upload',
};
export const stepName = (key: string): string => 'ci/' + key;
export const jobName = (job: string, tuple: string, shard = 'all'): string =>
  `CI ${job} / ${tuple} / ${shard}`;
export const artifactName = (
  kind: string,
  attempt: number,
  tuple = 'all',
  shard = 'all',
): string => `ci-${kind}-a${attempt}-${tuple}-${shard}`;

export function tuples(rollingNode: string): Tuple[] {
  invariant(
    /^24\.\d+\.\d+$/.test(rollingNode),
    'Rolling Node must resolve to an exact Node 24 version',
  );
  const make = (platform: Tuple['platform'], node: string): Tuple => ({
    key: platform + '-' + node,
    os: {
      linux: 'ubuntu-latest',
      darwin: 'macos-latest',
      win32: 'windows-latest',
    }[platform],
    platform,
    node,
  });
  const values = [
    make('linux', fixedNode),
    make('linux', '24.15.0'),
    make('linux', '26.0.0'),
    make('linux', rollingNode),
    make('darwin', fixedNode),
    make('win32', fixedNode),
    make('darwin', '24.15.0'),
    make('win32', '24.15.0'),
  ];
  return new Map(values.map((tuple) => [tuple.key, tuple])).values().toArray();
}
export function validationTuples(rollingNode: string): Tuple[] {
  return tuples(rollingNode).filter(
    (tuple) => tuple.platform === 'linux' || tuple.node === fixedNode,
  );
}
export function unitMatrix(rollingNode: string): (Tuple & { shard: string })[] {
  return validationTuples(rollingNode).flatMap((tuple) => {
    const count =
      tuple.platform === 'darwin' ? 2 : tuple.platform === 'win32' ? 4 : 1;
    return Array.from({ length: count }, (_, index) => ({
      ...tuple,
      shard: count === 1 ? 'all' : `${index + 1}-${count}`,
    }));
  });
}
export function smokeTuples(rollingNode: string): Tuple[] {
  return tuples(rollingNode).filter((tuple) =>
    tuple.platform === 'linux'
      ? [fixedNode, '24.15.0', '26.0.0'].includes(tuple.node)
      : tuple.node === '24.15.0',
  );
}
export function nativeJob(tuple: string): string {
  return tuple === 'linux-' + fixedNode
    ? 'native-build-linux22'
    : 'native-build';
}

export function requirements(rollingNode: string): Record<Domain, Execution[]> {
  const linux = 'linux-' + fixedNode;
  const execution = (
    job: string,
    tuple: string,
    step: string,
    shard = 'all',
    artifact: Execution['artifact'] = 'native',
  ): Execution => ({
    job,
    tuple,
    shard,
    step,
    artifact,
    prerequisites: [
      'checkout',
      'setup',
      'admit',
      artifact ? 'restore' : 'bootstrap',
    ],
  });
  const validation = (step: string) =>
    validationTuples(rollingNode).map((tuple) =>
      execution('validation', tuple.key, step),
    );
  return {
    repository_gates: ['gates', 'format', 'lint'].map((step) =>
      execution('repository-gates', linux, step, 'all', null),
    ),
    core: [
      ...tuples(rollingNode).map((tuple) => {
        const item = execution(
          nativeJob(tuple.key),
          tuple.key,
          'native_build',
          'all',
          tuple.key === linux ? 'bootstrap' : null,
        );
        return {
          ...item,
          prerequisites: [...item.prerequisites, 'manifest', 'upload_artifact'],
        };
      }),
      ...validation('core_checker'),
      ...validation('package_validation'),
    ],
    limina_unit: unitMatrix(rollingNode).map((tuple) =>
      execution('limina-unit', tuple.key, 'limina_unit', tuple.shard),
    ),
    migrate_unit: validation('migrate_unit'),
    tooling: validation('tooling'),
    integration: [
      ...validation('limina_integration'),
      ...validation('migrate_integration'),
    ],
    smoke: [
      ...smokeTuples(rollingNode).map((tuple) =>
        execution('platform-smoke', tuple.key, 'smoke'),
      ),
      execution('windows-behavior', 'win32-' + fixedNode, 'packed_smoke'),
    ],
    windows: [fixedNode, '24.15.0'].flatMap((node) =>
      ['windows_transactions', 'windows_paths', 'windows_framework'].map(
        (step) => execution('windows-behavior', 'win32-' + node, step),
      ),
    ),
    checker_compatibility: [
      execution('vue-compatibility', linux, 'vue_matrix'),
    ],
    docs: [execution('docs', linux, 'docs_build')],
  };
}
export function fullPlan(
  identity: Identity,
  contractHash: string,
  rollingNode: string,
  reason: string,
): Plan {
  const required = requirements(rollingNode);
  return seal({
    ...identity,
    schema: 1,
    contractHash,
    planHash: '',
    rollingNode,
    createdAt: new Date().toISOString(),
    mode: 'full',
    reason,
    domains: Object.fromEntries(
      domains.map((domain) => [
        domain,
        { mode: 'run', required: required[domain] },
      ]),
    ) as Record<Domain, DomainPlan>,
    nativeTuples: tuples(rollingNode),
  });
}
export function seal(plan: Plan): Plan {
  return { ...plan, planHash: hashObject({ ...plan, planHash: '' }) };
}
export function admitPlan(value: unknown): Plan {
  const raw = object(value);
  invariant(raw.schema === 1, 'Unsupported plan schema');
  const plan = value as Plan;
  sha(plan.targetSha);
  invariant(
    ['full', 'incremental', 'obsolete'].includes(plan.mode),
    'Unknown plan mode',
  );
  invariant(plan.planHash === seal(plan).planHash, 'Plan hash mismatch');
  invariant(/^[a-f0-9]{64}$/.test(plan.contractHash), 'Invalid contract hash');
  invariant(
    plan.runId > 0 && plan.originAttempt > 0 && plan.repositoryId > 0,
    'Invalid plan identity',
  );
  const required = requirements(plan.rollingNode);
  invariant(
    hashObject(
      Object.keys(plan.domains).sort((left, right) =>
        left < right ? -1 : Number(left > right),
      ),
    ) ===
      hashObject(
        [...domains].sort((left, right) =>
          left < right ? -1 : Number(left > right),
        ),
      ),
    'Incomplete domain inventory',
  );
  for (const domain of domains) {
    const entry = plan.domains[domain];
    invariant(
      entry.mode === 'run' || entry.mode === 'unaffected',
      'Unknown domain disposition',
    );
    if (entry.mode === 'run')
      invariant(
        hashObject(entry.required) === hashObject(required[domain]),
        'Changed execution inventory: ' + domain,
      );
    else {
      invariant(
        plan.mode === 'incremental' && domain !== 'repository_gates',
        'Illegal unaffected domain',
      );
      invariant(
        entry.proof.checkpoint.domain === domain &&
          entry.proof.checkpoint.contractHash === plan.contractHash,
        'Invalid unaffected checkpoint',
      );
      sha(entry.proof.checkpoint.successfulSha);
    }
  }
  invariant(
    hashObject(plan.nativeTuples) === hashObject(requiredNative(plan)),
    'Invalid native producer inventory',
  );
  return plan;
}
export function requiredNative(plan: Plan): Tuple[] {
  const keys = new Set<string>();
  for (const domain of domains) {
    const entry = plan.domains[domain];
    if (entry.mode === 'run')
      for (const item of entry.required)
        if (item.artifact === 'native' || item.step === 'native_build')
          keys.add(item.tuple);
  }
  return tuples(plan.rollingNode).filter((tuple) => keys.has(tuple.key));
}
/**
Includes producers needed by selected consumers even when Core is unaffected.
*/
export function plannedExecutions(plan: Plan): Execution[] {
  const selected = domains.flatMap((domain) => {
    const entry = plan.domains[domain];
    return entry.mode === 'run' ? entry.required : [];
  });
  const producers = requirements(plan.rollingNode).core.filter(
    (item) =>
      item.step === 'native_build' &&
      plan.nativeTuples.some((tuple) => tuple.key === item.tuple),
  );
  return new Map(
    [...selected, ...producers].map((item) => [
      jobName(item.job, item.tuple, item.shard) + ':' + item.step,
      item,
    ]),
  )
    .values()
    .toArray();
}
export function selected(
  plan: Plan,
  job: string,
  tuple: string,
  shard: string,
): string[] {
  return [
    ...new Set(
      domains.flatMap((domain) => {
        const entry = plan.domains[domain];
        return entry.mode === 'run'
          ? entry.required
              .filter(
                (item) =>
                  item.job === job &&
                  item.tuple === tuple &&
                  item.shard === shard,
              )
              .map((item) => item.step)
          : [];
      }),
    ),
  ];
}
function encode(include: object[]): string {
  return JSON.stringify({ include });
}
// Empty matrices are never emitted. Job-level selection controls legitimate skips.
function withFallback<T>(values: T[], fallback: T[]): T[] {
  return values.length > 0 ? values : fallback;
}
export function matrices(plan: Plan): Record<string, string> {
  const isEnabled = (domain: Domain) => plan.domains[domain].mode === 'run';
  const natives = tuples(plan.rollingNode).filter(
    (tuple) => nativeJob(tuple.key) === 'native-build',
  );
  return {
    mode: plan.mode,
    plan_hash: plan.planHash,
    rolling_node: plan.rollingNode,
    native_matrix: encode(
      withFallback(
        plan.nativeTuples.filter(
          (tuple) => nativeJob(tuple.key) === 'native-build',
        ),
        natives,
      ),
    ),
    native_other: String(
      plan.nativeTuples.some(
        (tuple) => nativeJob(tuple.key) === 'native-build',
      ),
    ),
    native_linux: String(
      plan.nativeTuples.some(
        (tuple) => nativeJob(tuple.key) === 'native-build-linux22',
      ),
    ),
    unit_matrix: encode(unitMatrix(plan.rollingNode)),
    validation_matrix: encode(validationTuples(plan.rollingNode)),
    smoke_matrix: encode(smokeTuples(plan.rollingNode)),
    windows_matrix: encode(
      tuples(plan.rollingNode).filter((tuple) => tuple.platform === 'win32'),
    ),
    validation: String(
      ['core', 'migrate_unit', 'tooling', 'integration'].some((domain) =>
        isEnabled(domain as Domain),
      ),
    ),
    ...Object.fromEntries(
      domains.map((domain) => [domain, String(isEnabled(domain))]),
    ),
  };
}

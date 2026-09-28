import {
  createAnalysisRun,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import {
  packageOutputFailurePolicy,
  PackageOutputValidationWorkflow,
  releaseFailurePolicy,
  ReleaseValidationWorkflow,
} from '../application/validation/output-release-workflows';
import {
  prepareTypedValidator,
  runTypedValidator,
} from '../application/validation/runner';
import { identifier } from '../domain/shared/identifiers';
import type {
  RuleDescriptor,
  RuleOptionsSchema,
} from '../domain/validation/contracts';
import {
  ConfigurationError,
  ExecutionFailure,
} from '../domain/validation/errors';

function createRun() {
  return createAnalysisRun({
    generation: identifier<'AnalysisGeneration'>('generation-1'),
    metrics: createNoopMetricsRecorder(),
    signal: new AbortController().signal,
    snapshotToken: identifier<'RepositorySnapshotToken'>('snapshot-1'),
  });
}

function descriptor<Options>(
  options: RuleDescriptor<'workspace', Options, 'invalid'>['options'],
): RuleDescriptor<'workspace', Options, 'invalid'> {
  return Object.freeze({
    category: 'workspace',
    defaultSeverity: 'error',
    description: 'Checks a workspace invariant.',
    documentation: { url: 'https://example.test/rules/workspace' },
    id: identifier<'RuleId'>('workspace/test'),
    inputKind: 'workspace',
    messages: {
      invalid: { text: 'Invalid {name}.', title: 'Invalid workspace' },
    },
    options,
  });
}

describe('validation foundation', () => {
  it('keeps AnalysisRun limited to identity, snapshot, signal and metrics', () => {
    expect(Object.keys(createRun()).sort()).toEqual([
      'generation',
      'id',
      'metrics',
      'signal',
      'snapshotToken',
    ]);
  });

  it('rejects configured values for rules without options before execution', () => {
    const validate = vi.fn();

    expect(() =>
      prepareTypedValidator({
        configuredOptions: {},
        origin: { kind: 'built-in', suite: 'architecture' },
        registration: {
          descriptor: descriptor<undefined>({ kind: 'none' }),
          validate,
        },
      }),
    ).toThrow(ConfigurationError);
    expect(validate).not.toHaveBeenCalled();
  });

  it('uses a Limina schema contract without exposing a Zod type', async () => {
    const schema: RuleOptionsSchema<{ readonly prefix: string }> = {
      parse(input) {
        return typeof input === 'object' && input !== null && 'prefix' in input
          ? { success: true, value: { prefix: String(input.prefix) } }
          : {
              problems: [{ message: 'prefix is required', path: ['prefix'] }],
              success: false,
            };
      },
    };
    const validate = vi.fn(
      (
        _view: { readonly kind: 'workspace' },
        context: {
          report(input: {
            messageId: 'invalid';
            values: { name: string };
          }): void;
        },
        options: { readonly prefix: string },
      ) => {
        context.report({
          messageId: 'invalid',
          values: { name: `${options.prefix}-region` },
        });
      },
    );

    const issues = await runTypedValidator({
      configuredOptions: { prefix: 'root' },
      origin: { kind: 'built-in', suite: 'architecture' },
      registration: {
        descriptor: descriptor({ kind: 'schema', schema }),
        validate,
      },
      run: createRun(),
      view: { kind: 'workspace' },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      documentation: 'https://example.test/rules/workspace',
      message: 'Invalid root-region.',
      messageId: 'invalid',
      origin: { kind: 'built-in', suite: 'architecture' },
      ruleId: 'workspace/test',
      severity: 'error',
      title: 'Invalid workspace',
    });
    expect(issues[0]?.id).toMatch(/^workspace\/test:/u);
  });

  it('attributes thrown validators to execution failure instead of issues', async () => {
    await expect(
      runTypedValidator({
        configuredOptions: undefined,
        origin: { kind: 'built-in', suite: 'architecture' },
        registration: {
          descriptor: descriptor<undefined>({ kind: 'none' }),
          validate() {
            throw new Error('broken validator');
          },
        },
        run: createRun(),
        view: { kind: 'workspace' },
      }),
    ).rejects.toBeInstanceOf(ExecutionFailure);
  });

  it('copies report DTOs before a validator can mutate its local values', async () => {
    const location = { path: '/repo/original.ts' };
    const evidence = [
      {
        kind: 'edge',
        location,
        value: 'original',
      },
    ];
    const values = { name: 'original' };
    const issues = await runTypedValidator({
      configuredOptions: undefined,
      origin: { kind: 'built-in', suite: 'architecture' },
      registration: {
        descriptor: descriptor<undefined>({ kind: 'none' }),
        validate(_view, context) {
          context.report({
            evidence,
            location,
            messageId: 'invalid',
            values,
          });
          location.path = '/repo/mutated.ts';
          evidence[0]!.value = 'mutated';
          values.name = 'mutated';
        },
      },
      run: createRun(),
      view: { kind: 'workspace' },
    });

    expect(issues[0]).toMatchObject({
      evidence: [{ value: 'original' }],
      location: { path: '/repo/original.ts' },
      message: 'Invalid original.',
    });
  });

  it('keeps package-output and release in independent workflows', async () => {
    const packageId = identifier<'PackageId'>('package-a');
    const references = {
      files: {},
      locations: {},
      packages: {},
      projects: {},
    } as const;
    const packageOutput = new PackageOutputValidationWorkflow({
      async get() {
        return Object.freeze({
          ...references,
          findings: Object.freeze([
            Object.freeze({
              code: 'invalid-output',
              evidence: Object.freeze([]),
              packageId,
            }),
          ]),
          kind: 'package-output' as const,
        });
      },
    });
    const release = new ReleaseValidationWorkflow({
      async get() {
        return Object.freeze({
          ...references,
          findings: Object.freeze([
            Object.freeze({ code: 'registry-drift', packageId }),
          ]),
          kind: 'release-assessment' as const,
        });
      },
    });

    await expect(packageOutput.execute(createRun())).resolves.toMatchObject([
      { origin: { suite: 'package-output' } },
    ]);
    await expect(release.execute(createRun())).resolves.toMatchObject([
      { origin: { suite: 'release' } },
    ]);
    expect(packageOutputFailurePolicy.networkFailure).toBe('not-applicable');
    expect(releaseFailurePolicy.networkFailure).toBe('execution-failure');
  });
});

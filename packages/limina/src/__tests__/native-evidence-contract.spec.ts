import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  captureNativeEvidenceOrigin,
  lockNativeEvidenceContext,
  type NativeEvidenceContext,
  qualifyNativeEvidence,
} from '../domain/analysis/native-context';
import {
  deriveNativeCoverage,
  type NativeFileIdentity,
  type SourceConfigCoverageIndex,
  type SourceConfigEnumeration,
} from '../domain/analysis/native-coverage';
import {
  decideNativeFrontier,
  type NativeCompletenessPartition,
  type NativeEvidenceSnapshot,
} from '../domain/analysis/native-evidence';
import {
  freezeNativeData,
  freezeNativeEvidence,
} from '../domain/analysis/native-evidence-freeze';
import {
  type DeclarationAvailability,
  type NativeCompilationObligation,
  summarizeCompilationObligation,
} from '../domain/analysis/native-obligation';

// These identifiers are opaque domain values, not filesystem fixtures. Actual
// filesystem/compiler identity proof belongs to the independent P0 experiment.
function file(
  lexicalPath = 'source',
  canonicalId = 'physical-source',
): NativeFileIdentity {
  return {
    lexicalPath,
    physical: {
      state: 'verified',
      canonicalId,
      evidenceId: 'stat+realpath',
      inputVersion: 'v1',
    },
  };
}

function config(configId: string, members = [file()]): SourceConfigEnumeration {
  return {
    configId,
    members,
    state: 'enumerated',
    inputVersion: 'v1',
    complete: true,
    evidenceId: `members:${configId}`,
  };
}

function index(
  configurations: readonly SourceConfigEnumeration[],
): SourceConfigCoverageIndex {
  return {
    inputVersion: 'v1',
    universe: {
      id: 'activated-source-configs',
      revision: 'u1',
      inputVersion: 'v1',
      selectionEvidenceId: 'entries+solution-closure',
      scopeFingerprint: 'scope1',
      sourceConfigIds: ['A', 'B'],
      discovery: 'closed',
    },
    configurations,
  };
}

function observeCoverage(
  configurations: readonly SourceConfigEnumeration[],
  target = file(),
) {
  return deriveNativeCoverage(index(configurations), target);
}

describe.each(['mutable', 'published'] as const)(
  'source config coverage proof (%s)',
  (representation) => {
    const observe = (
      coverage: SourceConfigCoverageIndex,
      target: NativeFileIdentity,
    ) =>
      deriveNativeCoverage(
        representation === 'published' ? freezeNativeData(coverage) : coverage,
        target,
      );
    const observeConfigs = (
      configurations: readonly SourceConfigEnumeration[],
      target = file(),
    ) => observe(index(configurations), target);

    it('does not replace the selected universe with successfully parsed configs', () => {
      const partial = observeConfigs([config('A')], file());
      expect(partial.state).toBe('unavailable');
      expect(partial.members.map((member) => member.configId)).toEqual(['A']);
      expect(partial.gaps).toContain('config-unavailable:B');
      expect(observeConfigs([config('A'), config('B', [])], file()).state).toBe(
        'unique',
      );
    });

    it.each([
      [[], [], 'uncovered'],
      [[file()], [], 'unique'],
      [[file()], [file()], 'ambiguous'],
    ] as const)(
      'distinguishes complete zero/one/many membership (%s, %s)',
      (a, b, state) => {
        expect(
          observeConfigs([config('A', [...a]), config('B', [...b])], file())
            .state,
        ).toBe(state);
      },
    );

    it('proves ambiguity with two positive members even before discovery closes', () => {
      const open = index([config('A'), config('B')]);
      const result = observe(
        { ...open, universe: { ...open.universe, discovery: 'open' } },
        file(),
      );
      expect(result.state).toBe('ambiguous');
      expect(result.completeness).toBe('incomplete');
    });

    it('checks canonical aliases even when the lexical path already matches', () => {
      const result = observeConfigs(
        [config('A'), config('B', [file('symlink')])],
        file(),
      );
      expect(result.state).toBe('ambiguous');
      expect(result.members.map((member) => member.match)).toEqual([
        'lexical',
        'canonical',
      ]);
    });

    it('does not borrow scope from an extends/generated config outside the universe', () => {
      const result = observeConfigs(
        [
          config('A', []),
          config('B', []),
          config('extends'),
          config('generated'),
        ],
        file(),
      );
      expect(result.state).toBe('uncovered');
      expect(result.members).toEqual([]);
    });

    it('cannot prove unique when an alias identity has not been verified', () => {
      const unverified: NativeFileIdentity = {
        lexicalPath: 'other',
        physical: { state: 'unavailable', reason: 'stat failed' },
      };
      const result = observeConfigs(
        [config('A'), config('B', [unverified])],
        file(),
      );
      expect(result.state).toBe('unavailable');
      expect(result.gaps).toContain('member-identity-unavailable');
    });

    it('rejects conflicting physical identities at the same lexical path', () => {
      const current = index([config('A'), config('B', [])]);
      const result = observe(
        current,
        file('source', 'retargeted-physical-file'),
      );
      expect(result.state).toBe('unavailable');
      expect(result.members).toEqual([]);
      expect(result.gaps).toContain('lexical-identity-conflict');
    });

    it('rejects stale target, member, config and discovery proofs independently', () => {
      const baseline = index([config('A'), config('B', [])]);
      const stale = {
        ...file(),
        physical: {
          ...file().physical,
          state: 'verified' as const,
          canonicalId: 'physical-source',
          evidenceId: 'old',
          inputVersion: 'v0',
        },
      };
      expect(observe(baseline, stale).state).toBe('unavailable');
      expect(
        observeConfigs([config('A', [stale]), config('B', [])], file()).state,
      ).toBe('unavailable');
      expect(
        observeConfigs(
          [{ ...config('A'), inputVersion: 'v0' }, config('B', [])],
          file(),
        ).members,
      ).toEqual([]);
      expect(
        observe(
          {
            ...baseline,
            universe: { ...baseline.universe, discovery: 'open' },
          },
          file(),
        ).state,
      ).toBe('unavailable');
    });

    it('does not count a stale canonical alias as positive coverage', () => {
      const staleAlias: NativeFileIdentity = {
        lexicalPath: 'alias',
        physical: {
          state: 'verified',
          canonicalId: 'physical-source',
          evidenceId: 'old',
          inputVersion: 'v0',
        },
      };
      const result = observeConfigs(
        [config('A', [staleAlias]), config('B', [])],
        file(),
      );
      expect(result.members).toEqual([]);
      expect(result.state).toBe('unavailable');
    });

    it.each([
      'stale-member',
      'stale-target',
      'unverified-member',
      'unverified-target',
    ])(
      'does not count %s lexical matches as confirmed membership',
      (condition) => {
        const invalid: NativeFileIdentity = condition.startsWith('stale')
          ? {
              ...file(),
              physical: {
                state: 'verified',
                canonicalId: 'physical-source',
                evidenceId: 'old-identity',
                inputVersion: 'v0',
              },
            }
          : {
              ...file(),
              physical: {
                state: 'unavailable',
                reason: 'identity unavailable',
              },
            };
        const member = condition.endsWith('member') ? invalid : file();
        const target = condition.endsWith('target') ? invalid : file();
        const result = observeConfigs(
          [config('A', [member]), config('B', [member])],
          target,
        );
        expect(result.members).toEqual([]);
        expect(result.state).toBe('unavailable');
      },
    );

    it('does not promote one current member and one stale lexical hit to ambiguity', () => {
      const stale: NativeFileIdentity = {
        ...file(),
        physical: {
          state: 'verified',
          canonicalId: 'physical-source',
          evidenceId: 'old-identity',
          inputVersion: 'v0',
        },
      };
      const result = observeConfigs([config('A'), config('B', [stale])]);
      expect(result.members.map((member) => member.configId)).toEqual(['A']);
      expect(result.state).toBe('unavailable');
    });

    it('limits parse failures only through target-specific proven exclusions', () => {
      const failed: SourceConfigEnumeration = {
        configId: 'B',
        inputVersion: 'v1',
        state: 'failed',
        failureId: 'parse-failure',
        impact: { kind: 'unbounded' },
      };
      expect(observeConfigs([config('A'), failed], file()).state).toBe(
        'unavailable',
      );
      const excluded = {
        ...failed,
        impact: {
          kind: 'proven-exclusion' as const,
          evidenceId: 'validated-boundary',
          excludedCanonicalIds: ['physical-source'],
        },
      };
      expect(observeConfigs([config('A'), excluded], file()).state).toBe(
        'unique',
      );
      expect(
        observeConfigs(
          [config('A'), excluded],
          file('elsewhere', 'other-identity'),
        ).state,
      ).toBe('unavailable');
    });

    it('does not use duplicate entries or incomplete enumeration to prove unique', () => {
      expect(
        observeConfigs([config('A'), config('A'), config('B', [])], file())
          .state,
      ).toBe('unavailable');
      const incomplete = { ...config('B', []), complete: false };
      expect(observeConfigs([config('A'), incomplete], file()).state).toBe(
        'unavailable',
      );
    });

    it('does not use a closed universe from an earlier input version', () => {
      const current = index([config('A'), config('B', [])]);
      const result = observe(
        {
          ...current,
          universe: { ...current.universe, inputVersion: 'v0' },
        },
        file(),
      );
      expect(result.state).toBe('unavailable');
      expect(result.members).toEqual([]);
    });
    it('preserves the first canonical alias before a later lexical match', () => {
      const result = observeConfigs([
        config('A', [file('alias'), file()]),
        config('B', []),
      ]);
      expect(result.members).toEqual([
        {
          configId: 'A',
          membershipEvidenceId: 'members:A',
          match: 'canonical',
        },
      ]);
    });

    it('retains stale lexical conflicts beside a current canonical membership', () => {
      const stale: NativeFileIdentity = {
        lexicalPath: 'source',
        physical: {
          state: 'verified',
          canonicalId: 'old-target',
          evidenceId: 'old',
          inputVersion: 'v0',
        },
      };
      const result = observeConfigs([
        config('A', [stale, file('alias')]),
        config('B', []),
      ]);
      expect(result.members.map((member) => member.match)).toEqual([
        'canonical',
      ]);
      expect(result.state).toBe('unavailable');
      expect(result.gaps).toEqual([
        'member-identity-unavailable',
        'lexical-identity-conflict',
      ]);
    });
  },
);

it('does not retain caller-owned memberships behind a shallow frozen index', () => {
  const members = [file()];
  const coverage = Object.freeze(
    index([config('A', members), config('B', [])]),
  );
  const before = deriveNativeCoverage(coverage, file());
  expect(before.state).toBe('unique');
  members[0] = file('elsewhere', 'different-file');
  expect(deriveNativeCoverage(coverage, file()).state).toBe('uncovered');
  expect(before.state).toBe('unique');
});

describe('coverage-driven frontier contract', () => {
  it('expands local declaration roots with unique or shared coverage', () => {
    for (const configs of [
      [config('A'), config('B', [])],
      [config('A'), config('B')],
    ]) {
      const coverage = observeCoverage(configs, file());
      expect(
        decideNativeFrontier({
          root: true,
          kind: 'declaration',
          consumerConfigId: 'A',
          coverage,
        }),
      ).toEqual({ action: 'expand', basis: 'covered-declaration' });
    }
  });

  it('allows local declaration input analysis before discovery closes', () => {
    const current = index([config('A'), config('B')]);
    const coverage = deriveNativeCoverage(
      { ...current, universe: { ...current.universe, discovery: 'open' } },
      file(),
    );
    expect(coverage.state).toBe('ambiguous');
    expect(coverage.completeness).toBe('incomplete');
    expect(
      decideNativeFrontier({
        root: true,
        kind: 'declaration',
        consumerConfigId: 'A',
        coverage,
      }),
    ).toEqual({ action: 'expand', basis: 'covered-declaration' });
  });

  it('expands local declaration inputs despite unrelated coverage gaps', () => {
    const failed: SourceConfigEnumeration = {
      configId: 'B',
      inputVersion: 'v1',
      state: 'failed',
      failureId: 'parse-failure',
      impact: { kind: 'unbounded' },
    };
    const current = index([config('A'), config('B', [])]);
    const coverages = [
      observeCoverage([config('A')]),
      observeCoverage([config('A'), failed]),
      deriveNativeCoverage(
        { ...current, universe: { ...current.universe, discovery: 'open' } },
        file(),
      ),
    ];
    for (const coverage of coverages) {
      expect(coverage.state).toBe('unavailable');
      expect(coverage.members.map((member) => member.configId)).toEqual(['A']);
      expect(
        decideNativeFrontier({
          root: true,
          kind: 'declaration',
          consumerConfigId: 'A',
          coverage,
        }),
      ).toEqual({ action: 'expand', basis: 'covered-declaration' });
    }
  });

  it.each([
    [[], [], 'uncovered'],
    [[file()], [], 'same-owner-non-root'],
    [[], [file()], 'foreign-implementation'],
    [[file()], [file()], 'ambiguous-implementation'],
  ] as const)(
    'stops a non-root implementation without manufacturing an edge (%s, %s)',
    (a, b, reason) => {
      const coverage = observeCoverage(
        [config('A', [...a]), config('B', [...b])],
        file(),
      );
      expect(
        decideNativeFrontier({
          root: false,
          kind: 'implementation',
          consumerConfigId: 'A',
          coverage,
        }),
      ).toEqual({ action: 'stop', reason });
    },
  );

  it('retains uncovered declarations in the consumer and preserves root expansion', () => {
    const coverage = observeCoverage(
      [config('A', []), config('B', [])],
      file('lib.d.ts'),
    );
    expect(
      decideNativeFrontier({
        root: false,
        kind: 'declaration',
        consumerConfigId: 'A',
        coverage,
      }),
    ).toEqual({ action: 'expand', basis: 'consumer-declaration' });
    expect(
      decideNativeFrontier({
        root: true,
        kind: 'implementation',
        consumerConfigId: 'A',
        coverage,
      }),
    ).toEqual({ action: 'expand', basis: 'root' });
  });
});

function obligation(): NativeCompilationObligation {
  return {
    requestIds: ['request-A'],
    id: 'obligation',
    consumerContextId: 'locked-A',
    consumerConfigId: 'A',
    targetConfigId: 'B',
    rawReferenceFingerprint: 'refs1',
    existence: {
      state: 'present',
      proof: {
        kind: 'compiler-observation',
        contextId: 'locked-A',
        evidenceId: 'compiler-include-and-emit',
        ruleOrObservation: 'composite-unit-boundary',
      },
    },
    structure: {
      state: 'satisfied',
      contextId: 'locked-A',
      evidenceId: 'reference-redirect',
      rawReferenceFingerprint: 'refs1',
      mapping: {
        consumerConfigId: 'A',
        targetConfigId: 'B',
        redirectEvidenceIds: ['B-to-declaration'],
      },
    },
    artifact: { state: 'missing', evidenceId: 'output-absent' },
  };
}

describe('three independent compilation obligation axes', () => {
  it.each([
    'available',
    'missing',
    'stale',
    'unknown',
    'not-applicable',
  ] as const)(
    'does not confuse satisfied structure with %s artifacts',
    (state) => {
      const artifacts: Record<typeof state, DeclarationAvailability> = {
        available: {
          state: 'available',
          evidenceId: 'validated-output',
          producerInputFingerprint: 'b1',
          outputFingerprint: 'd1',
          validatedMappingId: 'mapping1',
        },
        missing: { state: 'missing', evidenceId: 'missing' },
        stale: { state: 'stale', evidenceId: 'input-drift' },
        unknown: { state: 'unknown', reason: 'existence alone' },
        'not-applicable': { state: 'not-applicable', reason: 'no-declaration' },
      };
      expect(
        summarizeCompilationObligation({
          ...obligation(),
          artifact: artifacts[state],
        }),
      ).toBe('already-satisfied');
    },
  );

  it('requires independent existence proof even when owner and reference mapping are known', () => {
    expect(
      summarizeCompilationObligation({
        ...obligation(),
        existence: {
          state: 'unknown',
          gapIds: ['owner-is-not-compiler-proof'],
        },
      }),
    ).toBe('unknown');
    const current = obligation();
    if (!('contextId' in current.structure)) throw new Error('fixture');
    expect(
      summarizeCompilationObligation({
        ...current,
        structure: { ...current.structure, state: 'unsatisfied' },
      }),
    ).toBe('required');
    if (current.existence.state === 'unknown') throw new Error('fixture');
    expect(
      summarizeCompilationObligation({
        ...current,
        existence: { ...current.existence, state: 'absent' },
      }),
    ).toBe('not-required');
  });

  it('does not borrow mapping/proof from a different target, context or raw references', () => {
    const current = obligation();
    if (!('contextId' in current.structure)) throw new Error('fixture');
    for (const change of [
      { contextId: 'pending-A' },
      { rawReferenceFingerprint: 'old-refs' },
      { mapping: { ...current.structure.mapping, targetConfigId: 'C' } },
    ]) {
      expect(
        summarizeCompilationObligation({
          ...current,
          structure: { ...current.structure, ...change },
        }),
      ).toBe('unknown');
    }
    if (current.existence.state === 'unknown') throw new Error('fixture');
    expect(
      summarizeCompilationObligation({
        ...current,
        existence: {
          ...current.existence,
          proof: { ...current.existence.proof, contextId: 'pending-A' },
        },
      }),
    ).toBe('unknown');
  });

  it('binds audited rules to their request while preserving independent compiler observation identities', () => {
    const current = obligation();
    expect(summarizeCompilationObligation(current)).toBe('already-satisfied');
    if (current.existence.state === 'unknown')
      throw new Error('Expected proof');
    for (const evidenceId of ['request-A', 'request-B']) {
      const bound = {
        ...current,
        existence: {
          ...current.existence,
          proof: {
            ...current.existence.proof,
            kind: 'audited-rule' as const,
            evidenceId,
          },
        },
      };
      expect(summarizeCompilationObligation(bound)).toBe(
        evidenceId === 'request-A' ? 'already-satisfied' : 'unknown',
      );
      expect(
        summarizeCompilationObligation({
          ...bound,
          existence: { ...bound.existence, state: 'absent' },
        }),
      ).toBe(evidenceId === 'request-A' ? 'not-required' : 'unknown');
    }
  });
});

function pending(): NativeEvidenceContext {
  return {
    id: 'pending-A',
    epoch: 'epoch1',
    collectionId: 'collection1',
    inputs: {
      typescriptVersion: '6.0.3',
      typescriptImplementation: 'ts-sha',
      toolchain: 'toolchain1',
      hostContract: 'bounded-v1',
      config: 'A',
      roots: 'roots1',
      options: 'options1',
      rawReferences: 'refs1',
      coverage: 'u1',
      sourceVersion: 'source1',
      compilationScope: 'source-options',
    },
    authority: { phase: 'pending', baseline: 'typescript' },
  };
}

function origin(
  context = pending(),
  source:
    | 'typescript-observation'
    | 'framework-candidate' = 'typescript-observation',
) {
  const provenance = {
    'typescript-observation': {
      source: 'typescript-observation',
      family: 'typescript',
    },
    'framework-candidate': { source: 'framework-candidate', family: 'vue' },
  } as const;
  return captureNativeEvidenceOrigin({ context, ...provenance[source] });
}

const selection = {
  state: 'selected' as const,
  context: pending(),
  family: 'typescript' as const,
  evidenceIds: ['native-baseline'],
  nextContextId: 'locked-A',
  nextCollectionId: 'collection2',
};

describe('pending/locked consumption eligibility', () => {
  it('leaves ambiguous or unavailable selection pending without reselecting', () => {
    const current = pending();
    for (const state of ['ambiguous', 'unavailable'] as const) {
      expect(
        lockNativeEvidenceContext(current, {
          state,
          candidateFamilies: ['typescript', 'vue'],
          evidenceIds: ['competing-candidates'],
        }),
      ).toEqual({
        state: 'conflict',
        reason: 'selection-undetermined',
      });
    }
    expect(
      lockNativeEvidenceContext(current, { ...selection, evidenceIds: [] }),
    ).toEqual({
      state: 'conflict',
      reason: 'selection-undetermined',
    });
    expect(current.authority.phase).toBe('pending');
    expect(
      lockNativeEvidenceContext({ ...current, epoch: 'epoch2' }, selection),
    ).toEqual({
      state: 'conflict',
      reason: 'stale-selection',
    });
  });

  it('rejects replaced locked selection evidence even when context IDs are unchanged', () => {
    const result = lockNativeEvidenceContext(pending(), selection);
    if (
      result.state !== 'collect-fresh' ||
      result.context.authority.phase !== 'locked'
    )
      throw new Error('fixture');
    const observed = origin(result.context);
    const changed = {
      ...result.context,
      authority: {
        ...result.context.authority,
        selectionEvidenceIds: ['different-selection'],
      },
    };
    expect(qualifyNativeEvidence(observed, changed, 'locked-fact')).toEqual({
      eligible: false,
      reason: 'stale-context',
    });
    expect(
      qualifyNativeEvidence(observed, result.context, 'locked-fact'),
    ).toEqual({ eligible: true });
  });

  it('permits Native baseline observation and ownership selection without initializing a final checker', () => {
    expect(
      qualifyNativeEvidence(origin(), pending(), 'pending-observation'),
    ).toEqual({ eligible: true });
    expect(
      qualifyNativeEvidence(origin(), pending(), 'ownership-selection'),
    ).toEqual({ eligible: true });
    expect(
      qualifyNativeEvidence(origin(), pending(), 'locked-fact').eligible,
    ).toBe(false);
  });

  it('keeps framework candidates confined to selection', () => {
    const candidate = origin(pending(), 'framework-candidate');
    expect(
      qualifyNativeEvidence(candidate, pending(), 'ownership-selection')
        .eligible,
    ).toBe(true);
    expect(
      qualifyNativeEvidence(candidate, pending(), 'pending-observation')
        .eligible,
    ).toBe(false);
    expect(
      qualifyNativeEvidence(candidate, pending(), 'locked-fact').eligible,
    ).toBe(false);
  });

  it('requires a fresh collection after locking, including a TypeScript-to-TypeScript lock', () => {
    const old = origin();
    const result = lockNativeEvidenceContext(pending(), selection);
    if (result.state !== 'collect-fresh') throw new Error('fixture');
    expect(qualifyNativeEvidence(old, result.context, 'locked-fact')).toEqual({
      eligible: false,
      reason: 'stale-context',
    });
    expect(
      qualifyNativeEvidence(
        origin(result.context),
        result.context,
        'locked-fact',
      ),
    ).toEqual({ eligible: true });
    expect(() =>
      Object.assign(old.context.authority, { phase: 'locked' }),
    ).toThrow(TypeError);
  });

  it.each([
    'roots',
    'options',
    'rawReferences',
    'coverage',
    'sourceVersion',
    'toolchain',
    'typescriptVersion',
    'typescriptImplementation',
    'hostContract',
    'config',
  ] as const)(
    'revokes an observation when %s changes even if the caller reuses the context ID',
    (key) => {
      const current = pending();
      expect(
        qualifyNativeEvidence(
          origin(current),
          { ...current, inputs: { ...current.inputs, [key]: 'changed' } },
          'ownership-selection',
        ).eligible,
      ).toBe(false);
    },
  );

  it('revokes epoch/phase/collection changes and reports lock conflicts instead of looping', () => {
    const current = pending();
    for (const change of [
      { epoch: 'epoch2' },
      { collectionId: 'collection2' },
      { id: 'another-context' },
    ]) {
      expect(
        qualifyNativeEvidence(
          origin(current),
          { ...current, ...change },
          'ownership-selection',
        ).eligible,
      ).toBe(false);
    }
    expect(
      lockNativeEvidenceContext(current, {
        ...selection,
        nextCollectionId: 'collection1',
      }),
    ).toEqual({ state: 'conflict', reason: 'identity-reused' });
    const result = lockNativeEvidenceContext(current, selection);
    if (result.state !== 'collect-fresh') throw new Error('fixture');
    expect(
      lockNativeEvidenceContext(result.context, {
        ...selection,
        family: 'vue',
      }),
    ).toEqual({ state: 'conflict', reason: 'already-locked' });
    expect(
      qualifyNativeEvidence(
        origin(current),
        { ...current, authority: result.context.authority },
        'locked-fact',
      ).eligible,
    ).toBe(false);
  });

  it('does not let a native observation impersonate locked framework semantics', () => {
    const result = lockNativeEvidenceContext(pending(), {
      ...selection,
      family: 'vue',
    });
    if (result.state !== 'collect-fresh') throw new Error('fixture');
    expect(
      qualifyNativeEvidence(
        origin(result.context),
        result.context,
        'locked-fact',
      ).eligible,
    ).toBe(false);
    const framework = captureNativeEvidenceOrigin({
      context: result.context,
      source: 'framework-semantic',
      family: 'vue',
    });
    expect(
      qualifyNativeEvidence(framework, result.context, 'locked-fact').eligible,
    ).toBe(true);
  });
});

function snapshot(): NativeEvidenceSnapshot {
  return {
    version: 5,
    run: 'completed',
    contexts: [pending()],
    coverageIndexes: [],
    coverage: [],
    requests: [],
    traversal: [],
    resolutions: [],
    relations: [],
    obligations: [],
    completeness: [],
    failures: [],
  };
}

describe('immutable, non-executable native evidence publication', () => {
  it('requires gaps to identify a failure and excludes input drift from normal stops', () => {
    type Stop = Extract<NativeCompletenessPartition, { state: 'proven-stop' }>;
    type Gap = Extract<NativeCompletenessPartition, { state: 'gap' }>;
    expectTypeOf<Gap['failureId']>().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<Stop['stopReason'], 'input-drift' | 'unsupported-observation'>
    >().toEqualTypeOf<never>();
  });

  it('copies and deeply freezes input rather than freezing the producer or leaking aliases', () => {
    const producer = snapshot();
    const published = freezeNativeEvidence(producer);
    Object.assign(producer.contexts[0]!.inputs, { roots: 'changed' });
    expect(published.contexts[0]!.inputs.roots).toBe('roots1');
    expect(() =>
      Object.assign(published.contexts[0]!.inputs, { roots: 'changed' }),
    ).toThrow(TypeError);
    expect(() => {
      (published.contexts as NativeEvidenceContext[]).push(pending());
    }).toThrow(TypeError);
  });

  it('copies repeated sibling aliases without treating them as cycles', () => {
    const member = { state: 'ready' };
    const published = freezeNativeData({ first: member, second: member });
    expect(published.first).toEqual({ state: 'ready' });
    expect(published.second).toEqual(published.first);
    expect(published.first).not.toBe(published.second);
    member.state = 'changed';
    expect(published.first.state).toBe('ready');
    expect(() => Object.assign(published.second, { state: 'changed' })).toThrow(
      TypeError,
    );
  });

  it.each([new Map(), new Set(), () => {}, NaN])(
    'rejects non-DTO values (%s)',
    (value) => {
      expect(() =>
        freezeNativeEvidence({
          ...snapshot(),
          value,
        } as NativeEvidenceSnapshot),
      ).toThrow(TypeError);
    },
  );

  it('rejects cycles and accessors without invoking a compiler handle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      freezeNativeEvidence({ ...snapshot(), cyclic } as NativeEvidenceSnapshot),
    ).toThrow('Cyclic');
    let isInvoked = false;
    const handle = {
      get program() {
        isInvoked = true;
        return {};
      },
    };
    expect(() =>
      freezeNativeEvidence({ ...snapshot(), handle } as NativeEvidenceSnapshot),
    ).toThrow('accessors');
    expect(isInvoked).toBe(false);
    const array: unknown[] = [];
    Object.defineProperty(array, 0, {
      enumerable: true,
      get() {
        isInvoked = true;
        return {};
      },
    });
    expect(() =>
      freezeNativeEvidence({ ...snapshot(), array } as NativeEvidenceSnapshot),
    ).toThrow('accessors');
    expect(isInvoked).toBe(false);
  });
});

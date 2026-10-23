# Configuration design mental model

[English](./configuration-design.md) | [简体中文](./zh/configuration-design.md)

**Expose core capabilities directly, nest complexity within domains, group shared responsibilities, and prefer documented defaults.** Configuration should help users express their intent without first learning Limina's internal architecture. Every additional nesting level must provide semantic value, not merely visual order.

This page owns configuration design rationale and review criteria. The [public types](../../packages/limina/src/config/root-types.ts) and [runtime schema](../../packages/limina/src/config/schema/root.ts) define accepted configuration; the [configuration reference](../../docs/en/config/index.md) owns usage and field details. These principles are design guidance, not a claim that one configuration shape is a universal community best practice.

## Four principles

### Expose core capabilities directly

Keep independently understandable governance domains such as `graph`, `source`, `proof`, `package`, and `release` discoverable at the top level. A user looking for source checks can enter `source` without first learning an additional `checks` category. Do not add a wrapper solely because several capabilities all perform checks.

The intended benefit is lower discovery cost: the next option should be visible from the concept the user already knows. Both flat and nested configurations can offer TypeScript completion; flatness does not create that capability. [defineConfig](../../packages/limina/src/config/define.ts) supplies type guidance while preserving the input. Nesting should narrow a meaningful choice, rather than make the user guess where a feature is hidden.

### Nest complexity within its domain

Keep related details together, for example `graph.rules`, `source.knip`, and `cache.dependencies`. Do not flatten every leaf merely to shorten its path: that loses ownership and increases top-level ambiguity.

Scope matters as much as feature names. [Package options](../../packages/limina/src/config/package-types.ts) attach `attw` to an output entry; moving it to a global switch would require new application and override semantics, not just a shorter spelling. Use simple enablement plus detailed object options only where that capability already has a meaningful on/off contract; do not force every configuration domain into `boolean | object`.

### Group shared responsibilities

`scope` groups the inputs that establish governance boundaries and checker ownership: `scope.regions` selects structural regions, `scope.source` selects governed source, and `scope.checkers` selects checker entries and ownership. The grouping explains their shared role without making their selection semantics interchangeable.

In particular, `scope.source` answers which source needs governance coverage; top-level `source` configures source-check policy. Source selectors cannot activate an ungoverned region, and checker-entry exclusions do not truncate an already selected reference closure. Keep these distinctions visible in types, field comments, and the [source boundary](../../docs/en/config/source-boundary.md) and [checker](../../docs/en/config/checkers.md) references.

### Prefer documented defaults

Use validated project facts and established defaults wherever they already determine behavior. Do not require users to repeat workspace declarations, automatic checker discovery, or default source patterns merely to make configuration look complete. Defaults are bounded by supported semantics; they are not permission to guess missing governance authority.

Expose complexity when customization becomes necessary. Omission should preserve the relevant default, but an explicit empty object or array is not automatically equivalent to omission. For example, [source selection](../../docs/en/config/source-boundary.md) gives `...` a specific default-expansion meaning, and the [cache schema](../../packages/limina/src/config/schema/root.ts) requires `dependencies` in object-form cache configuration. Examples must respect those contracts instead of filling every domain with `{}`.

## Applying the model to Limina

Keep governance scope, checking policy, workflow definition, concurrency control, and analysis-cache reuse distinguishable. `pipelines` answers which steps run and in what order; concurrency options control parallel work; `cache` controls persistent analysis reuse, not every checker-owned cache. Their mechanisms remain owned by the [pipeline reference](../../docs/en/config/pipelines.md), [concurrency reference](../../docs/en/config/execution.md), and [lifecycle record](./lifecycle.md).

The current [public type](../../packages/limina/src/config/root-types.ts) and [consumer](../../packages/limina/src/execution/config.ts) use the name `concurrency`. This is a source-level fact, not a requirement that an otherwise understandable field must be renamed to satisfy this model. A rename or regrouping needs a concrete usability or semantic benefit sufficient to justify migration cost. This record does not establish that a migration has passed runtime acceptance or shipped in a release.

Public grouping need not mirror internal providers, analysis phases, or cache epochs. Conversely, moving a public option must not change its authority or consumers: [package output declarations](../../packages/limina/src/core/workspace/validated/outputs/collection.ts), for example, affect workspace output boundaries even though they are configured under `package`. Preserve path bases, default behavior, checker ownership, pipeline order, and cache validity unless a separate behavior change is explicitly intended.

## Configuration-driven default check

A valid own top-level `graph`, `source`, or `proof` declaration opts its governance task into the independent default plan. `scope` remains input and Checker authority. Both Checker tasks, workspace validation, Core analysis, graph materialization and execution admission remain mandatory. Explicit pipelines and standalone checks retain their existing contracts; package/release do not join the default.

Use `graph: { rules: {} }` and `proof: { allowlist: [] }` for base governance without additional rules or exceptions. This reuses meaningful existing fields rather than introducing a Proof coverage switch. Source subcapabilities remain independent: `source: { knip: false }` retains base governance. Empty domains, unknown fields and explicit undefined are rejected. Native property validation precedes Zod shape validation so non-enumerable top-level domains survive, while accessors, Proxies, inherited and hidden nested fields cannot make selection differ from consumption. Dynamic computation belongs in the config factory; no transforms or defaults replace returned values.

Existing Zod and Node property descriptors provide the required mechanism without a dependency or workflow abstraction. Structural Graph/Knip failures now belong to configuration loading; workspace-dependent semantic diagnostics stay with their domain. The preserved invalid inputs in `fixtures/config-errors` and replacement semantic detector fixtures guard that boundary.

Evidence: [configuration tests](../../packages/limina/src/__tests__/config.spec.ts), [default workflow CLI tests](../../packages/limina/integration/tests/default-check-workflow.spec.ts), [cache process tests](../../packages/limina/integration/tests/config-process-cache.spec.ts).

## Reviewing a new option or regrouping

Before extending the configuration, answer three questions:

1. **What is the user's decision and its scope?** Identify whether it affects shared governance, one checking domain, or one concrete entry; choose the nearest meaningful owner.
2. **Does the option need to exist?** Prefer an established default or reliable project fact when it already expresses the intent. Do not invent inputs, overrides, or generic wrappers for hypothetical future needs.
3. **What does the new path improve?** Explain its discovery or semantic benefit against additional nesting, top-level noise, and compatibility cost. A smaller number of top-level fields is not itself a benefit.

Keep accepted values and rejection predicates in executable contracts; keep the rationale here. Follow the [architecture workflow](./architecture-workflow.md) for semantic impact and the [development workflow](./development-workflow.md) for validation. Minimal necessary change is preferable to reorganizing a coherent public API for uniformity alone.

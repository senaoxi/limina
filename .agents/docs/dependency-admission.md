# Dependency Admission

[English](./dependency-admission.md) | [简体中文](./zh/dependency-admission.md)

This record defines the repository-wide admission policy for evaluating third-party reuse during requirements analysis and for adding, replacing, or updating npm dependencies.

This policy governs candidate selection and how dependencies are introduced. It does not automatically classify all existing dependencies as compliant or non-compliant without a separate review. Approval of a package does not automatically approve future versions, new use cases, or additional execution privileges.

The policy distinguishes hard admission gates from comparison signals. A candidate that clearly fails any applicable hard gate must not be introduced. When evidence required to decide a hard gate is missing, the candidate remains pending rather than passing by default. Comparison signals are used only among candidates that have passed all applicable hard gates.

## Evaluation Subject and Scope

Admission applies to a specific package, exact version, publication source, usage pattern, and resolved dependency graph. It is not a permanent endorsement of a package name or upstream project.

The evaluation must identify which workspace package will declare the dependency, which APIs or entry points will be used, during which installation, build, test, release, or runtime phases it will execute, and which environments it must support.

Security, provenance, license, and compatibility review must cover relevant transitive dependencies newly introduced or changed by the candidate, including optional dependencies, peer dependencies, native components, and prebuilt binaries that are actually installed, executed, or distributed in applicable environments.

Necessity, ecosystem adoption, and overall maintenance cost are evaluated at the candidate-solution level. A complete package-selection analysis is not required independently for every transitive dependency. The depth of manual review should be proportional to execution privilege, input trust, distribution scope, and replacement difficulty.

Copying, vendoring, or bundling third-party code into the repository does not remove provenance, licensing, security, or maintenance responsibilities. Executing a tool temporarily without adding it to `package.json` must not be used to bypass provenance or execution-security review.

## Requirements Analysis and Reuse

Before planning a local implementation, first determine whether existing platform, workspace, or toolchain capabilities can satisfy the requirement. Then evaluate suitable open-source packages that may satisfy the requirement directly or through a well-bounded adapter.

Define the required behavior and non-negotiable constraints before comparing candidates. The comparison should cover normal behavior, failure semantics, input boundaries, resource lifetime, compatibility, integration scope, and long-term maintenance cost. A package must not be treated as behaviorally equivalent merely because its description resembles the requirement.

Prefer reusing a third-party package when it satisfies this policy and has reasonable long-term cost. Preference for reuse does not waive any hard gate and does not require expanding the requirement, changing established architectural boundaries, or weakening repository constraints merely to fit a third-party abstraction.

If the repository needs only a small, stable, and well-bounded capability from a package, and the required behavior can be understood, tested, and maintained locally at lower long-term cost, prefer implementing the minimum required capability instead of accepting the package's full dependency and upgrade surface.

When choosing a local implementation, document which reasonable candidates were evaluated, why reuse or adaptation was insufficient or more expensive, and which behavior the local implementation does and does not support. The ecosystem does not need to be exhaustively surveyed, but obvious applicable existing capabilities must not be skipped.

Do not reimplement mature cryptographic primitives, security mechanisms, protocols, parsers, standards-compliance logic, or other high-risk behavior merely to reduce dependency count. Lines of code or number of features are not substitutes for evaluating semantic complexity and maintenance cost.

When deriving from or copying a third-party implementation, verify its license, attribution, and redistribution obligations. Copied code should retain its source, the adopted version or commit, required notices, and responsibility for future fixes.

A candidate whose necessity cannot be established does not pass admission.

## Admission Order and Evidence

Evaluate candidates in the following order:

1. Define the requirement, usage boundary, acceptance criteria, and why existing capabilities are insufficient.
2. Check provenance, licensing, deprecation status, and known risks, and eliminate clearly unsuitable candidates.
3. Validate the actual published package in a controlled environment for functionality, compatibility, execution behavior, and cost.
4. Compare candidates that pass all hard gates and select the solution that satisfies the requirement with the lowest reasonable long-term dependency and maintenance cost.

Evidence must correspond to the version that would actually be adopted. The published package contents, source and tests for that version, official documentation, registry metadata, and reproducible validation results should be reconciled with each other. Behavior on the current upstream default branch must not be used by itself to prove that a released version provides the same behavior.

Record the review date, version, source, and relevant commands and results. Source inspection is not runtime validation. Checks that were not executed, unavailable data, and environments that were not covered must be stated explicitly.

Low-risk dependencies may use a concise admission summary. Dependencies that process untrusted input, access sensitive data, execute with elevated privileges, download content during installation, contain native components, or become part of core public interfaces require additional validation proportional to their risk.

## Functionality, Compatibility, and Integration Boundaries

A candidate must satisfy the required behavior and be compatible with the environments the repository claims to support. Applicable dimensions include Node.js, module format, TypeScript, browsers, frameworks, operating systems, CPU architectures, and required system libraries.

Validation must cover the entry points, configuration, and failure paths that will actually be used. Successful installation, successful type checking, or a working README example does not independently prove correct integration.

When type support is required, verify that declarations correspond to the runtime API and work under the repository's supported compiler and module-resolution modes. The dependency must not rely on undeclared workspace dependencies, accidental dependency hoisting, or additional files that happen to exist only in the development environment.

Prefer upstream APIs that are explicitly supported as public interfaces. If the integration requires unstable internals, deep imports, patches, or a fork, document the necessity, upgrade risk, and maintenance responsibility separately. Those costs must not be hidden as ordinary adaptation.

Add an internal adapter only when it materially isolates external types, error models, resource lifetimes, or replacement cost. Do not create wrappers around simple calls when they provide no meaningful boundary.

Introducing a candidate must not silently narrow the repository's existing support range. Raising the minimum runtime version, removing platform support, or changing public interfaces requires a separate compatibility decision.

A candidate that cannot satisfy the required semantics or support boundaries does not pass admission.

## Provenance and Supply Chain

Verify the relationship among the package name, scope, registry, project repository, and publisher to establish that the selected version was published by the expected project. Similar names, download counts, or organization names are not sufficient evidence of provenance.

Review the package as actually distributed. Inspect relevant entry files, licenses, installation scripts, and bundled components. Source and published artifacts are not required to be byte-identical, but differences caused by building, generation, or packaging must be explainable. Unresolved unexpected contents or source inconsistencies block admission.

The resolved dependency graph must be fixed using the repository's selected lockfile and integrity-verification mechanisms. Integrity verification can establish that retrieved content matches the recorded artifact; it does not independently establish that the artifact itself is trustworthy.

When registry signatures, provenance attestations, or other trusted publication metadata are available for the candidate, validate them with applicable tooling and confirm that they refer to the expected source. If verification evidence is expected to be valid but verification fails, the failure must not be ignored.

Absence of provenance metadata is not universally disqualifying, but it must be considered together with package risk, release history, and other provenance evidence. Admission should remain pending when the source cannot be established with reasonable confidence.

Binaries, scripts, or other executable content downloaded during installation or runtime are part of the same review scope and must have an identifiable source together with an appropriate version-pinning or content-verification mechanism.

Follow the repository's existing release-age controls, registry restrictions, script-approval rules, and trust policies. Global protections must not be silently disabled to accommodate a candidate.

## Security and Execution Behavior

Check the selected version and relevant transitive dependencies for known vulnerabilities, security advisories, and malicious-package reports, and determine whether the repository's actual usage satisfies the conditions under which each issue can be triggered.

A version confirmed to be malicious or compromised must not be introduced. A high- or critical-severity vulnerability that applies to the repository and lacks an effective mitigation does not pass admission. The absence of a fixed release is not, by itself, a reason to accept the risk.

Other known vulnerabilities must also be evaluated. Record their impact, exploitability conditions, existing protections, and residual risk, and require an explicit decision from the responsible maintainer when acceptance is necessary. When a compatible fixed version exists, prefer the fixed version.

A vulnerability-database match does not prove that a vulnerability is exploitable in the repository. Conversely, a clean scan does not prove that the package is secure. Claims that an issue does not apply or is mitigated must be supported by evidence related to the vulnerability mechanism; "production code does not directly import it" is not sufficient by itself.

The review scope includes installation, build, test, and release environments. A development-only dependency may be exempt from production artifact-size gates, but it is not exempt from security, provenance, licensing, or maintenance requirements.

Filesystem access, network access, subprocess execution, dynamic code execution, telemetry, and credential access required by the candidate must be proportionate to its purpose and compatible with repository boundaries. High-risk behavior that is unrelated to the package's purpose, cannot be explained, or cannot be reasonably controlled blocks admission.

If installation scripts or other initialization code must execute, review why execution is necessary before granting it. Initial validation of unreviewed execution behavior must not expose production credentials, release privileges, or unrelated sensitive capabilities.

Suppressing an alert, allowing a script, or bypassing a release-age restriction does not resolve the underlying risk. Such configuration must have an explicit scope, rationale, owner, and re-evaluation condition.

## License Compatibility

A candidate must have a clear legal basis for use and a license compatible with the repository's intended use, modification, publication, and distribution model.

Prefer permissive licenses from the [supported license list][supported-licenses], which is shared with the bundled-code license gate. Identify applicable notices, attribution requirements, modification notices, patent terms, and redistribution conditions, and confirm that the repository can satisfy them.

License review must cover the distributed package for the selected version, its corresponding source, and relevant bundled components. The license on the current upstream default branch does not automatically establish the license of a historical release. Likewise, the parent package's license does not replace review of third-party code bundled within it.

For multiple-license expressions, distinguish licenses that provide alternative choices from obligations that apply together, and record the licensing path actually relied upon. If automated tooling cannot identify a license, inspect the original licensing material. An `unknown` scanner result does not by itself prove that no license exists, and it must not be treated as implicitly compatible.

A candidate does not pass admission when licensing is absent or ambiguous, licensing information for the same version contains unresolved conflicts, the license is incompatible with the intended use, or the repository cannot meet its obligations.

Agents must not create an implicit exception for reciprocal, source-disclosure, or other non-permissive licenses. Before adopting such a license, explain the concrete obligations and obtain explicit maintainer review. Approval does not override legal compatibility or compliance obligations.

Licenses and notices that must accompany distributed artifacts must be incorporated into the release process rather than existing only in the admission discussion.

## Deprecated Versions and Maintenance Status

The exact version selected as a direct dependency must not be marked `deprecated` in the npm registry. A deprecated direct candidate version immediately fails admission and does not participate in comparison.

Do not reject an entire project merely because unrelated historical versions were deprecated, provided that the selected version remains supported and the deprecation rationale does not apply to it. Record the selected version, review date, deprecation status, and any replacement guidance published by the maintainers.

When a newly introduced or changed transitive dependency is marked `deprecated`, inspect the reason and its practical impact. Deprecation caused by security issues, abandoned maintenance, or unsupported compatibility boundaries must be handled through the corresponding hard gate. Migration or rename notices should be documented but do not automatically invalidate the entire solution.

A deprecated implementation must not be hidden behind another wrapper package or indirect dependency merely to avoid reviewing it as the effective candidate.

A candidate must have maintenance credibility appropriate to its risk. Evaluate the support status of the adopted release line, handling of valid issues, compatibility and security fixes, tests, publication source, and identifiable maintenance responsibility.

Release frequency, issue count, and maintainer count do not independently determine admission. Mature packages may need few releases, and a single-maintainer project or a `0.x` version does not automatically fail.

When a project is archived or has not released for a long time, determine whether it moved elsewhere, whether its functionality is effectively stable, and whether a credible path still exists for fixes and releases. A project that has explicitly stopped being maintained without a credible successor, or leaves important security, correctness, or compatibility defects unresolved, must not be admitted.

When otherwise comparable candidates satisfy the same requirements, prefer the one with more reliable maintenance response, more stable publication practices, and a clearer upgrade path.

## Production Artifacts and Other Costs

Production artifact-size gates apply to dependencies that actually enter or constitute browser, client, edge, server, CLI, or other delivered artifacts. Applicability is determined by actual delivery behavior, not solely by the field in which the dependency appears in `package.json`.

Before measuring, define the delivery unit, affected entry points, baseline version, and measurement method. Unrelated applications, workspace packages, or static assets must not be used to dilute the impact of the dependency being introduced.

Use the comparable production build before introduction as the baseline:

```text
absolute increase = size after introduction - baseline size
relative increase = absolute increase / baseline size
```

Record the baseline size, resulting size, absolute increase, and percentage increase. Both measurements must use the same production configuration, entry points, tool versions, optimization settings, and compression basis.

Measure actual built or delivered artifacts rather than using the package size reported by an npm page as a substitute. For browser workloads, distinguish initial-load impact from lazy-loaded impact. For server and CLI workloads, include externalized dependencies, resources, and native components that must actually be delivered.

For libraries published to npm, separately record the package's own packed/unpacked size, relevant installation-dependency increase, and, where appropriate, representative consumer-build impact. A small package tarball does not prove a small consumer cost, and installed size must not be treated as equivalent to browser bundle impact.

Apply the following production artifact-size policy:

| Relative increase          | Policy                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Below 15%                  | Do not reduce candidate weight because of this size metric                                                                 |
| 15% through 30%, inclusive | Reduce candidate weight; before acceptance, evaluate narrower imports, tree shaking, lazy loading, or smaller alternatives |
| Above 30%                  | Admission fails; other comparison signals must not offset the failure                                                      |

The threshold applies to the actual incremental impact of the candidate and its newly reachable transitive dependencies. For replacements, evaluate the net result after the full replacement. A previous dependency that remains necessary for another use must not be assumed to have been removed.

A set of dependencies required together to provide one capability must be evaluated as one unit and must not be split across changes to evade the threshold. Independent delivery units should be evaluated separately rather than averaged together to hide a regression in one unit.

Relative thresholds do not replace existing repository budgets for absolute size, startup time, memory, or other performance characteristics. A candidate that violates an applicable existing budget still fails admission. If the baseline is zero or no comparable delivery unit exists, do not record the increase as zero; establish an approved measurement baseline or independent budget before deciding admission.

Development-only dependencies that do not enter delivered artifacts are exempt from the production artifact-size percentage gate, but installation and download cost, CI time, caching impact, native-build requirements, and routine development overhead should still be considered.

## Comparison Signals

After all applicable hard gates have passed, compare how candidates satisfy the requirement, adaptation complexity, upgrade difficulty, dependency surface, and long-term maintenance cost. Functionality beyond the current requirement is not automatically an advantage.

npm weekly download count is a directional ecosystem-adoption signal. When candidates have comparable purposes, capability scope, and other important characteristics, consistently higher download volume increases candidate weight.

Record the data source, date range, and current complete reporting week, and inspect recent trends when data is available. Do not rely on a single anomalous week. Download counts must not be interpreted directly as unique users, number of reviewers, or proof that a newly released version has already received substantial real-world validation.

Download count has no independent passing threshold, and inability to obtain download data is not itself a hard failure. Stars, community discussion, adoption by well-known projects, and security scores are likewise supporting evidence only and cannot override failures in provenance, security, licensing, compatibility, or other hard gates.

A production artifact increase between 15% and 30%, inclusive, must reduce candidate weight. When other conditions are comparable, prefer candidates with more reliable maintenance, simpler integration, and lower upgrade and exit costs.

Do not replace gate-by-gate judgment with an uncalibrated composite score. Higher download counts must not automatically compensate for materially greater adaptation, runtime, or maintenance cost.

## Introduction Validation and Decision Record

Before admission, validate the actual release that would be adopted for installation, functionality, compatibility, and build behavior at a depth proportional to its risk, and retain relevant regression coverage. Reuse existing tests and CI capabilities rather than creating a separate process for every dependency.

Declare the dependency in the workspace package that actually uses it and in the appropriate dependency field. Do not rely on undeclared transitive dependencies, and do not hide runtime requirements or consumer costs by incorrectly placing dependencies in `devDependencies`, `optionalDependencies`, or `peerDependencies`.

Commit the manifest, lockfile, required configuration, and tests that correspond to the introduction. Validation must follow the repository's established package manager, version policy, and reproducible-installation rules.

For published libraries or tools, perform independent consumer or installation validation when warranted by risk so that the workspace environment does not hide missing dependencies, incorrect exports, declaration-file references, or omitted published files. The repository's own lockfile and root-level overrides must not be treated as guarantees that downstream consumers will resolve the same dependency graph.

The admission record may live in the relevant pull request or an existing decision record; a duplicate standalone ledger is not required. At minimum, record:

| Item                         | Required information                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement and alternatives | Required behavior, why existing capabilities are insufficient, reasonable candidates evaluated, and the local-implementation trade-off  |
| Candidate and usage          | Package name, exact version, source, declaration location, entry points, and execution phases                                           |
| Gate conclusions             | Provenance, security, licensing, deprecation, maintenance, and compatibility conclusions, including reasons for any non-applicable item |
| Dependency changes           | Relevant transitive dependencies, scripts, binaries, peer or optional requirements, and material changes                                |
| Validation and cost          | Commands, actual results, measurement baseline, absolute and relative increases, and uncovered environments                             |
| Final decision               | Selection rationale, required restrictions, responsible maintainer or team, and conditions that trigger re-evaluation                   |

Long-lived adapters, patches, forks, overrides, and security-alert suppressions should record their purpose, applicable versions, upstream remediation status, and exit condition. Configuration that cannot be understood later from the repository must not be left unexplained.

## Continuous Re-evaluation

Admission is a scoped judgment about the current dependency and usage, not automatic approval of future versions. Routine updates may reuse requirement and architectural conclusions that remain valid, but relevant version and dependency changes must still be reviewed and applicable validation rerun.

Re-evaluate affected conclusions when any of the following changes: publisher or provenance, licensing, installation or download behavior, dependency surface, supported environments, critical APIs or public types, security advisories, deprecation status, or maintenance credibility.

Changes in usage can also require re-evaluation, for example when a dependency moves from trusted to external input, from development-only execution to production execution, or begins accessing credentials, networks, or release privileges.

If review discovers unrelated pre-existing issues, record and address them separately rather than automatically expanding the scope of the current change. Risks newly introduced or materially increased by the current change must not be waived merely because the dependency already existed elsewhere in the repository.

When removing or replacing a dependency, also remove declarations, adapter code, patches, authorization settings, alert suppressions, and release materials that are no longer necessary. Do not remove shared material that is still required by another consumer.

## Decision Summary

The hard admission gates are:

- the dependency has demonstrable necessity;
- required semantics and environment compatibility are satisfied;
- provenance is trustworthy;
- security and execution behavior comply with this policy;
- licensing is clear, compatible, and fulfillable;
- the exact directly selected version is not deprecated;
- maintenance status is credible;
- applicable production artifact-size and other existing budgets are not exceeded.

Only after all applicable hard gates pass should candidates be compared using ecosystem adoption, production artifact impact, maintenance responsiveness, and long-term total cost.

A candidate that clearly fails a hard gate must not be introduced. A candidate with insufficient evidence for a required determination remains pending. Only genuinely non-applicable checks may be marked not applicable, and the reason must be recorded.

If no candidate passes all applicable hard gates, report the unmet requirement and available alternatives. A local implementation remains subject to necessity and risk constraints and is not an automatic fallback.

Agents must not silently weaken admission gates, hide warnings, or change global protections to make a candidate pass. If the policy itself must change, propose that policy change separately and obtain an explicit decision rather than embedding the exception in a dependency introduction.

[supported-licenses]: ./license-policy.md#supported-licenses

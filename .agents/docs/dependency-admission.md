# Dependency admission

[English](./dependency-admission.md) | [简体中文](./zh/dependency-admission.md)

This record defines the repository-wide policy for considering a new third-party npm package or replacing an existing one. It governs candidate selection; it does not automatically declare every existing dependency compliant or non-compliant without a separate review.

The policy separates hard admission gates from weighted comparison signals. A candidate that fails a hard gate must not be added. Weighted signals are used only to compare candidates that have already passed every gate.

## Admission sequence

Evaluate candidates in this order:

1. Establish that the dependency is necessary.
2. Reject candidates that fail a hard gate.
3. Compare the remaining candidates by ecosystem adoption, production artifact impact, and maintenance activity.
4. Prefer the candidate that satisfies the required capability with the smallest durable dependency and maintenance cost.

## Necessity

A third-party package must solve a concrete requirement that the repository cannot reasonably satisfy with existing platform, workspace, or toolchain capabilities.

When the repository needs only a small, stable, and well-bounded part of a package, prefer implementing the minimum required capability locally instead of accepting the package's full dependency, upgrade, and supply-chain surface.

A local implementation is appropriate only when its behavior can be understood, tested, and maintained at lower long-term cost than the dependency. Do not replace established third-party implementations of security-sensitive algorithms, protocols, parsers, standards, or other high-risk behavior with an informal local implementation merely to avoid a dependency.

When learning from a third-party implementation, respect its license and attribution requirements. Do not copy source code into the repository unless the license permits that use and the repository can satisfy all resulting obligations.

A package without a demonstrated need fails admission.

## npm weekly downloads

npm weekly downloads are a weighted ecosystem-adoption signal. Among otherwise acceptable candidates, a higher sustained weekly download count receives greater weight because it indicates a broader installed base and a larger population likely to encounter compatibility or correctness problems.

Do not use one exceptional week as the sole comparison point. Record the current weekly count and inspect the recent trend when the data is available. Download volume has no standalone pass threshold and cannot override a failed hard gate.

High download volume does not prove that a package is secure, correctly licensed, actively maintained, or appropriate for this repository.

## Production artifact impact

This criterion applies only to dependencies that are included in a browser, client, edge, runtime, or other final production artifact. It does not apply to development-only dependencies that do not enter the delivered artifact.

Measure the candidate against the production build before the dependency is introduced:

```text
artifact increase = (size after introduction - baseline size) / baseline size
```

Use the same production configuration, entry points, optimization settings, and compression convention for both measurements. Measure the actual generated artifact rather than the package's installed size.

Apply the following policy:

- An increase below 15% does not reduce the candidate's weight on size grounds.
- An increase from 15% through 30% reduces the candidate's weight. Before accepting it, evaluate narrower imports, tree shaking, lazy loading, or a smaller alternative.
- An increase above 30% fails admission and the package must not be considered.

The size threshold applies to the incremental effect of the package and its newly reachable transitive dependencies.

## License compatibility

A candidate must declare a clear license that is compatible with the repository's use, modification, publication, and distribution model.

Prefer permissive licenses, including MIT, ISC, BSD-2-Clause, BSD-3-Clause, and Apache-2.0. Any required notices, attribution, patent terms, or redistribution conditions must be identified and satisfiable by the repository.

A package fails admission when:

- its license is missing or ambiguous;
- the npm metadata, source repository, and distributed package provide conflicting license information;
- its license is incompatible with the repository's intended use or distribution; or
- its obligations cannot be satisfied by the repository.

A reciprocal, source-disclosure, or otherwise non-permissive license must not be accepted by an agent as an implicit exception. Surface the license and its obligations to the user instead.

## Deprecated versions

The exact version proposed for installation must not be marked `deprecated` in the npm registry.

A deprecated candidate version fails admission immediately and must not participate in weighted comparison. A package is not rejected solely because an unrelated historical version was deprecated, provided that the selected current version remains supported and the deprecation reason does not apply to it.

When evaluating a candidate, record the selected version, its deprecation state, and any replacement guidance published by the maintainer.

## Maintenance state

A candidate must have an acceptable maintenance state. Evaluate maintenance from evidence that the project can still respond to relevant change, including:

- stable releases and meaningful source changes;
- responses to valid issues and pull requests;
- security and compatibility fixes;
- support for the repository's current Node.js, TypeScript, browser, framework, and operating-system boundaries;
- identifiable maintainers and a stable release source.

Release frequency alone is not reliability. A mature package may require infrequent releases, while a frequently published package may still be unstable or poorly maintained.

Reject a candidate when maintenance is no longer credible, including when relevant security or compatibility defects remain unattended, the supported runtime has moved beyond the package, the project is explicitly discontinued, or its maintainers and release source can no longer be established.

When otherwise acceptable candidates are comparable in capability, license, adoption, and artifact impact, prefer the package with more consistent and responsive maintenance activity.

## Decision summary

The following are hard admission gates:

- the dependency is demonstrably necessary;
- the selected version is not deprecated;
- the license is clear, compatible, and acceptable;
- the maintenance state is credible;
- a production dependency does not increase the final artifact by more than 30%.

After all hard gates pass, compare candidates using these weighted signals:

- higher sustained npm weekly downloads increase weight;
- a production artifact increase from 15% through 30% lowers weight;
- more consistent and responsive maintenance activity increases weight when the remaining conditions are comparable.

If no candidate passes every hard gate, do not add a package. Report the unmet requirement and the available alternatives instead of silently weakening this policy.

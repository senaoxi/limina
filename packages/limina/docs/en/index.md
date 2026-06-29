---
layout: home

hero:
  name: Limina
  text: Architecture governance for TypeScript monorepos
  tagline: Start with incremental type builds, then progressively enable architecture governance
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View Built-in Tasks
      link: /built-in-tasks
    - theme: alt
      text: View on GitHub
      link: https://github.com/senaoxi/docs-islands/tree/main/packages/limina

features:
  - icon: ⚙️
    title: Adopt incremental type builds
    details: >
      Reads existing TypeScript configuration and source dependency relationships to generate reusable type build configuration
      and derive a reliable build order. Supports TypeScript and Vue checker workflows, so teams can adopt it gradually
      without reshaping the repository.
    link: /getting-started
    linkText: Get started

  - icon: 🕸️
    title: Govern the dependency graph
    details: >
      Checks project references, access boundaries, and dependency declarations to find missing, redundant,
      or invalid relationships. As the repository grows, code relationships remain explicit, reviewable, and maintainable.
    link: /config/graph-rules
    linkText: Configure graph rules

  - icon: 🧱
    title: Protect source boundaries
    details: >
      Detects cross-package relative imports, unauthorized imports, missing dependency declarations, and file ownership issues.
      Package internals stay separated from intended public entry points, reducing boundary risks during refactors and releases.
    link: /config/source-boundary
    linkText: Configure source boundaries

  - icon: 🎯
    title: Verify check coverage
    details: >
      Finds files that are not covered by checks, covered more than once, or covered by the wrong check scope.
      Teams can see which code is already guarded and where quality blind spots still remain.
    link: /config/checkers
    linkText: Configure checker entries

  - icon: 🚦
    title: Compose check pipelines
    details: >
      Builds, dependency-graph checks, source-boundary checks, and source coverage checks can all run as independent tasks.
      Teams can compose workflows for local development, CI, or release gates, with tasks running concurrently when dependencies allow.
    link: /config/pipelines
    linkText: Configure pipelines

  - icon: 📦
    title: Add release checks
    details: >
      Before release, validate package metadata, type entry points, build output, and packed package contents to catch issues
      that may affect consumers. These checks provide an additional guardrail for release and prerelease workflows.
    link: /config/release-checks
    linkText: Configure release checks
---

---
layout: home

hero:
  name: Limina
  text: TypeScript project-reference graph compiler and architecture governance CLI
  tagline: Start with incremental build, then turn on architecture governance.
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Why Limina
      link: /why
    - theme: alt
      text: View on GitHub
      link: https://github.com/senaoxi/docs-islands/tree/main/packages/limina

features:
  - icon: 🧭
    title: Low-friction incremental build
    details: limina init adds limina:build and prepares a TypeScript build graph from existing tsconfig files and real imports, so the workspace gets tsc -b, tsgo, or vue-tsc incremental build value first.
    link: /getting-started
    linkText: Start build-first
  - icon: 🕸️
    title: Generate type graphs automatically
    details: Bring TypeScript, Vue, Svelte, and other checkers into one type relationship graph, so builds, checks, and diagnostics work from the same facts.
    link: /config/checkers
    linkText: Configure checkers
  - icon: 🧱
    title: Govern project references
    details: Use real imports to catch missing references, illegal dependencies, cross-runtime calls, and architecture rule violations before project relationships drift past declared boundaries.
    link: /built-in-tasks
    linkText: View graph checks
  - icon: 🛡️
    title: Protect package boundaries
    details: Block cross-package relative imports, missing dependencies, private entry escapes, and internal dependencies that bypass declared package boundaries, ensuring each package is accessed only through public entry points.
    link: /built-in-tasks
    linkText: View source checks
  - icon: 🎯
    title: Verify check coverage
    details: Align source files with TypeScript, Vue, Svelte, test, tools, docs, and other check scopes to find files that are uncovered, checked twice, or assigned to the wrong owner.
    link: /config/checkers
    linkText: Configure coverage
  - icon: 📦
    title: Validate published artifacts
    details: Inspect the npm tarball consumers actually install, and verify that package metadata, exports, types, runtime entries, and type resolution stay consistent.
    link: /config/package-checks
    linkText: Configure package checks
  - icon: 🚦
    title: Catch release risks early
    details: Check README, license, bundled files, missing files, source maps, and registry baseline differences before publishing to confirm the release contents match expectations.
    link: /config/release-checks
    linkText: Configure release checks
  - icon: 🧩
    title: Fit into existing workflows
    details: Integrate with local development, PR, CI, and release pipelines, and export scoped dependency graphs for architecture review when needed.
    link: /workflows
    linkText: Configure workflows
---

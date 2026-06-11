---
layout: home

hero:
  name: Limina
  text: Architecture governance for TypeScript monorepos
  tagline: Keep workspace exports, project references, package boundaries, Nx build edges, and published output telling the same story — caught in review and CI, not after release.
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
  - icon: 🔗
    title: See the real dependency graph
    details: When a PR adds a cross-package import, know whether it needs a project reference, a workspace dependency, an artifact build edge, or an architecture-rule change — before the graphs drift.
    link: /built-in-tasks
    linkText: Built-in tasks
  - icon: 🚧
    title: Keep packages in their lanes
    details: "Every cross-package edge must resolve through a declared dependency and the owner's public exports. Limina flags cross-package relative imports, undeclared dependencies, escaping #imports, mixed-owner tsconfigs, unused workspace dependencies and dead source modules, and — in strict mode — cross-package dependencies that skip the workspace: protocol."
    link: /built-in-tasks
    linkText: Source checks
  - icon: ✅
    title: Prove every file is checked
    details: Connect declaration leaves to strict local companions and framework checkers like vue-tsc and svelte-check, then prove no source file slips past every checker.
    link: /config/checkers
    linkText: Checker entries
  - icon: 📦
    title: Ship what consumers install
    details: Inspect the dist a consumer actually installs — package metadata, exports, and type resolution — with publint, Are the Types Wrong, and a runtime import boundary scan.
    link: /config/package-checks
    linkText: Package checks
  - icon: 🚀
    title: Publish with confidence
    details: Pack the npm tarball and check publish hygiene — required README and license files, no shipped source maps, and content compared against the npm registry baseline.
    link: /config/release-checks
    linkText: Release checks
  - icon: 🧩
    title: Compose checks into pipelines
    details: Combine Limina tasks and shell commands into named local, PR, and publish workflows. Limina complements task runners like Nx and Turborepo rather than replacing them.
    link: /workflows
    linkText: Workflows
---

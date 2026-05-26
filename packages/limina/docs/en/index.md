---
layout: home

hero:
  name: Limina
  text: Architecture governance for TypeScript monorepos
  tagline: Keep project references, package boundaries, checker coverage, and publish output aligned before drift reaches CI.
  image:
    src: /logo.svg
    alt: Limina
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on npm
      link: https://www.npmjs.com/package/limina

features:
  - title: See the real dependency graph
    details: When a PR adds a cross-package import, see whether it needs a project reference, a workspace dependency, or an architecture rule change.
  - title: Keep packages in their lanes
    details: Catch cross-package relative imports, undeclared dependencies, and #imports that escape their package, so dependencies return to manifests and exports.
  - title: Know every file is checked
    details: Connect declaration leaves to local typecheck companions and framework checkers, so first failures point to graph, source, proof, or typecheck work.
  - title: Ship what consumers install
    details: Validate the dist files consumers install before publish, including exports, types, README/license files, and runtime import boundaries.
---

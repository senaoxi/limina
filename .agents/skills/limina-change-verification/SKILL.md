---
name: limina-change-verification
description: 'Design and execute validation for Limina changes, tests, fixtures, Checker/build behavior, or empirical technical claims. Exclude unrelated projects and claims based only on reading source; select checks by the actual changed boundary.'
---

# Verify Limina changes

1. Establish the affected production observable, intended claim, actual diff,
   and boundaries before selecting checks. Read [the PCR map](../../docs/README.md)
   and [development workflow](../../docs/development-workflow.md), including its
   validation/handoff and portable-path sections. Follow scoped AGENTS.
2. Use [test-audit](../test-audit/SKILL.md) before authoring, changing, or reviewing
   tests. Select the smallest sufficient existing owner-boundary test. For a
   clear cheap bug, demonstrate failing-before and passing-after evidence.
   Avoid tests that only repeat implementation or agent prose.
3. Preserve real compiler, loader, workspace, filesystem, and process boundaries
   when they determine the result. Read root/owning package scripts before
   commands. Avoid invalid mocks, lowered assertions, skipped failures, broad
   timeout increases, or incidental fixture rewrites that hide the condition.
4. For empirical confirmation, follow the applicable verification protocol and
   [architecture workflow](../../docs/architecture-workflow.md): create and run a
   faithful minimal repro in the user-designated evidence workspace (the active
   AGENTS may supply its local location). Use `$EVIDENCE_ROOT/<topic>/` in shared
   records. Preserve versions, package manager, config, workspace, module format,
   entry, and run command. Report any key condition that cannot be reproduced.
5. Before a definitive empirical conclusion, run at least three independent
   adversarial rounds aimed at falsifying the final proposition. Each changes a
   consequential dimension or observation path. Record intent, independence,
   exact command/conditions, and actual result. Repeating one command is not
   independence. If a round narrows the claim, challenge the revised claim until
   it too has three applicable independent rounds. Static reading is not a run.
6. Run checks required by the development workflow for the actual change class.
   Agent/prose-only changes do not require the full product build/test suite by
   default. Inspect added files as well as tracked diffs; ordinary Git diff
   checks omit untracked content. Finish with `git diff --check`, status, and a
   boundary review preserving pre-existing work.

For bounded protocol or model drift reviews, follow the [formal verification workflow](../../../verification/formal/README.md) to pair the TLC verdict with an independent implementation replay.

Report repro location, environment/versions, baseline, each adversarial round,
commands/results, the final bounded conclusion, and uncovered platforms/tuples.
Distinguish source-established from runtime-tested; no unrun test, skipped job,
or prior agent summary is current acceptance. Use
[project-context-writing](../project-context-writing/SKILL.md) for saved results
and [doc-coauthoring](../doc-coauthoring/SKILL.md) for public documentation.
This skill selects execution evidence; test-audit owns test quality and PCR owns
knowledge. Optional global workflow skills do not add required gates.

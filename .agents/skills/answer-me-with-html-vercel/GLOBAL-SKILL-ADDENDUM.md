# Global Skill integration status

The global `~/.agents/skills/answer-me-with-html/SKILL.md` now owns the default Vercel → local fallback workflow. Its bundled `scripts/publish.mjs deliver` attempts shared Vercel publishing and returns the rendered local HTML path if publication cannot be completed.

The project-scoped skill remains for compatibility with existing Limina sessions. Prefer the global Skill and its bundled scripts for new work; no separate manual addendum is required.

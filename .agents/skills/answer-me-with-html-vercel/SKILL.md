---
name: answer-me-with-html-vercel
description: Project-scoped compatibility entry for the default answer-me-with-html shared Vercel publishing workflow. Render locally first, attempt shared Vercel delivery for safe pages, then fall back to the local HTML on failure.
---

# Shared Vercel publishing for answer-me-with-html

This project-scoped skill complements the **global** `answer-me-with-html` skill. The global skill now makes shared Vercel publication the default delivery attempt. First render the HTML locally with the bundled `am` CLI, then attempt online delivery; on failure or when content is unsuitable for public hosting, return the local file.

## Publication authority and safety

- **Default flow:** render locally → check publication safety → attempt shared Vercel publishing → return the verified HTTPS URL, or the local HTML link if Vercel fails. The user has authorized this as the default; an explicit local-only request overrides it.
- Before uploading, inspect the rendered page for secrets, private source code, private user data, absolute local paths and unintended embedded content. Local parsing and HTML generation do not make content safe to publish. If sensitive data is present, keep the local file and ask for approval of a redacted version.
- A production deployment is required for a stable project domain; this is independent of publishing any unrelated application. Do not remove deployment protection or create new domains without authorization.
- Never issue `vercel deploy` against just the latest single HTML file. Vercel deployments replace the site's snapshot and would remove existing pages.

## Shared project and persistent archive

The one-time local configuration is stored in `$AM_HOME/vercel-shared-project.json` (default `~/.answer-me-with-html/vercel-shared-project.json`). It pins the expected Vercel team, Project name and Project ID. No access tokens are stored by this helper: authentication belongs to the user's Vercel CLI.

The persistent site source lives at `$AM_HOME/vercel-shared-site/` (default `~/.answer-me-with-html/vercel-shared-site/`):

```text
vercel-shared-site/
├── index.html                  # grouped gallery
├── pages.json                  # group and publication timestamp catalog
└── pages/
    ├── require-bindings.html
    ├── module-resolution.html
    └── more-topics.html
```

Every publish redeploys the **entire directory**. Keep this directory intact between sessions. Separate workstations or cloud machines must synchronize the complete archive; independently publishing from different local archives could overwrite the live site's other pages. Concurrent publishes from the same host are serialized with a lock.

## Setup (once per machine)

Use the existing Vercel Project and team. Never implicitly create a new project:

```bash
vercel login
node .agents/skills/answer-me-with-html-vercel/publish.mjs configure \
  --team <team-slug> \
  --project <existing-project-name> \
  --project-id <existing-prj-id>
```

Requires Node.js 20+, the authenticated Vercel CLI and `curl` for HTTP verification. The helper checks the remote project's identity before saving its local configuration. Existing configuration cannot silently be rebound to another project.

## Publish after rendering

Render a page normally, record the exact `✓ /absolute/path.html` output, and review that file for confidential content. Before publishing, ChatGPT / Codex should **summarize the current conversation and infer a concise, accurate source title**; the exact UI title is not required. A ChatGPT conversation URL is **optional**. If no URL was provided, omit `--context-url` and continue publishing to Vercel; do not fall back merely because a URL is absent. Never fabricate a conversation link. The global `~/.agents/skills/answer-me-with-html/references/vercel-shared.md` owns the authoritative validation contract. For a known Codex session, publish with:

```bash
node "$HOME/.agents/skills/answer-me-with-html/scripts/publish.mjs" deliver \
  "/absolute/path/to/generated-page.html" \
  --slug require-bindings \
  --group limina \
  --context-source codex \
  --context-title "Model-summarized Codex task title"
```

For a ChatGPT web session, use `--context-source chatgpt --context-title "Model-summarized conversation topic"`. Add `--context-url "https://chatgpt.com/c/<actual-conversation-id>"` only when a real URL is available; without it, the page and index display the title as plain text and deploy normally. Derive the title from the conversation context rather than blindly copying the HTML title.

The publisher:
1. Copies the selected page to `pages/<slug>.html`, adds the source conversation visibly to the archived HTML and index, and classifies project-specific pages with `--group <project-name>`. Use `--group limina` for Limina explanations; omit `--group` for general `Posts`. The original `am render` output remains unmodified.
2. Preserves all earlier selected pages and rebuilds the blog-style grouped index, ordered newest-first within each group.
3. Checks the pinned Vercel Project, then deploys the full site with `--prod`.
4. Confirms that the deployed HTML matches the annotated archived copy by SHA-256 and that the index is reachable.
5. Prints a stable HTTPS `Published:` URL and `Gallery:` URL.

To prepare content without uploading, use `stage` instead of `publish`. To intentionally replace content at the same slug, add `--replace`. A changed page with the same slug is rejected by default.

The global `deliver` command catches Vercel publishing failures and returns `Local: <path>` without deleting the generated HTML. **Do not report an online URL as successfully updated** on failure. If the upload reached `READY` but verification failed, inspect the existing deployment instead of immediately uploading it again:

```bash
node "$HOME/.agents/skills/answer-me-with-html/scripts/publish.mjs" verify --slug require-bindings
```

The preferred `https://expl.senao.me/` domain is intentionally restricted to authorized accounts. Anonymous requests or automated browsers may receive Cloudflare Challenge / HTTP 403; this is normal access control and **not** a publication failure. Do not frame anonymous accessibility as a necessary acceptance test or warn that anonymous access is unconfirmed. Verify published bytes through the immutable Vercel deployment with authenticated `vercel curl`, then return the preferred domain. Preserve Cloudflare and Vercel protection; if an **authorized** user cannot access it, diagnose that as a separate access failure rather than dismissing it as normal.

## Final answer

When publication succeeds, return the verified HTTPS link and optionally the gallery link. If publication is skipped or fails for any reason, return the pre-existing local HTML link, with a brief explanation. Failure to publish must not fail the HTML creation task.

The global `~/.agents/skills/answer-me-with-html/SKILL.md` is the primary instruction owner. The project-local `publish.mjs` only delegates to the global publisher, avoiding separate implementations of grouping, publication metadata and authenticated verification.

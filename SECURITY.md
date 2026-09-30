# Security reporting

Report vulnerabilities through the [Limina security page](https://github.com/senaoxi/limina/security). Use private vulnerability reporting when enabled; do not include credentials or exploit details in a public bug report. Maintainers must enable that remote reporting feature separately from this policy file.

Include the affected `limina` and `limina-migrate` versions, Node and checker versions, operating system, entry command, workspace/configuration conditions, expected boundary and a minimal reproduction. Describe whether the issue affects the CLI, migration writes, registry access, generated artifacts or publication tooling.

Supported Node and checker ranges are owned by the package manifests and current documentation. This policy does not add a new support or response-time commitment.

Repository controls include dependency review, the existing release-age/trust policy, a high/critical dependency audit gate, CodeQL, checksum-pinned secret scanning and bundled-license evidence. Tool failures are failures; reports are not proof of exhaustive coverage. Existing audit exclusions remain visible in the workspace configuration and require their own review.

Publication and documentation deployment are separate, explicitly enabled workflows. Report a suspected credential exposure privately so the credential owner can address it; removing a file alone does not remove its Git history.

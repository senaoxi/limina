# Rule Metadata

`RuleDescriptor` is the only source for rule ID, input kind, category, description, default severity, message templates, options definition, and documentation reference.

Validators report a message ID, message values, direct location, and evidence. They do not construct a complete issue. The assembler resolves descriptor metadata, creates the message, assigns stable ID and origin, and provides deterministic sorting and machine-readable output.

`RuleOptionsSchema` is a Limina interface returning either a parsed value or structured problems. Rules with no options explicitly use `{ kind: 'none' }`; any configured value is rejected before analysis preparation.

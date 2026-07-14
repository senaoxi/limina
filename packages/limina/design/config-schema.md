# Configuration Schema Boundary

Configuration processing is `unknown input -> parsed config -> validated config -> resolved config`. Domain workflows receive only resolved values.

Rule configuration is keyed by descriptor rule ID. A descriptor declares either `{ kind: 'none' }` or a Limina-owned `RuleOptionsSchema`. The contract is deliberately independent of Zod; configuration infrastructure may adapt a schema library without exposing it to validators.

All enabled rule IDs and options are validated before any aggregate provider or view projector is called. Unknown rules, options supplied to a no-options rule, and schema failures are `ConfigurationError`, not governance issues.

0.2.0 has no plugin configuration field and does not reserve a loosely typed extension bag.

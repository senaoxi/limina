# A restored reference must still govern the launch

[Replay](replay.mjs) copies the real `checker/admission-denied-reference` fixture into a fresh temporary workspace. Its A config selects a label denying its implicit reference to B. It loads the unchanged policy as plain ESM, creates and disposes real cache-enabled managers, materializes generated configs, chooses the actual tsc target and enters the managed build path. Only the final checker runner is replaced with a recorder: the observable is **permission to start it**, not compiler success.

```sh
RUN=$(mktemp -d)
node --import tsx verification/formal/evidence/managed-cache/replay.mjs "$RUN/implementation"
node verification/formal/run.mjs --suite admission --profile admission/mutation-old-graph.cfg --out "$RUN/admission"
node verification/formal/run.mjs --suite cache --profile cache/mutation-trust-envelope.cfg --out "$RUN/cache"
```

| Invocation in the same fixture                                   | Required observation                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cold and warm                                                    | Cold miss, then hit; same source owner and serialized B reference; mutation denied with `LIMINA_GRAPH_ACCESS_DENIED`; zero launches. |
| Reopen a valid storage envelope whose declaration config omits B | Miss, recollection, restored B reference and the same denial. A graph hit or launch fails the witness.                               |
| Reopen the repair                                                | Hit; unchanged source/target and denial.                                                                                             |
| Deselect only the policy label                                   | Same target reaches the recording runner; an unavailable checker or broken recorder cannot satisfy this control.                     |

The [selected raw TLC excerpt](old-graph.trace.txt) shows the hypothetical faulty handoff: refresh to view 1 → issue a view-1 permit using view-0 edges → consume at mutation. Its signature and stage are current, yet the effect is forbidden. The real restoration replay differs where it discards the unbound graph, before it can authorize an effect. These are related, **different fault injections**; the model's stale issuance is not a reproduced CLI defect. The existing detector checks the user-facing rejection, and the full analysis cache suite separately exercises repair across OS processes. This small replay uses fresh managers in one Node process.

**Interface mutation control.** The [optional patch](handoff.patch) removes B _after_ the warm graph has qualified, immediately before the materializer receives it. Apply it only to a disposable copy of the reviewed checkout with working workspace dependencies. Run the replay once on that copy before applying the patch (exit 0), then with the patch and another fresh output path (exit 1). In the mutated copy cold still denies; warm reports a hit and the same tsc owner, yet serializes zero references and calls the recording runner. The assertion catches the mismatch; this is a measured effect of injected code, not a finding against the unmodified product.

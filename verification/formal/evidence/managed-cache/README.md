# Current references must govern the launch

[Replay](../../../../packages/limina/integration/formal/managed-cache.mjs) copies the real `checker/admission-denied-reference` fixture into a fresh temporary workspace. Its A config selects a label denying its implicit reference to B. It loads the unchanged policy as plain ESM, creates and disposes real cache-enabled managers, materializes generated configs, chooses the actual tsc target and enters the managed build path. Only the final checker runner is replaced with a recorder: the observable is **permission to start it**, not compiler success.

```sh
RUN=$(mktemp -d)
node --import tsx verification/formal/evidence/managed-cache/replay.mjs "$RUN/implementation"
node verification/formal/run.mjs --suite admission --profile admission/mutation-old-graph.cfg --out "$RUN/admission"
node verification/formal/run.mjs --suite cache --profile cache/mutation-trust-envelope.cfg --out "$RUN/cache"
```

| Invocation in the same fixture                          | Required observation                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cold and warm                                           | Fresh graph preparation each time. Warm consumes Native facts with zero semantic Programs. Both deny and retain the B reference. |
| Include all persisted project scopes                    | Restore contexts with zero semantic Programs. Preserve the full index bytes.                                                     |
| Exclude all project scopes                              | Run semantic Programs with zero restored contexts. Preserve the full index bytes and the same denial.                            |
| Materialized declaration config loses B                 | Restore the same declaration config bytes using cached facts and current project policy. Deny with `LIMINA_GRAPH_ACCESS_DENIED`. |
| Complete storage envelope loses the consumer root facts | Recollect the affected facts, retain the B reference, and deny with the same diagnostic.                                         |
| Reopen the repair                                       | Zero semantic Programs. The owner, output references and denial remain the same.                                                 |
| Deselect only the policy label                          | Same target reaches the recording runner.                                                                                        |

After the allowed launch, the replay changes the consumer source. An empty scope filter must preserve the full index bytes. Repeating the same request with a full writer must replace them.

The [selected raw TLC excerpt](old-graph.trace.txt) shows a hypothetical handoff that issues a view-1 permit using view-0 edges. The replay checks current graph derivation and materialization before the actual admission boundary. Each denied row requires zero launches. The detector checks the user-facing rejection. The full analysis cache suite also exercises repair across processes, and this replay uses fresh managers in one Node process.

The [historical patch](handoff.patch) records a fault injection against the earlier whole-graph cache code. It removed B after the persisted graph qualified. The mutated warm run serialized zero references and called the recording runner.

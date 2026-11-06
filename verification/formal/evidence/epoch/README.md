# Epoch replacement during validation

**Internal API reproduced; ordinary CLI publication not established.** The [raw trace excerpt](validation.trace.txt) separates the identity check, external refresh and completion of input validation. The [bounded graph](boundary.mmd) shows both the serialized path and the counterexample. In the [implementation replay](../../../../packages/limina/integration/formal/epoch.mjs), a read barrier replaces the controller after its identity check. It returns the object from the detached epoch. The same replacement before identity validation rejects. Neither call publishes.

```sh
RUN=$(mktemp -d)
node verification/formal/run.mjs --suite pilot --profile epoch/epoch-validation-boundary.cfg --out "$RUN/model"
node --import tsx verification/formal/evidence/epoch/replay.mjs "$RUN/implementation"
```

The historical return property is stronger than the ordinary scheduler contract. Keep the boundary visible; changing the expected verdict or enabling the proposed model guard is not evidence of a production fix.

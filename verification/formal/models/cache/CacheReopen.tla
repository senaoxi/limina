---- MODULE CacheReopen ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Policy, Writers, ReadScope, ReadRuntime
VARIABLES input, disk, blocks, lease, writer, reader, candidate, adopted, lastCommit
vars == <<input,disk,blocks,lease,writer,reader,candidate,adopted,lastCommit>>
Scoped == ReadScope # "full"
ScopeSelected == ReadScope # "excluded"
Ids == 1..Writers
RecentOrphan == Writers+1
\* Unique physical revisions, not increasing clocks. Revision 0 is the initial envelope.
Packet(id,v,c,i,p) == [id |-> id, content |-> v, context |-> c, inventory |-> i, parsedConfig |-> p]
Empty == Packet(0,0,FALSE,FALSE,FALSE)
Observation(hit,v,data,backed) == [hit |-> hit, at |-> v, data |-> data, backed |-> backed]
Init == /\ input = 0 /\ lease = 0 /\ blocks = {0,RecentOrphan}
        /\ disk \in {Packet(0,v,c,i,p) : v \in 0..1, c \in BOOLEAN, i \in BOOLEAN, p \in BOOLEAN}
        /\ writer = [w \in Ids |-> [phase |-> "new", base |-> 0, seen |-> 0, retries |-> 0]]
        /\ reader = "new" /\ candidate = Empty /\ adopted = [config |-> Observation(FALSE,0,Empty,FALSE),
                                        semantic |-> Observation(FALSE,0,Empty,FALSE),
                                        runtimeHit |-> FALSE, runtimeQualified |-> FALSE]
        /\ lastCommit = [did |-> FALSE, base |-> 0, before |-> 0, seen |-> 0, at |-> 0, backed |-> FALSE]
Open(w) == /\ writer[w].phase = "new"
           /\ writer' = [writer EXCEPT ![w].base = disk.id, ![w].seen = input, ![w].phase = "analyzed"]
           /\ UNCHANGED <<input,disk,blocks,lease,reader,candidate,adopted,lastCommit>>
Drift == /\ input = 0 /\ input' = 1 /\ UNCHANGED <<disk,blocks,lease,writer,reader,candidate,adopted,lastCommit>>
Retry(w) == /\ writer[w].phase = "analyzed" /\ writer[w].seen # input /\ writer[w].retries = 0
            /\ writer' = [writer EXCEPT ![w].seen = input, ![w].retries = 1]
            /\ UNCHANGED <<input,disk,blocks,lease,reader,candidate,adopted,lastCommit>>
Acquire(w) == /\ writer[w].phase = "analyzed" /\ lease = 0
              /\ LET ok == Policy \in {"write","force"} /\ (~Scoped \/ Fault = "partial-write") /\ writer[w].seen = input
                           /\ (Fault = "ignore-baseline" \/ disk.id = writer[w].base)
                 IN /\ lease' = IF ok THEN w ELSE 0
                    /\ writer' = [writer EXCEPT ![w].phase = IF ok THEN "lease" ELSE "closed"]
              /\ UNCHANGED <<input,disk,blocks,reader,candidate,adopted,lastCommit>>
Stage(w) == /\ lease = w /\ writer[w].phase = "lease"
            /\ blocks' = blocks \cup {w} /\ writer' = [writer EXCEPT ![w].phase = "blocks"]
            /\ UNCHANGED <<input,disk,lease,reader,candidate,adopted,lastCommit>>
Publish(w) == /\ lease = w /\ (writer[w].phase = "blocks" \/ (writer[w].phase="lease" /\ Fault = "index-first"))
              /\ LET ok == writer[w].seen = input \/ Fault = "skip-final"
                 IN /\ disk' = IF ok THEN Packet(w,writer[w].seen,TRUE,TRUE,TRUE) ELSE disk
                    /\ lastCommit' = IF ok THEN [did |-> TRUE, base |-> writer[w].base, before |-> disk.id,
                         seen |-> writer[w].seen, at |-> input, backed |-> w \in blocks] ELSE lastCommit
                    /\ writer' = [writer EXCEPT ![w].phase = IF ok THEN "committed" ELSE "closed"]
                    /\ lease' = IF ok THEN w ELSE 0
              /\ UNCHANGED <<input,blocks,reader,candidate,adopted>>
\* One unlink at a time under the publishing lease. Old orphans may also be
\* kept (grace period or failed cleanup). The active payload is never eligible.
Sweep(w,b) == /\ lease=w /\ writer[w].phase="committed" /\ b \in blocks
              /\ (b # RecentOrphan \/ Fault="ignore-grace")
              /\ (b # disk.id \/ Fault="sweep-active") /\ blocks'=blocks \ {b}
              /\ UNCHANGED <<input,disk,lease,writer,reader,candidate,adopted,lastCommit>>
Release(w) == /\ lease=w /\ writer[w].phase="committed" /\ lease'=0
              /\ writer'=[writer EXCEPT ![w].phase="closed"]
              /\ UNCHANGED <<input,disk,blocks,reader,candidate,adopted,lastCommit>>
Abandon(w) == /\ lease = w /\ writer[w].phase \in {"lease","blocks"} /\ lease' = 0 /\ writer' = [writer EXCEPT ![w].phase = "closed"]
              /\ UNCHANGED <<input,disk,blocks,reader,candidate,adopted,lastCommit>>
ReadIndex == /\ reader="new" /\ candidate'=disk /\ reader'="index"
             /\ UNCHANGED <<input,disk,blocks,lease,writer,adopted,lastCommit>>
ReadBlocks == /\ reader="index"
              /\ LET load == Policy \in {"write","readonly"} /\ candidate.id \in blocks
                              /\ (ScopeSelected \/ Fault="ignore-scope")
                 IN reader'=IF load THEN "loaded" ELSE "cold"
              /\ UNCHANGED <<input,disk,blocks,lease,writer,candidate,adopted,lastCommit>>
ReplayConfig == /\ reader="loaded"
                /\ LET hit == candidate.content=input /\ (candidate.parsedConfig \/ Fault="trust-config")
                   IN adopted'=[adopted EXCEPT !.config=Observation(hit,input,candidate,TRUE)]
                /\ reader'="config"
                /\ UNCHANGED <<input,disk,blocks,lease,writer,candidate,lastCommit>>
Reopen == /\ reader="config"
          /\ LET hit == candidate.content=input /\ candidate.context /\ (candidate.inventory \/ Fault="trust-envelope")
             IN /\ reader'=IF ReadRuntime THEN "runtime" ELSE IF hit THEN "hit" ELSE "cold"
                /\ adopted'=[adopted EXCEPT !.semantic=Observation(hit,input,candidate,TRUE)]
          /\ UNCHANGED <<input,disk,blocks,lease,writer,candidate,lastCommit>>
\* Runtime query identity, traced inputs and receipt validity have their own
\* oracle. A Native semantic hit can coexist with a dirty runtime query.
ReplayRuntime(qualified) == /\ reader="runtime"
                            /\ adopted'=[adopted EXCEPT !.runtimeQualified=qualified,
                                   !.runtimeHit=IF Fault="trust-semantic" THEN adopted.semantic.hit ELSE qualified]
                            /\ reader'="done"
                            /\ UNCHANGED <<input,disk,blocks,lease,writer,candidate,lastCommit>>
Finish == /\ reader \in {"hit","cold","done"} /\ \A w \in Ids : writer[w].phase = "closed"
          /\ UNCHANGED vars
Next == Drift \/ ReadIndex \/ ReadBlocks \/ ReplayConfig \/ Reopen \/ (\E q \in BOOLEAN : ReplayRuntime(q)) \/ Finish \/ (\E w \in Ids : Open(w) \/ Retry(w) \/ Acquire(w) \/ Stage(w) \/ Publish(w) \/ (\E b \in blocks : Sweep(w,b)) \/ Release(w) \/ Abandon(w))
Spec == Init /\ [][Next]_vars
Qualified(obs) == ScopeSelected /\ obs.backed /\ obs.data.content = obs.at /\ Policy \in {"write","readonly"}
CurrentAdoption == LET obs == adopted.semantic IN ~obs.hit \/ (Qualified(obs) /\ obs.data.context /\ obs.data.inventory)
CurrentConfigAdoption == LET obs == adopted.config IN ~obs.hit \/ (Qualified(obs) /\ obs.data.parsedConfig)
PhysicalCAS == ~lastCommit.did \/ lastCommit.base = lastCommit.before
CurrentCommit == ~lastCommit.did \/ (lastCommit.seen = lastCommit.at /\ ~Scoped /\ Policy \in {"write","force"})
IndexLast == ~lastCommit.did \/ lastCommit.backed
ActiveBlockSurvives == ~lastCommit.did \/ ~lastCommit.backed \/ disk.id \in blocks
RecentBlockSurvives == RecentOrphan \in blocks
RuntimeAdoption == ~adopted.runtimeHit \/ (ScopeSelected /\ adopted.runtimeQualified)
NoScopedHit == ~(Scoped /\ adopted.semantic.hit)
NoRuntimeHit == ~adopted.runtimeHit
NoOrphanReclaimed == 0 \in blocks
NoPublishedHit == ~(reader = "hit" /\ adopted.semantic.data.id # 0)
====

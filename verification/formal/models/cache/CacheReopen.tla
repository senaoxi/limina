---- MODULE CacheReopen ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Policy, Writers
VARIABLES input, disk, blocks, lease, writer, reader, adopted, lastCommit
vars == <<input,disk,blocks,lease,writer,reader,adopted,lastCommit>>
Ids == 1..Writers
\* Unique physical revisions, not increasing clocks. Revision 0 is the initial envelope.
Packet(id,v,c,i,p) == [id |-> id, content |-> v, context |-> c, inventory |-> i, parsedConfig |-> p]
Empty == Packet(0,0,FALSE,FALSE,FALSE)
Observation(hit,v,data,backed) == [hit |-> hit, at |-> v, data |-> data, backed |-> backed]
Init == /\ input = 0 /\ lease = 0 /\ blocks = {0}
        /\ disk \in {Packet(0,v,c,i,p) : v \in 0..1, c \in BOOLEAN, i \in BOOLEAN, p \in BOOLEAN}
        /\ writer = [w \in Ids |-> [phase |-> "new", base |-> 0, seen |-> 0, retries |-> 0]]
        /\ reader = "new" /\ adopted = [config |-> Observation(FALSE,0,Empty,FALSE),
                                        semantic |-> Observation(FALSE,0,Empty,FALSE)]
        /\ lastCommit = [did |-> FALSE, base |-> 0, before |-> 0, seen |-> 0, at |-> 0, backed |-> FALSE]
Open(w) == /\ writer[w].phase = "new"
           /\ writer' = [writer EXCEPT ![w].base = disk.id, ![w].seen = input, ![w].phase = "analyzed"]
           /\ UNCHANGED <<input,disk,blocks,lease,reader,adopted,lastCommit>>
Drift == /\ input = 0 /\ input' = 1 /\ UNCHANGED <<disk,blocks,lease,writer,reader,adopted,lastCommit>>
Retry(w) == /\ writer[w].phase = "analyzed" /\ writer[w].seen # input /\ writer[w].retries = 0
            /\ writer' = [writer EXCEPT ![w].seen = input, ![w].retries = 1]
            /\ UNCHANGED <<input,disk,blocks,lease,reader,adopted,lastCommit>>
Acquire(w) == /\ writer[w].phase = "analyzed" /\ lease = 0
              /\ LET ok == Policy \in {"write","force"} /\ writer[w].seen = input
                           /\ (Fault = "ignore-baseline" \/ disk.id = writer[w].base)
                 IN /\ lease' = IF ok THEN w ELSE 0
                    /\ writer' = [writer EXCEPT ![w].phase = IF ok THEN "lease" ELSE "closed"]
              /\ UNCHANGED <<input,disk,blocks,reader,adopted,lastCommit>>
Stage(w) == /\ lease = w /\ writer[w].phase = "lease"
            /\ blocks' = blocks \cup {w} /\ writer' = [writer EXCEPT ![w].phase = "blocks"]
            /\ UNCHANGED <<input,disk,lease,reader,adopted,lastCommit>>
Publish(w) == /\ lease = w /\ (writer[w].phase = "blocks" \/ Fault = "index-first")
              /\ LET ok == writer[w].seen = input \/ Fault = "skip-final"
                 IN /\ disk' = IF ok THEN Packet(w,writer[w].seen,TRUE,TRUE,TRUE) ELSE disk
                    /\ lastCommit' = IF ok THEN [did |-> TRUE, base |-> writer[w].base, before |-> disk.id,
                         seen |-> writer[w].seen, at |-> input, backed |-> w \in blocks] ELSE lastCommit
              /\ writer' = [writer EXCEPT ![w].phase = "closed"] /\ lease' = 0
              /\ UNCHANGED <<input,blocks,reader,adopted>>
Abandon(w) == /\ lease = w /\ lease' = 0 /\ writer' = [writer EXCEPT ![w].phase = "closed"]
              /\ UNCHANGED <<input,disk,blocks,reader,adopted,lastCommit>>
CanRead == Policy \in {"write","readonly"} /\ disk.content = input /\ disk.id \in blocks
ReplayConfig == /\ reader = "new"
                /\ LET hit == CanRead /\ (disk.parsedConfig \/ Fault = "trust-config")
                   IN adopted' = [adopted EXCEPT !.config = Observation(hit,input,disk,disk.id \in blocks)]
                /\ reader' = "config"
                /\ UNCHANGED <<input,disk,blocks,lease,writer,lastCommit>>
Reopen == /\ reader = "config"
          /\ LET hit == CanRead /\ disk.context /\ (disk.inventory \/ Fault = "trust-envelope")
             IN /\ reader' = IF hit THEN "hit" ELSE "cold"
                /\ adopted' = [adopted EXCEPT !.semantic = Observation(hit,input,disk,disk.id \in blocks)]
          /\ UNCHANGED <<input,disk,blocks,lease,writer,lastCommit>>
Finish == /\ reader \in {"hit","cold"} /\ \A w \in Ids : writer[w].phase = "closed"
          /\ UNCHANGED vars
Next == Drift \/ ReplayConfig \/ Reopen \/ Finish \/ (\E w \in Ids : Open(w) \/ Retry(w) \/ Acquire(w) \/ Stage(w) \/ Publish(w) \/ Abandon(w))
Spec == Init /\ [][Next]_vars
Qualified(obs) == obs.backed /\ obs.data.content = obs.at /\ Policy \in {"write","readonly"}
CurrentAdoption == LET obs == adopted.semantic IN ~obs.hit \/ (Qualified(obs) /\ obs.data.context /\ obs.data.inventory)
CurrentConfigAdoption == LET obs == adopted.config IN ~obs.hit \/ (Qualified(obs) /\ obs.data.parsedConfig)
PhysicalCAS == ~lastCommit.did \/ lastCommit.base = lastCommit.before
CurrentCommit == ~lastCommit.did \/ (lastCommit.seen = lastCommit.at /\ Policy \in {"write","force"})
IndexLast == ~lastCommit.did \/ lastCommit.backed
NoPublishedHit == ~(reader = "hit" /\ adopted.semantic.data.id # 0)
====

---- MODULE ManagedAdmission ----
EXTENDS Naturals
CONSTANTS Fault, InitialLabel, MaxView, Change
VARIABLES view, pc, held, effect
vars == <<view, pc, held, effect>>
Targets == {"root", "independent"}
Nodes == Targets \cup {"middle", "provider"}
Stages == {"mutation", "launch", "output-copy"}
NextStage(s) == CASE s = "mutation" -> "launch" [] s = "launch" -> "output-copy" [] OTHER -> "done"
NoPermit == [target |-> "none", stage |-> "none", view |-> 0]
Init == /\ view = 0 /\ pc = [t \in Targets |-> "mutation"] /\ held = NoPermit
        /\ effect = [target |-> "none", stage |-> "none", issued |-> NoPermit, at |-> 0]
\* An implicit edge belongs to a selected generated config, even without a scheduler edge.
References(v) == {<<"root","middle">>} \cup
  (IF InitialLabel \/ Change = "label" \/ v > 0 THEN {<<"middle","provider">>} ELSE {})
Schedule == {}
Follow(r, ns) == ns \cup {n \in Nodes : \E m \in ns : <<m,n>> \in r}
Traversed(t,v) == LET rel == IF Fault = "schedule" THEN Schedule ELSE References(v)
                    one == Follow(rel, {t})
                IN IF Fault = "one-hop" THEN {t} ELSE one
Label(v) == InitialLabel \/ Change = "graph" \/ v > 0
Decide(t,v) == LET graph == IF Fault = "old-graph" THEN 0 ELSE v
               IN ~(Label(v) /\ "middle" \in Traversed(t,graph) /\ <<"middle","provider">> \in References(graph))
\* The oracle comes from the fixture's source labels and target membership, not Traversed.
Forbidden(t,v) == t = "root" /\ (InitialLabel \/ v # 0)
Issue(t) == /\ held = NoPermit /\ pc[t] \in Stages
            /\ IF Decide(t,view)
                 THEN /\ held' = [target |-> t, stage |-> pc[t], view |-> view] /\ UNCHANGED pc
                 ELSE /\ pc' = [pc EXCEPT ![t] = "refused"] /\ UNCHANGED held
            /\ UNCHANGED <<view,effect>>
Consume(t,s) == /\ held # NoPermit /\ pc[t] \in Stages
                /\ (Fault = "wrong-target" \/ held.target = t)
                /\ (Fault = "wrong-stage" \/ (held.stage = s /\ pc[t] = s))
                /\ (Fault = "old-permit" \/ held.view = view)
                /\ effect' = [target |-> t, stage |-> s, issued |-> held, at |-> view]
                /\ pc' = [pc EXCEPT ![t] = NextStage(s)]
                /\ held' = NoPermit /\ UNCHANGED view
\* Callback unwinds without performing a protected effect.
Release == /\ held # NoPermit /\ held' = NoPermit /\ UNCHANGED <<view,pc,effect>>
Refresh == /\ view < MaxView /\ view' = view+1 /\ UNCHANGED <<held,pc,effect>>
Finish == /\ \A t \in Targets : pc[t] \in {"done","refused"}
          /\ UNCHANGED vars
Next == (\E t \in Targets : Issue(t) \/ (\E s \in Stages : Consume(t,s))) \/ Release \/ Refresh \/ Finish
Spec == Init /\ [][Next]_vars
DeniedHasNoEffect == effect.target = "none" \/ ~Forbidden(effect.target,effect.at)
ScopedEffect == effect.target = "none" \/ (effect.target = effect.issued.target /\ effect.stage = effect.issued.stage /\ effect.at = effect.issued.view)
\* Existential controls: expect a counterexample, never assert eventual progress.
NoIndependentCompletion == ~(pc["independent"] = "done" /\ pc["root"] = "refused")
NoLateCopyRefusal == ~(effect.target = "root" /\ effect.stage = "launch" /\ pc["root"] = "refused")
====

---- MODULE ReferenceProjection ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Expanded
VARIABLES shape, phase, edges
vars == <<shape,phase,edges>>
\* R is a generated checker entry, S a solution, A/B leaves, O output, K a
\* framework check projection, V a different checker. U is an unbound path.
Files == {"R","S","A","B","O","K","V"}
Required == {"A","B","O"}
Schedule == {<<"R","B">>}
Base == {<<"R","S">>, <<"S","A">>, <<"R","A">>, <<"S","B">>, <<"R","O">>}
Shapes == {"dag","missing","wrong-checker","cycle","dangling"} \cup
          (IF Expanded THEN {"check-out","check-in","schedule-only"} ELSE {})
Serialized ==
  CASE shape \in {"missing","schedule-only"} -> Base \ {<<"S","B">>}
    [] shape = "wrong-checker" -> Base \cup {<<"A","V">>}
    [] shape = "cycle" -> Base \cup {<<"A","S">>}
    [] shape = "dangling" -> Base \cup {<<"A","U">>}
    [] shape = "check-out" -> Base \cup {<<"K","A">>}
    [] shape = "check-in" -> Base \cup {<<"A","K">>}
    [] OTHER -> Base
Reach(e,start) ==
  LET step(s) == s \cup {n \in Files : \E m \in s : <<m,n>> \in e}
      RECURSIVE walk(_,_)
      walk(s,k) == IF k=0 THEN s ELSE walk(step(s),k-1)
  IN walk(start,Cardinality(Files))
Checker(n) == CASE n = "K" -> "svelte" [] n = "V" -> "vue" [] OTHER -> "tsc"
Accept ==
  /\ \A p \in edges : p[2] \in Files
  /\ Fault = "no-color" \/ (\A p \in edges : p[1]="K" \/ (p[2]#"K" /\ Checker(p[1])=Checker(p[2])))
  /\ Fault = "no-scc" \/ (\A p \in edges : p[1] \notin Reach(edges,{p[2]}))
  /\ LET r == Reach(IF Fault="use-schedule" THEN edges \cup Schedule ELSE edges,{"R"})
         required == IF Fault="derive-required" THEN {p[2] : p \in edges} \cap Required ELSE Required
     IN required \subseteq r
Init == /\ shape \in Shapes /\ edges={} /\ phase="prepared"
Stage == /\ phase="prepared" /\ edges'=Serialized /\ phase'="staged" /\ UNCHANGED shape
Validate == /\ phase="staged" /\ phase'=(IF Accept THEN "admitted" ELSE "rejected") /\ UNCHANGED <<shape,edges>>
Finish == /\ phase \in {"admitted","rejected"} /\ UNCHANGED vars
Next == Stage \/ Validate \/ Finish
Spec == Init /\ [][Next]_vars
\* Independent intent labels, not a second use of Accept.
Sound == phase # "admitted" \/ shape \in {"dag","check-out"}
CompleteControls == phase # "rejected" \/ shape \notin {"dag","check-out"}
====

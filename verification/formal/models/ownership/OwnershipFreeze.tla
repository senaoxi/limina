---- MODULE OwnershipFreeze ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Expanded
VARIABLES scenario, phase, pending, seen, frozen, family, owner, solution
vars == <<scenario,phase,pending,seen,frozen,family,owner,solution>>
Cases == {"native","promote","ambiguous","shared","unique","pinned"} \cup (IF Expanded THEN {"empty","other-native","mixed-native-component"} ELSE {})
ConfigIntents == CASE scenario \in {"ambiguous","pinned"} -> {"vue","svelte"}
                      [] scenario="unique" -> {"vue"} [] OTHER -> {}
Authority == CASE scenario="pinned" -> "svelte"
                  [] Cardinality(seen)=1 -> CHOOSE f \in seen : TRUE
                  [] OTHER -> "typescript"
Init == /\ scenario \in Cases /\ phase="collect" /\ pending=ConfigIntents /\ seen={}
        /\ frozen="none" /\ family="none" /\ owner="none" /\ solution={}
Observe(f) == /\ phase="collect" /\ f \in pending /\ pending'=pending \ {f}
              /\ seen'=IF Fault="last-wins" THEN {f} ELSE seen \cup {f}
              /\ UNCHANGED <<scenario,phase,frozen,family,owner,solution>>
Freeze == /\ phase="collect" /\ pending={}
          /\ phase'="locked"
          /\ frozen'=Authority
          /\ family'=frozen' /\ UNCHANGED <<scenario,pending,seen,owner,solution>>
\* Trusted equal-color declaration component. Equality is on exact checker names.
ComponentPins == CASE scenario="mixed-native-component" -> {"tsc","tsgo"}
                   [] scenario="other-native" -> {"tsgo"} [] scenario \in {"promote","unique"} -> {"vue-tsc"}
                   [] scenario="pinned" -> {"svelte-check"}
                   [] OTHER -> {"tsc"}
FamilyOf(c) == CASE c="vue-tsc" -> "vue" [] c="svelte-check" -> "svelte" [] OTHER -> "typescript"
Select ==
  /\ phase="locked"
  /\ owner'=CHOOSE c \in ComponentPins : TRUE
  /\ family'=IF Fault="rewrite" /\ owner'="vue-tsc" THEN "vue" ELSE family
  /\ phase'=(IF Cardinality(IF Fault="family-color" THEN {FamilyOf(c) : c \in ComponentPins} ELSE ComponentPins)>1
              THEN "rejected" ELSE "final") /\ UNCHANGED <<scenario,pending,seen,frozen,solution>>
Manifest ==
  /\ phase="final"
  /\ LET checkers == CASE scenario="shared" -> {owner,"vue-tsc"} [] scenario="empty" -> {} [] OTHER -> {owner}
     IN solution'=IF Fault="single-root" /\ Cardinality(checkers)>1 THEN {owner} ELSE checkers
  /\ phase'="published" /\ UNCHANGED <<scenario,pending,seen,frozen,family,owner>>
Finish == /\ phase \in {"published","rejected"} /\ UNCHANGED vars
Next == (\E f \in ConfigIntents : Observe(f)) \/ Freeze \/ Select \/ Manifest \/ Finish
Spec == Init /\ [][Next]_vars
FrozenAuthority == phase # "published" \/ family=frozen
ConfigAuthority == phase="collect" \/ frozen=(CASE scenario="pinned" -> "svelte" [] scenario="unique" -> "vue" [] OTHER -> "typescript")
ExactComponent == phase # "published" \/ scenario # "mixed-native-component"
SourceOwner == phase # "published" \/ owner \in {"tsc","tsgo","vue-tsc","svelte-check"}
SolutionConsumers == phase # "published" \/ (CASE scenario="shared" -> solution={"tsc","vue-tsc"} [] scenario="empty" -> solution={} [] OTHER -> solution={owner})
LegalCases == phase # "rejected" \/ scenario="mixed-native-component"
====

---- MODULE OwnershipFreeze ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Expanded
VARIABLES scenario, phase, pending, seen, frozen, family, owner, solution
vars == <<scenario,phase,pending,seen,frozen,family,owner,solution>>
Cases == {"native","promote","conflict","shared"} \cup (IF Expanded THEN {"empty","other-native","mixed-native-component"} ELSE {})
Facts == CASE scenario="conflict" -> {"vue","svelte"} [] OTHER -> {"typescript"}
Init == /\ scenario \in Cases /\ phase="collect" /\ pending=Facts /\ seen={}
        /\ frozen="none" /\ family="none" /\ owner="none" /\ solution={}
Observe(f) == /\ phase="collect" /\ f \in pending /\ pending'=pending \ {f}
              /\ seen'=IF Fault="last-wins" THEN {f} ELSE seen \cup {f}
              /\ UNCHANGED <<scenario,phase,frozen,family,owner,solution>>
Freeze == /\ phase="collect" /\ pending={}
          /\ phase'=IF Cardinality(seen)>1 THEN "rejected" ELSE "locked"
          /\ frozen'=IF Cardinality(seen)=1 THEN CHOOSE f \in seen : TRUE ELSE "none"
          /\ family'=frozen' /\ UNCHANGED <<scenario,pending,seen,owner,solution>>
\* Trusted equal-color declaration component. Equality is on exact checker names.
ComponentPins == CASE scenario="mixed-native-component" -> {"tsc","tsgo"}
                   [] scenario="other-native" -> {"tsgo"} [] scenario="promote" -> {"vue-tsc"}
                   [] OTHER -> {"tsc"}
FamilyOf(c) == IF c="vue-tsc" THEN "vue" ELSE "typescript"
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
Next == (\E f \in Facts : Observe(f)) \/ Freeze \/ Select \/ Manifest \/ Finish
Spec == Init /\ [][Next]_vars
FrozenAuthority == phase # "published" \/ family=frozen
ConflictRejected == phase # "published" \/ scenario # "conflict"
ExactComponent == phase # "published" \/ scenario # "mixed-native-component"
SourceOwner == phase # "published" \/ owner \in {"tsc","tsgo","vue-tsc"}
SolutionConsumers == phase # "published" \/ (CASE scenario="shared" -> solution={"tsc","vue-tsc"} [] scenario="empty" -> solution={} [] OTHER -> solution={owner})
LegalCases == phase # "rejected" \/ scenario \in {"conflict","mixed-native-component"}
====

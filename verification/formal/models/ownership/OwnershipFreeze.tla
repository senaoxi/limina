---- MODULE OwnershipFreeze ----
EXTENDS Naturals, FiniteSets
CONSTANTS Fault, Expanded
VARIABLES scenario, phase, role, pending, seen, frozen, family, contexts, owner, solution, boundaryReady
vars == <<scenario,phase,role,pending,seen,frozen,family,contexts,owner,solution,boundaryReady>>
Cases == {"native","promote","ambiguous","shared","unique","pinned"} \cup
         (IF Expanded THEN {"empty","other-native","mixed-native-component","inherited-only",
                            "role-failed","vue-failed","astro-companion","svelte-companion"} ELSE {})
DirectIntents == CASE scenario \in {"ambiguous","pinned"} -> {"vue","svelte"}
                      [] scenario \in {"unique","vue-failed"} -> {"vue"}
                      [] scenario="astro-companion" -> {"astro"}
                      [] scenario="svelte-companion" -> {"svelte"}
                      [] OTHER -> {}
ConfigIntents == IF scenario="inherited-only" /\ Fault="inherit-intent" THEN {"vue"} ELSE DirectIntents
Authority == CASE scenario="pinned" -> "svelte"
                  [] Cardinality(seen)=1 -> CHOOSE f \in seen : TRUE
                  [] OTHER -> "typescript"
Init == /\ scenario \in Cases /\ phase="discover" /\ role="candidate"
        /\ pending=ConfigIntents /\ seen={} /\ contexts={}
        /\ frozen="none" /\ family="none" /\ owner="none" /\ solution={} /\ boundaryReady=FALSE
\* The oracle supplies the result of the exceptional default-config role check.
ResolveRole == /\ phase="discover"
               /\ role'=(CASE scenario="empty" -> "solution"
                            [] scenario="role-failed" /\ Fault="drop-failed" -> "solution"
                            [] scenario="role-failed" -> "failed"
                            [] OTHER -> "source")
               /\ phase'=(CASE role'="failed" -> "unavailable"
                             [] role'="solution" -> "empty-solution"
                             [] OTHER -> "collect")
               /\ UNCHANGED <<scenario,pending,seen,frozen,family,contexts,owner,solution,boundaryReady>>
Observe(f) == /\ phase="collect" /\ f \in pending /\ pending'=pending \ {f}
              /\ seen'=IF Fault="last-wins" THEN {f} ELSE seen \cup {f}
              /\ UNCHANGED <<scenario,phase,role,frozen,family,contexts,owner,solution,boundaryReady>>
Freeze == /\ phase="collect" /\ pending={}
          /\ phase'="locked"
          /\ frozen'=Authority
          /\ family'=frozen' /\ UNCHANGED <<scenario,role,pending,seen,contexts,owner,solution,boundaryReady>>
\* Contexts abstract authority and purpose, not the number of compiler passes.
SourceContext(f) == [authority |-> f, purpose |-> "source"]
CompanionContext(f) == [authority |-> f, purpose |-> "typescript-companion"]
ExpectedContexts(f) == {SourceContext(f)} \cup
  (IF scenario \in {"astro-companion","svelte-companion"} THEN {CompanionContext(f)} ELSE {})
PrepareSource ==
  /\ phase="locked"
  /\ IF scenario="vue-failed"
       THEN /\ phase'="unavailable" /\ contexts'={}
       ELSE /\ phase'="prepared"
            /\ contexts'=(CASE Fault="extra-pending" /\ frozen # "typescript" -> ExpectedContexts(frozen) \cup
                                   {[authority |-> "typescript", purpose |-> "pending"]}
                                [] Fault="unbound-companion" /\ scenario \in {"astro-companion","svelte-companion"} ->
                                   {SourceContext(frozen), CompanionContext("typescript")}
                                [] OTHER -> ExpectedContexts(frozen))
  /\ UNCHANGED <<scenario,role,pending,seen,frozen,family,owner,solution,boundaryReady>>
\* Trusted equal-color declaration component. Equality is on exact checker names.
ComponentPins == CASE scenario="mixed-native-component" -> {"tsc","tsgo"}
                   [] scenario="other-native" -> {"tsgo"} [] scenario \in {"promote","unique"} -> {"vue-tsc"}
                   [] scenario \in {"pinned","svelte-companion"} -> {"svelte-check"}
                   [] scenario="astro-companion" -> {"astro"}
                   [] OTHER -> {"tsc"}
FamilyOf(c) == CASE c="vue-tsc" -> "vue" [] c="svelte-check" -> "svelte" [] c="astro" -> "astro" [] OTHER -> "typescript"
Select ==
  /\ phase="prepared"
  /\ owner'=CHOOSE c \in ComponentPins : TRUE
  /\ family'=IF Fault="rewrite" /\ owner'="vue-tsc" THEN "vue" ELSE family
  /\ phase'=(IF Cardinality(IF Fault="family-color" THEN {FamilyOf(c) : c \in ComponentPins} ELSE ComponentPins)>1
              THEN "rejected" ELSE "final") /\ UNCHANGED <<scenario,role,pending,seen,frozen,contexts,solution,boundaryReady>>
\* The ownership promise can return before any generated graph is requested.
ReturnOwnership ==
  /\ phase \in {"final","empty-solution"}
  /\ phase'="ownership-ready" /\ boundaryReady'=(Fault # "skip-boundary")
  /\ UNCHANGED <<scenario,role,pending,seen,frozen,family,contexts,owner,solution>>
Manifest ==
  /\ phase="ownership-ready"
  /\ LET checkers == CASE scenario="shared" -> {owner,"vue-tsc"} [] role="solution" -> {} [] OTHER -> {owner}
     IN solution'=IF Fault="single-root" /\ Cardinality(checkers)>1 THEN {owner} ELSE checkers
  /\ phase'="published" /\ UNCHANGED <<scenario,role,pending,seen,frozen,family,contexts,owner,boundaryReady>>
Finish == /\ phase \in {"ownership-ready","published","rejected","unavailable"} /\ UNCHANGED vars
Next == ResolveRole \/ (\E f \in ConfigIntents : Observe(f)) \/ Freeze \/ PrepareSource \/ Select \/ ReturnOwnership \/ Manifest \/ Finish
Spec == Init /\ [][Next]_vars
BoundaryOnReturn == phase \in {"ownership-ready","published"} => boundaryReady
FrozenAuthority == phase \notin {"ownership-ready","published"} \/ family=frozen
ConfigAuthority == frozen="none" \/ frozen=(CASE scenario \in {"pinned","svelte-companion"} -> "svelte"
                                               [] scenario \in {"unique","vue-failed"} -> "vue"
                                               [] scenario="astro-companion" -> "astro" [] OTHER -> "typescript")
RoleAccounted == phase="discover" \/ (CASE scenario="empty" -> role="solution"
                                         [] scenario="role-failed" -> role="failed" /\ phase="unavailable"
                                         [] OTHER -> role="source")
LockedContexts == phase \notin {"prepared","final","ownership-ready","published","rejected"} \/
                  (IF role="solution" THEN contexts={} ELSE contexts=ExpectedContexts(frozen))
FailedScope == phase # "unavailable" \/ (contexts={} /\ owner="none" /\ solution={})
ExactComponent == phase # "published" \/ scenario # "mixed-native-component"
SourceOwner == phase # "published" \/ role="solution" \/ owner \in {"tsc","tsgo","vue-tsc","astro","svelte-check"}
SolutionConsumers == phase # "published" \/ (CASE scenario="shared" -> solution={"tsc","vue-tsc"} [] role="solution" -> solution={} [] OTHER -> solution={owner})
LegalCases == phase # "rejected" \/ scenario="mixed-native-component"
====

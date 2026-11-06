---- MODULE EpochValidation ----
EXTENDS Naturals
CONSTANTS ReplacementTiming, RecheckAfterValidation
VARIABLES phase,epoch,captured,accepted,replaced
vars == <<phase,epoch,captured,accepted,replaced>>
Init == /\ phase="idle" /\ epoch=0 /\ captured=0 /\ accepted=0 /\ replaced=FALSE
Begin == /\ phase="idle" /\ phase'="analyzing" /\ captured'=epoch
         /\ UNCHANGED <<epoch,accepted,replaced>>
IdentityCheck == /\ phase="analyzing"
                 /\ phase'=IF captured=epoch THEN "validating-inputs" ELSE "rejected"
                 /\ UNCHANGED <<epoch,captured,accepted,replaced>>
ReplaceEpoch == /\ ~replaced
                /\ ((ReplacementTiming="before-identity" /\ phase="analyzing")
                   \/ (ReplacementTiming="during-validation" /\ phase="validating-inputs"))
                /\ epoch'=1 /\ replaced'=TRUE
                /\ UNCHANGED <<phase,captured,accepted>>
FinishValidation == /\ phase="validating-inputs"
                    /\ phase'=IF RecheckAfterValidation /\ captured#epoch THEN "rejected" ELSE "completed"
                    /\ accepted'=captured
                    /\ UNCHANGED <<epoch,captured,replaced>>
Stay == phase \in {"completed","rejected"} /\ UNCHANGED vars
Next == Begin \/ IdentityCheck \/ ReplaceEpoch \/ FinishValidation \/ Stay
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle","analyzing","validating-inputs","completed","rejected"}
          /\ epoch \in 0..1 /\ captured \in 0..1 /\ accepted \in 0..1 /\ replaced \in BOOLEAN
AcceptedResultUsesActiveEpoch == phase="completed" => accepted=epoch
====

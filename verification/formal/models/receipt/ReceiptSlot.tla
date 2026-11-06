---- MODULE ReceiptSlot ----
EXTENDS Naturals, FiniteSets
CONSTANTS MaxAttempts, GuardSlot, GuardPromise, GuardGeneration, GuardFailedClear, WrongGeneration
VARIABLES g, slot, provider, refreshes, flight, receipt, receiptG,
          state, originSlot, originG, starts, staleAdopted, cancelledNew
Tokens == 1..MaxAttempts
vars == <<g,slot,provider,refreshes,flight,receipt,receiptG,state,originSlot,originG,starts,staleAdopted,cancelledNew>>
Init == /\ g=0 /\ slot=0 /\ provider=0 /\ refreshes=0 /\ flight=0 /\ receipt=0 /\ receiptG=0
        /\ state=[t \in Tokens |-> "unused"] /\ originSlot=[t \in Tokens |-> 0]
        /\ originG=[t \in Tokens |-> 0] /\ starts=0 /\ staleAdopted=FALSE /\ cancelledNew=FALSE
Begin == /\ receipt=0 /\ flight=0 /\ starts < MaxAttempts
         /\ LET t == starts+1 IN
              /\ state'=[state EXCEPT ![t]="pending"]
              /\ originSlot'=[originSlot EXCEPT ![t]=slot]
              /\ originG'=[originG EXCEPT ![t]=g]
              /\ flight'=t
         /\ starts'=starts+1
         /\ UNCHANGED <<g,slot,provider,refreshes,receipt,receiptG,staleAdopted,cancelledNew>>
Replan == /\ refreshes=0 /\ provider'=provider+1 /\ refreshes'=1
          /\ UNCHANGED <<g,slot,flight,receipt,receiptG,state,originSlot,originG,starts,staleAdopted,cancelledNew>>
Advance == /\ g=0 /\ g'=1 /\ slot'=1 /\ provider'=provider+1 /\ flight'=0 /\ receipt'=0 /\ receiptG'=1
           /\ UNCHANGED <<refreshes,state,originSlot,originG,starts,staleAdopted,cancelledNew>>
Success(t) == /\ state[t]="pending"
              /\ LET rg == IF WrongGeneration THEN 1-originG[t] ELSE originG[t]
                     current == ((GuardSlot => slot=originSlot[t])
                                /\ (GuardPromise => flight=t)
                                /\ (GuardGeneration => g=rg))
                 IN /\ receipt'=IF current THEN t ELSE receipt
                    /\ receiptG'=IF current THEN rg ELSE receiptG
                    /\ flight'=IF current THEN 0 ELSE flight
                    /\ staleAdopted'=(staleAdopted \/ (current /\ (slot#originSlot[t] \/ flight#t \/ g#rg)))
              /\ state'=[state EXCEPT ![t]="resolved"]
              /\ UNCHANGED <<g,slot,provider,refreshes,originSlot,originG,starts,cancelledNew>>
Failure(t) == /\ state[t]="pending"
              /\ LET clear == ~GuardFailedClear \/ (slot=originSlot[t] /\ flight=t)
                 IN /\ cancelledNew'=(cancelledNew \/ (clear /\ flight#0 /\ flight#t))
                    /\ flight'=IF clear THEN 0 ELSE flight
              /\ state'=[state EXCEPT ![t]="failed"]
              /\ UNCHANGED <<g,slot,provider,refreshes,receipt,receiptG,originSlot,originG,starts,staleAdopted>>
Stay == /\ \A t \in Tokens : state[t] # "pending"
        /\ receipt#0 \/ flight#0 \/ starts=MaxAttempts
        /\ UNCHANGED vars
Next == Begin \/ Replan \/ Advance \/ (\E t \in Tokens : Success(t) \/ Failure(t)) \/ Stay
Spec == Init /\ [][Next]_vars
TypeOK == /\ g \in 0..1 /\ slot=g /\ provider=g+refreshes /\ refreshes \in 0..1
          /\ flight \in 0..MaxAttempts /\ receipt \in 0..MaxAttempts /\ starts \in 0..MaxAttempts
          /\ state \in [Tokens -> {"unused","pending","resolved","failed"}]
ReceiptCurrentGeneration == receipt=0 \/ receiptG=g
NoStaleAdoption == ~staleAdopted
OldFailureCannotClearNew == ~cancelledNew
====

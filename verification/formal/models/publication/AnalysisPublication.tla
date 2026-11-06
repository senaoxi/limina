---- MODULE AnalysisPublication ----
EXTENDS Naturals
CONSTANTS Policy, ConfigKnown, SavedQualified, MaxDrifts, RespectCAS, RespectFinalValidation, RetryEffects
VARIABLES phase, input, observed, epoch, capturedEpoch, retries, provider,
          configStable, externalIndex, baseline, index, restored, commands,
          published, badPublish, rejected, storageFailure
vars == <<phase,input,observed,epoch,capturedEpoch,retries,provider,configStable,
          externalIndex,baseline,index,restored,commands,published,badPublish,rejected,storageFailure>>
Enabled == Policy # "disabled"
MayPublish == Policy \in {"write","force"} /\ ConfigKnown
Init == /\ phase="before-command" /\ input=0 /\ observed=0 /\ epoch=0 /\ capturedEpoch=0
        /\ retries=0 /\ provider=0 /\ configStable=TRUE /\ externalIndex=FALSE
        /\ baseline=0 /\ index=0 /\ commands=0 /\ published=FALSE /\ badPublish=FALSE
        /\ rejected=FALSE /\ storageFailure=FALSE
        /\ restored=(Enabled /\ Policy # "force" /\ ConfigKnown /\ SavedQualified)
ExecuteCommand == /\ phase="before-command" /\ commands'=1 /\ phase'="ready"
                  /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,published,badPublish,rejected,storageFailure>>
BeginAnalysis == /\ phase="ready" /\ phase'="analyzing" /\ observed'=input /\ capturedEpoch'=epoch
                 /\ UNCHANGED <<input,epoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,rejected,storageFailure>>
InputDrift == /\ phase \in {"analyzing","checked","lease","blocks"} /\ input < MaxDrifts
              /\ input'=input+1
              /\ UNCHANGED <<phase,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,rejected,storageFailure>>
ConfigurationDrift == /\ phase \in {"analyzing","checked","lease","blocks"} /\ configStable
                      /\ configStable'=FALSE
                      /\ UNCHANGED <<phase,input,observed,epoch,capturedEpoch,retries,provider,externalIndex,baseline,index,restored,commands,published,badPublish,rejected,storageFailure>>
OtherIndexWrite == /\ phase \in {"ready","analyzing","checked","lease","blocks"} /\ ~externalIndex
                   /\ index'=1 /\ externalIndex'=TRUE
                   /\ UNCHANGED <<phase,input,observed,epoch,capturedEpoch,retries,provider,configStable,baseline,restored,commands,published,badPublish,rejected,storageFailure>>
RetryAnalysis == /\ phase="analyzing" /\ Enabled /\ configStable /\ observed#input /\ retries=0
                 /\ retries'=1 /\ epoch'=epoch+1 /\ capturedEpoch'=epoch+1 /\ provider'=provider+1 /\ observed'=input
                 /\ commands'=IF RetryEffects THEN commands+1 ELSE commands
                 /\ UNCHANGED <<phase,input,configStable,externalIndex,baseline,index,restored,published,badPublish,rejected,storageFailure>>
AcceptAnalysis == /\ phase="analyzing" /\ configStable /\ capturedEpoch=epoch
                  /\ (~Enabled \/ observed=input)
                  /\ phase'="checked"
                  /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,rejected,storageFailure>>
AbortAnalysis == /\ phase="analyzing"
                 /\ (~configStable \/ (Enabled /\ observed#input /\ retries=1))
                 /\ phase'="aborted" /\ rejected'=TRUE
                 /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,storageFailure>>
EnterPublication == /\ phase="checked"
                    /\ IF ~configStable \/ (Enabled /\ observed#input)
                          THEN /\ phase'="aborted" /\ rejected'=TRUE
                          ELSE /\ phase'=IF MayPublish THEN "lease" ELSE "closed"
                               /\ UNCHANGED rejected
                    /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,storageFailure>>
WriteBlocks == /\ phase="lease"
               /\ IF ~configStable \/ observed#input
                     THEN /\ phase'="aborted" /\ rejected'=TRUE
                     ELSE /\ phase'=IF RespectCAS /\ index#baseline THEN "skipped" ELSE "blocks"
                          /\ UNCHANGED rejected
               /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,storageFailure>>
CommitIndex == /\ phase="blocks"
               /\ IF (RespectFinalValidation /\ (~configStable \/ observed#input)) \/ (RespectCAS /\ index#baseline)
                     THEN /\ phase'="aborted" /\ rejected'=TRUE /\ UNCHANGED <<index,published,badPublish>>
                     ELSE /\ phase'="closed" /\ published'=TRUE /\ index'=2
                          /\ badPublish'=(~MayPublish \/ ~configStable \/ observed#input \/ index#baseline)
                          /\ UNCHANGED rejected
               /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,restored,commands,storageFailure>>
StorageFailure == /\ phase="blocks" /\ phase'="skipped" /\ storageFailure'=TRUE
                  /\ UNCHANGED <<input,observed,epoch,capturedEpoch,retries,provider,configStable,externalIndex,baseline,index,restored,commands,published,badPublish,rejected>>
Stay == phase \in {"closed","aborted","skipped"} /\ UNCHANGED vars
Next == ExecuteCommand \/ BeginAnalysis \/ InputDrift \/ ConfigurationDrift \/ OtherIndexWrite
        \/ RetryAnalysis \/ AcceptAnalysis \/ AbortAnalysis \/ EnterPublication \/ WriteBlocks \/ CommitIndex \/ StorageFailure \/ Stay
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"before-command","ready","analyzing","checked","lease","blocks","closed","aborted","skipped"}
          /\ input \in 0..MaxDrifts /\ observed \in 0..MaxDrifts /\ retries \in 0..1 /\ epoch=retries /\ provider=retries
          /\ index \in 0..2 /\ commands \in 0..2
NoEffectReplay == commands<=1
RestorePolicy == restored => (Enabled /\ Policy#"force" /\ ConfigKnown /\ SavedQualified)
PublishPolicy == published => MayPublish
NoStalePublication == ~badPublish
====

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneWorkflowData, normalizeRestoredState, type GrillWorkflowData } from "./state.ts";

export const GRILL_STATE_ENTRY = "pi-grill-wizard-state";

interface PersistedSnapshot {
  sessionId: string;
  workflow: GrillWorkflowData;
}

export function createSnapshot(sessionId: string, workflow: GrillWorkflowData): PersistedSnapshot {
  return { sessionId, workflow: cloneWorkflowData(workflow) };
}

export function persistWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, workflow: GrillWorkflowData): void {
  pi.appendEntry(GRILL_STATE_ENTRY, createSnapshot(ctx.sessionManager.getSessionId(), workflow));
}

export function restoreWorkflow(ctx: ExtensionContext): { workflow: GrillWorkflowData; sourceSessionId?: string } {
  const entry = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find(
      (candidate: { type: string; customType?: string }) =>
        candidate.type === "custom" && candidate.customType === GRILL_STATE_ENTRY,
    ) as { data?: Partial<PersistedSnapshot> } | undefined;

  return {
    workflow: normalizeRestoredState(entry?.data?.workflow),
    sourceSessionId: typeof entry?.data?.sessionId === "string" ? entry.data.sessionId : undefined,
  };
}

export function requiresApprovalReview(
  workflow: GrillWorkflowData,
  sourceSessionId: string | undefined,
  currentSessionId: string,
): boolean {
  return (
    (workflow.state === "approved" || workflow.state === "implementing") &&
    (sourceSessionId !== currentSessionId || workflow.approvedSessionId !== currentSessionId)
  );
}

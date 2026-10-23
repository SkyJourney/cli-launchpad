import type { PtyTerminalHandle } from "../../components/PtyTerminal";
import type { WorkspaceHostStore } from "../host/workspaceHostStore";
import type {
  WorkspaceCloseInput,
  WorkspaceContentDomain,
  WorkspaceContentRefOf,
  WorkspaceCloseResult,
} from "./workspaceDomainTable";

export interface PtyContentDomainDeps {
  store: WorkspaceHostStore;
  terminalRefs: {
    current: Map<string, Pick<PtyTerminalHandle, "closeSession">>;
  };
  isWindowOwned: (ref: WorkspaceContentRefOf<"pty">) => boolean;
  titleOf: (ref: WorkspaceContentRefOf<"pty">) => string;
  removeSlot: (
    instanceId: string,
    options: { disposeOwnerEnded: boolean },
  ) => void;
}

export function createPtyContentDomain(
  deps: PtyContentDomainDeps,
): WorkspaceContentDomain<"pty"> {
  return {
    kind: "pty",
    closeInput: (ref): WorkspaceCloseInput | undefined => {
      const live = deps.store.getLive();
      const slot = live.slots.find((entry) => entry.instanceId === ref.slotId);
      if (!slot || deps.isWindowOwned(ref)) return undefined;
      const session = slot.sessionId
        ? live.ptySessionsById[slot.sessionId]
        : undefined;
      return {
        title: deps.titleOf(ref),
        isDirty: false,
        isRunning: session?.state === "running",
      };
    },
    close: async (refs): Promise<WorkspaceCloseResult> => {
      const outcomes = await Promise.all(
        refs.map(async (ref) => {
          const slot = deps.store
            .getLive()
            .slots.find((entry) => entry.instanceId === ref.slotId);
          if (!slot)
            return { ref, result: "cancelled" as const, slot: undefined };
          if (slot.restoredState) {
            return { ref, result: "closed" as const, slot };
          }
          const terminal = deps.terminalRefs.current.get(slot.instanceId);
          if (!terminal) return { ref, result: "cancelled" as const, slot };
          try {
            return {
              ref,
              result: await terminal.closeSession(false),
              slot,
            };
          } catch {
            return { ref, result: "cancelled" as const, slot };
          }
        }),
      );
      const closed: WorkspaceCloseResult["closed"] = [];
      const pending: WorkspaceCloseResult["pending"] = [];
      const failed: WorkspaceCloseResult["failed"] = [];
      for (const outcome of outcomes) {
        if (outcome.result === "cancelled" || !outcome.slot) {
          failed.push(outcome.ref);
          continue;
        }
        if (outcome.result === "closed") {
          deps.removeSlot(outcome.slot.instanceId, {
            disposeOwnerEnded: false,
          });
          closed.push(outcome.ref);
          continue;
        }
        pending.push(outcome.ref);
      }
      return { closed, pending, failed };
    },
  };
}

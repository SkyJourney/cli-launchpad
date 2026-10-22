import type { WorkspaceContentHandoffHookContext } from "../../components/workspaceContentAdapterRegistry";
import { rollbackWorkspaceContentHandoff } from "../../components/workspaceContentHandoffRuntime";
import type { WorkspaceContentHandoffPayloadByKind } from "../../lib/workspaceContentLifecycle";
import type { RegisteredContentKind } from "../../generated/contentKinds";

// A handoff rolls back once. The owner-query fallback and the detach caller's catch can both reach
// the same context, and the second rollback would only repeat the Rust cancel.
const rolledBackHandoffs = new WeakSet<object>();
export function rollbackHandoffOnce<Kind extends RegisteredContentKind>(
  context: WorkspaceContentHandoffHookContext<Kind>,
  payload: WorkspaceContentHandoffPayloadByKind[Kind] | undefined,
  reason: unknown,
): Promise<void> {
  if (rolledBackHandoffs.has(context)) return Promise.resolve();
  rolledBackHandoffs.add(context);
  return rollbackWorkspaceContentHandoff(context, payload, reason);
}

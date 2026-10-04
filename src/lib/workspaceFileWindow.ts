export interface WorkspaceFileWindowIdentity {
  documentId: string;
  token: string;
  windowLabel: string;
}

export function matchesWorkspaceFileWindow(
  expected: WorkspaceFileWindowIdentity,
  actual: WorkspaceFileWindowIdentity,
): boolean {
  return (
    expected.documentId === actual.documentId &&
    expected.token === actual.token &&
    expected.windowLabel === actual.windowLabel &&
    /^workspace-content-[0-9a-f-]{36}$/i.test(actual.windowLabel)
  );
}

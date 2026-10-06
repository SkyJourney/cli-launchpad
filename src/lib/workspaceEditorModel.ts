export function createWorkspaceEditorModelUri(
  directoryId: number,
  relativePath: string,
  documentKey: string,
  epoch = 0,
): string {
  const encodedPath = relativePath
    .split(/[\\/]/)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const query = new URLSearchParams({
    document: documentKey,
    epoch: String(epoch),
  });
  return `file:///cli-launchpad/${directoryId}/${encodedPath}?${query}`;
}

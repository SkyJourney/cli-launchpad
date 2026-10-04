export function createWorkspaceEditorModelUri(
  directoryId: number,
  relativePath: string,
): string {
  const encodedPath = relativePath
    .split(/[\\/]/)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file:///cli-launchpad/${directoryId}/${encodedPath}`;
}

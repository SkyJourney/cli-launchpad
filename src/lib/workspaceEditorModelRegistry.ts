const modelUrisByDocument = new Map<string, Set<string>>();

export function registerWorkspaceEditorModel(
  documentKey: string,
  modelUri: string,
): void {
  const uris = modelUrisByDocument.get(documentKey) ?? new Set<string>();
  uris.add(modelUri);
  modelUrisByDocument.set(documentKey, uris);
}

export function takeWorkspaceEditorModelUris(documentKey: string): string[] {
  const uris = modelUrisByDocument.get(documentKey);
  modelUrisByDocument.delete(documentKey);
  return uris ? [...uris] : [];
}

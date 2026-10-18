import contentKindManifest from "../../contracts/content-kinds.json";
import manifest from "../../contracts/window-kinds.json";

export type WindowKind = "main" | "terminal" | "workspaceContent";
/** Every registered window kind; windowKinds.test.ts compares it with the contract. */
export const WINDOW_KINDS: readonly WindowKind[] = [
  "main",
  "terminal",
  "workspaceContent",
];
export type DetachedWindowKind = Exclude<WindowKind, "main">;

interface WindowKindDefinition {
  id: WindowKind;
  label?: string;
  labelPrefix?: string;
  route: string;
  primary: boolean;
  ptyHost: boolean;
  ownsPty: boolean;
  fileGrant: boolean;
  contentKinds: readonly string[];
}

const definitions = manifest.items as unknown as WindowKindDefinition[];

const detachedLabelSuffix =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function windowKindOf(label: string): WindowKind | null {
  for (const definition of definitions) {
    if (definition.label === label) return definition.id;
    if (
      definition.labelPrefix &&
      label.startsWith(definition.labelPrefix) &&
      detachedLabelSuffix.test(label.slice(definition.labelPrefix.length))
    ) {
      return definition.id;
    }
  }
  return null;
}

export function createWindowLabel(kind: DetachedWindowKind): string {
  const definition = definitions.find((candidate) => candidate.id === kind);
  if (!definition?.labelPrefix) {
    throw new Error(`窗口类别没有 label 前缀：${kind}`);
  }
  return `${definition.labelPrefix}${crypto.randomUUID()}`;
}

export function isDetachedWindowLabel(label: string): boolean {
  const kind = windowKindOf(label);
  return kind !== null && kind !== "main";
}

export function windowLabelPrefix(kind: DetachedWindowKind): string {
  const definition = definitions.find((candidate) => candidate.id === kind);
  if (!definition?.labelPrefix) {
    throw new Error(`窗口类别没有 label 前缀：${kind}`);
  }
  return definition.labelPrefix;
}

export function windowRouteOf(label: string): string | null {
  const kind = windowKindOf(label);
  return (
    definitions.find((definition) => definition.id === kind)?.route ?? null
  );
}

export interface ContentKindDefinition {
  id: string;
  windowKind: WindowKind;
  dragAllowed: boolean;
}

const contentDefinitions =
  contentKindManifest.items as unknown as ContentKindDefinition[];

/** The label of the single primary (main) window, taken from the contract. */
export const MAIN_WINDOW_LABEL: string = (() => {
  const primary = definitions.find((definition) => definition.primary);
  if (!primary?.label) throw new Error("契约里没有 primary 窗口类别的 label");
  return primary.label;
})();

export function windowRoleOf(kind: WindowKind) {
  const definition = definitions.find((candidate) => candidate.id === kind);
  if (!definition) throw new Error(`未登记的窗口类别：${kind}`);
  return {
    primary: definition.primary,
    ptyHost: definition.ptyHost,
    ownsPty: definition.ownsPty,
    fileGrant: definition.fileGrant,
    contentKinds: definition.contentKinds,
  } as const;
}

export function registeredContentKinds(): readonly string[] {
  return contentDefinitions.map((definition) => definition.id);
}

export function windowKindOfContent(contentKind: string): WindowKind | null {
  return (
    contentDefinitions.find((definition) => definition.id === contentKind)
      ?.windowKind ?? null
  );
}

export function isDraggableContentKind(contentKind: string): boolean {
  return (
    contentDefinitions.find((definition) => definition.id === contentKind)
      ?.dragAllowed === true
  );
}

export function contentKindsOf(kind: WindowKind): readonly string[] {
  return windowRoleOf(kind).contentKinds;
}

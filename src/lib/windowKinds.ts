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
  route?: string;
}

const definitions = manifest.kinds as unknown as WindowKindDefinition[];

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

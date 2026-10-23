import apiVersions from "../../contracts/api-versions.json";

type ApiVersionId = (typeof apiVersions.items)[number]["id"];

function versionOf(id: ApiVersionId): number {
  const entry = apiVersions.items.find((item) => item.id === id);
  if (!entry) throw new Error(`api-versions.json 缺少 ${id}`);
  return entry.version;
}

/** 内容 adapter 契约版本：唯一来源是 contracts/api-versions.json。 */
export const WORKSPACE_CONTENT_ADAPTER_API_VERSION: number = versionOf(
  "workspaceContentAdapter",
);

/** 编辑器引擎契约版本。破坏性改动才递增。 */
export const WORKSPACE_EDITOR_ENGINE_API_VERSION: number = versionOf(
  "workspaceEditorEngine",
);

/** 主题契约版本。破坏性改动才递增。 */
export const THEME_API_VERSION: number = versionOf("theme");

export { versionOf as apiVersionOf };

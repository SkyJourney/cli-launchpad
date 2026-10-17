import contentKinds from "../../contracts/content-kinds.json";

/** 内容 adapter 契约版本：唯一来源是 contracts/content-kinds.json 的 adapterApiVersion。m6-072 会把它改读 contracts/api-versions.json。 */
export const WORKSPACE_CONTENT_ADAPTER_API_VERSION: number =
  contentKinds.adapterApiVersion;

/** 编辑器引擎契约版本。破坏性改动才递增。 */
export const WORKSPACE_EDITOR_ENGINE_API_VERSION = 1;

/** 主题契约版本。破坏性改动才递增。 */
export const THEME_API_VERSION = 1;

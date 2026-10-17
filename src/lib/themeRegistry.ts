import { createRegistry } from "./createRegistry";
import { THEME_API_VERSION } from "./extensionApiVersions";
import type { ThemeDefinition } from "./themes";

export const themeRegistry = createRegistry<ThemeDefinition>({
  name: "theme",
  supportedApiVersions: [THEME_API_VERSION],
  messages: {
    emptyId: "主题 ID 不能为空",
    unsupportedApiVersion: (apiVersion) => `不支持主题 API 版本: ${apiVersion}`,
    duplicateId: (id) => `主题 ID 已注册: ${id}`,
  },
});

export function registerTheme(theme: ThemeDefinition): () => void {
  return themeRegistry.register(theme);
}

export function listThemes(): readonly ThemeDefinition[] {
  return themeRegistry.list();
}

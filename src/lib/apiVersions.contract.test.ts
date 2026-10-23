// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import apiVersions from "../../contracts/api-versions.json";
import contentKinds from "../../contracts/content-kinds.json";
import windowMessages from "../../contracts/window-messages.json";
import { APP_PREFERENCES_API_VERSION } from "./appPreferences";
import {
  apiVersionOf,
  THEME_API_VERSION,
  WORKSPACE_CONTENT_ADAPTER_API_VERSION,
  WORKSPACE_EDITOR_ENGINE_API_VERSION,
} from "./extensionApiVersions";
import { WINDOW_MESSAGE_API_VERSION } from "./windowMessages";

const dragSource = Object.values(
  import.meta.glob("./workspaceContentDrag.ts", {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>,
)[0];

describe("api versions contract", () => {
  it("is the only source of the extension point API versions", () => {
    expect(WORKSPACE_CONTENT_ADAPTER_API_VERSION).toBe(
      apiVersionOf("workspaceContentAdapter"),
    );
    expect(WORKSPACE_EDITOR_ENGINE_API_VERSION).toBe(
      apiVersionOf("workspaceEditorEngine"),
    );
    expect(THEME_API_VERSION).toBe(apiVersionOf("theme"));
    expect(apiVersions.items.map((item) => item.id)).toEqual(
      [...apiVersions.items.map((item) => item.id)].sort(),
    );
    // 反向断言：旧位置不再有 adapterApiVersion。
    expect("adapterApiVersion" in contentKinds).toBe(false);
    expect(() => apiVersionOf("missing" as never)).toThrow(
      "api-versions.json 缺少 missing",
    );
  });

  it("keeps the wire protocol constants equal to the contract", () => {
    expect(APP_PREFERENCES_API_VERSION).toBe(apiVersionOf("appPreferences"));
    expect(WINDOW_MESSAGE_API_VERSION).toBe(apiVersionOf("windowMessage"));
    expect(
      dragSource.includes(
        `cli-launchpad-content-v${apiVersionOf("workspaceContentDrag")}:`,
      ),
    ).toBe(true);
    for (const message of windowMessages.items) {
      expect(message.payloadVersion, message.type).toBe(
        apiVersionOf("windowMessage"),
      );
    }
  });
});

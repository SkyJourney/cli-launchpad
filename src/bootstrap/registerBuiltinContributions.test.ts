import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceContentAdapter } from "../components/workspaceContentAdapterRegistry";
import { resolveEditorEngine } from "../components/workspaceEditorEngineRegistry";
import { registerBuiltinContributions } from "./registerBuiltinContributions";

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("built-in contribution bootstrap", () => {
  it("registers adapters and the editor before any view module is imported", () => {
    unregister = registerBuiltinContributions();

    expect(getWorkspaceContentAdapter("pty").id).toBe("core.pty");
    expect(getWorkspaceContentAdapter("file").id).toBe("core.file-editor");
    expect(resolveEditorEngine()?.id).toBe("core.monaco");
  });

  it("is idempotent and its cleanup permits registration again", () => {
    unregister = registerBuiltinContributions();
    expect(registerBuiltinContributions()).toBe(unregister);

    unregister();
    unregister = registerBuiltinContributions();

    expect(getWorkspaceContentAdapter("pty").id).toBe("core.pty");
  });
});

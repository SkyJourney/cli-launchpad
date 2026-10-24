// @vitest-environment node
import { describe, expect, it } from "vitest";
import appCommands from "../../contracts/app-commands.json";
import windowKinds from "../../contracts/window-kinds.json";

type Check = { name: string; callerCheck: string };
/** The window kinds the contract grants a command to; "all" grants every command. */
function grantedKinds(command: string): string[] {
  return windowKinds.items
    .filter((kind) => {
      const grant = kind.appCommands as unknown;
      return grant === "all" || (Array.isArray(grant) && grant.includes(command));
    })
    .map((kind) => kind.id);
}
const entries = appCommands.items as unknown as Check[];
const commandNames = entries.map((entry) => entry.name);

describe("command caller checks", () => {
  it("declares a caller check for every registered app command", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [...commandNames].sort(),
    );
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(
      entries.length,
    );
    for (const entry of entries) {
      expect(["require", "acl-only"], entry.name).toContain(entry.callerCheck);
    }
    // Reverse: the contract is as large as the command list.
    expect(entries.length).toBe(commandNames.length);
    expect(entries.length).toBeGreaterThanOrEqual(72);
  });

  it("requires a caller check for every command granted to a child window kind", () => {
    let checked = 0;
    for (const kind of windowKinds.items) {
      if (kind.id === "main") continue;
      const granted = kind.appCommands as string[];
      for (const command of granted) {
        const entry = entries.find((candidate) => candidate.name === command);
        expect(entry?.callerCheck, `${kind.id}: ${command}`).toBe("require");
        expect(grantedKinds(command), `${kind.id}: ${command}`).toContain(kind.id);
        checked += 1;
      }
    }
    // Every acl-only command stays out of the child window kinds.
    const childCommands = new Set(
      windowKinds.items
        .filter((kind) => kind.id !== "main")
        .flatMap((kind) => kind.appCommands as string[]),
    );
    for (const entry of entries.filter((e) => e.callerCheck === "acl-only")) {
      expect(childCommands.has(entry.name), entry.name).toBe(false);
    }
    // Reverse: terminal 14 + workspaceContent 5 commands were all checked.
    const childPairs = windowKinds.items
      .filter((kind) => kind.id !== "main")
      .reduce((total, kind) => total + (kind.appCommands as string[]).length, 0);
    expect(checked).toBe(childPairs);
  });

  it("declares the documented main-window commands as require", () => {
    const required = [
      "confirm_app_exit",
      "restore_backup",
      "import_config_from_path",
      "set_close_behavior",
      "set_tray_menu_labels",
      "take_startup_notices",
      "create_pty_session",
      "reattach_pty_session",
      "grant_content_window_file",
      "revoke_content_window_file",
      "open_granted_file",
      "save_granted_text_file",
      "subscribe_window_inbox",
      "send_window_message",
      "report_window_sync_failure",
    ];
    for (const command of required) {
      expect(
        entries.find((entry) => entry.name === command)?.callerCheck,
        command,
      ).toBe("require");
    }
    // Reverse: ordinary main-window commands stay acl-only.
    for (const command of [
      "list_directories",
      "add_directory",
      "remove_directory",
      "save_project_text_file",
    ]) {
      expect(
        entries.find((entry) => entry.name === command)?.callerCheck,
        command,
      ).toBe("acl-only");
    }
  });

  it("keeps the caller check inside the app command manifest and has no companion file", () => {
    const files = Object.keys(import.meta.glob("../../contracts/*.json"));

    expect(
      files.some((file) => file.endsWith("/command-caller-checks.json")),
    ).toBe(false);
    expect(files.some((file) => file.endsWith("/app-commands.json"))).toBe(
      true,
    );
    for (const item of appCommands.items as unknown as Check[]) {
      expect(["require", "acl-only"], item.name).toContain(item.callerCheck);
      expect("command" in item, item.name).toBe(false);
    }
  });
});

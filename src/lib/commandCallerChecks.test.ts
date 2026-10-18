// @vitest-environment node
import { describe, expect, it } from "vitest";
import appCommands from "../../contracts/app-commands.json";
import checks from "../../contracts/command-caller-checks.json";
import windowKinds from "../../contracts/window-kinds.json";

type Check = { command: string; callerCheck: string; kinds?: string[] };
const entries = checks.items as Check[];

describe("command caller checks", () => {
  it("declares a caller check for every registered app command", () => {
    expect(entries.map((entry) => entry.command).sort()).toEqual(
      [...appCommands.items].sort(),
    );
    expect(new Set(entries.map((entry) => entry.command)).size).toBe(
      entries.length,
    );
    for (const entry of entries) {
      expect(["require", "acl-only"], entry.command).toContain(
        entry.callerCheck,
      );
    }
    // Reverse: the contract is as large as the command list.
    expect(entries.length).toBe(appCommands.items.length);
    expect(entries.length).toBeGreaterThanOrEqual(72);
  });

  it("requires a caller check for every command granted to a child window kind", () => {
    let checked = 0;
    for (const kind of windowKinds.items) {
      if (kind.id === "main") continue;
      const granted = kind.appCommands as string[];
      for (const command of granted) {
        const entry = entries.find(
          (candidate) => candidate.command === command,
        );
        expect(entry?.callerCheck, `${kind.id}: ${command}`).toBe("require");
        expect(entry?.kinds, `${kind.id}: ${command}`).toContain(kind.id);
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
      expect(childCommands.has(entry.command), entry.command).toBe(false);
    }
    // Reverse: terminal 14 + workspaceContent 5 commands were all checked.
    expect(checked).toBe(19);
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
        entries.find((entry) => entry.command === command)?.callerCheck,
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
        entries.find((entry) => entry.command === command)?.callerCheck,
        command,
      ).toBe("acl-only");
    }
  });
});

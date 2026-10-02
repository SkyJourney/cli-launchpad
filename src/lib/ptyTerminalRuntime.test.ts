import { describe, expect, it } from "vitest";
import { isClipboardTextUnavailable } from "./ptyTerminalRuntime";

describe("PTY terminal clipboard errors", () => {
  it("treats an empty clipboard as an unavailable optional text payload", () => {
    expect(isClipboardTextUnavailable("Clipboard is empty")).toBe(true);
  });

  it("treats a non-text clipboard format as unavailable text", () => {
    expect(
      isClipboardTextUnavailable(
        "not available in the requested format: clipboard",
      ),
    ).toBe(true);
  });

  it("preserves unrelated clipboard failures for the user", () => {
    expect(isClipboardTextUnavailable("clipboard permission denied")).toBe(
      false,
    );
  });
});

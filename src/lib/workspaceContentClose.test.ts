import { describe, expect, it, vi } from "vitest";
import {
  requestWorkspaceContentClose,
  shouldCloseWorkspaceContent,
  shouldCloseWorkspaceWindow,
  type WorkspaceContentBeforeCloseContext,
} from "./workspaceContentClose";

describe("workspace content close adapters", () => {
  it("allows a window close when no adapter hook is provided", () => {
    expect(shouldCloseWorkspaceWindow(undefined)).toBe(true);
  });

  it("lets an adapter allow or veto the shared native window close action", () => {
    expect(shouldCloseWorkspaceWindow(() => true)).toBe(true);
    expect(shouldCloseWorkspaceWindow(() => false)).toBe(false);
  });

  it("continues closing by default when an adapter has no hook", () => {
    expect(
      shouldCloseWorkspaceContent(undefined, {
        isDirty: false,
        confirmDiscard: () => false,
      }),
    ).toBe(true);
  });

  it("lets an adapter veto the default close action", () => {
    expect(
      shouldCloseWorkspaceContent(() => false, {
        isDirty: false,
        confirmDiscard: () => true,
      }),
    ).toBe(false);
  });

  it("runs the adapter hook before a dirty file is closed", () => {
    const confirmDiscard = vi.fn(() => false);
    const fileBeforeClose = ({
      isDirty,
      confirmDiscard: confirm,
    }: {
      isDirty: boolean;
      confirmDiscard: () => boolean;
    }) => !isDirty || confirm();

    expect(
      shouldCloseWorkspaceContent(fileBeforeClose, {
        isDirty: true,
        confirmDiscard,
      }),
    ).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("does not ask to discard when the content is clean", () => {
    const confirmDiscard = vi.fn(() => false);
    const fileBeforeClose = ({
      isDirty,
      confirmDiscard: confirm,
    }: {
      isDirty: boolean;
      confirmDiscard: () => boolean;
    }) => !isDirty || confirm();

    expect(
      shouldCloseWorkspaceContent(fileBeforeClose, {
        isDirty: false,
        confirmDiscard,
      }),
    ).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("runs the shared close action only after adapter approval", () => {
    const close = vi.fn();
    const hook = vi.fn(
      ({ isDirty, confirmDiscard }: WorkspaceContentBeforeCloseContext) =>
        !isDirty || confirmDiscard(),
    );
    const context = { isDirty: true, confirmDiscard: () => false };

    expect(requestWorkspaceContentClose(hook, context, close)).toBe(false);
    expect(close).not.toHaveBeenCalled();

    expect(
      requestWorkspaceContentClose(
        hook,
        { ...context, confirmDiscard: () => true },
        close,
      ),
    ).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});

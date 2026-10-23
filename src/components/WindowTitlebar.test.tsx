// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock(
  "sonner",
  async () => (await import("../test/host/hostMocks")).sonnerMock,
);

import { toastSpy } from "../test/host/hostMocks";
import { tauriMock } from "../test/tauriMock";

const originalUserAgent = navigator.userAgent;
let WindowTitlebar: typeof import("./WindowTitlebar").WindowTitlebar;

beforeAll(async () => {
  // The module reads the user agent when it loads: pin a platform with custom window controls.
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    configurable: true,
  });
  ({ WindowTitlebar } = await import("./WindowTitlebar"));
  Object.defineProperty(navigator, "userAgent", {
    value: originalUserAgent,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

/** Window actions the component asked the (mocked) main window to perform, in order. */
function windowActions() {
  return tauriMock.state.windowActions.map((entry) => entry.action);
}

function renderTitlebar(leading?: React.ReactNode) {
  const view = render(<WindowTitlebar variant="main" leading={leading} />);
  const dragRegion = view.container.querySelector(
    ".window-titlebar-drag-region",
  ) as HTMLElement;
  return { ...view, dragRegion };
}

/** The resize listener is registered asynchronously after mount; wait until the component owns it. */
async function settleResizeListener() {
  await vi.waitFor(() => {
    expect(
      tauriMock.state.eventListeners.filter(
        (listener) => listener.eventName === "tauri://resize",
      ),
    ).toHaveLength(1);
  });
  // Let the registration promise resolve so the component holds its unlisten function.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WindowTitlebar", () => {
  it("starts dragging on primary mousedown in the drag region", async () => {
    const { dragRegion } = renderTitlebar(
      <>
        <button type="button">plain child</button>
        <span data-window-drag-handle>handle</span>
      </>,
    );
    await settleResizeListener();

    fireEvent.mouseDown(dragRegion, { button: 0, detail: 1 });
    expect(windowActions()).toEqual(["startDragging"]);

    // Reverse: a secondary button does not drag.
    fireEvent.mouseDown(dragRegion, { button: 2, detail: 1 });
    expect(windowActions()).toEqual(["startDragging"]);

    // Reverse: an interactive child of the leading area is not a drag surface...
    fireEvent.mouseDown(screen.getByText("plain child"), {
      button: 0,
      detail: 1,
    });
    expect(windowActions()).toEqual(["startDragging"]);

    // ...but an element marked as a drag handle is.
    fireEvent.mouseDown(screen.getByText("handle"), { button: 0, detail: 1 });
    expect(windowActions()).toEqual(["startDragging", "startDragging"]);
  });

  it("toggles maximize on double click and ignores the second mousedown of a double click", async () => {
    const { dragRegion } = renderTitlebar();
    await settleResizeListener();

    // The second mousedown of a double click carries detail 2 and must not start a drag.
    fireEvent.mouseDown(dragRegion, { button: 0, detail: 2 });
    expect(windowActions()).not.toContain("startDragging");

    fireEvent.doubleClick(dragRegion);
    expect(windowActions()).toEqual(["toggleMaximize"]);
  });

  it("invokes minimize, maximize and close from the non-macOS controls", async () => {
    renderTitlebar();
    await settleResizeListener();

    fireEvent.click(
      screen.getByRole("button", { name: "windowChrome.minimize" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "windowChrome.maximize" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "windowChrome.close" }));

    expect(windowActions()).toEqual(["minimize", "toggleMaximize", "close"]);
    // Every action is requested for the window the component runs in, by that same window.
    expect(
      tauriMock.state.windowActions.every(
        (entry) => entry.windowLabel === "main" && entry.callerLabel === "main",
      ),
    ).toBe(true);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it("shows a toast when a window action is rejected", async () => {
    renderTitlebar();
    await settleResizeListener();
    (
      tauriMock.getWindow("main").minimize as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce({ code: "x", message: "denied" });

    fireEvent.click(
      screen.getByRole("button", { name: "windowChrome.minimize" }),
    );

    await vi.waitFor(() => {
      expect(toastSpy.error).toHaveBeenCalledWith("denied");
    });
    expect(toastSpy.error).toHaveBeenCalledTimes(1);
  });

  it("unlistens resize on unmount", async () => {
    const view = renderTitlebar();
    await settleResizeListener();

    view.unmount();

    expect(tauriMock.state.eventListeners).toHaveLength(0);
  });

  it("unlistens resize when unmounted before the registration completes", async () => {
    const view = renderTitlebar();
    // Unmount synchronously: the async onResized registration has not resolved yet.
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(tauriMock.state.eventListeners).toHaveLength(0);
  });
});

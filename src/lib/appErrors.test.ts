import { describe, expect, it } from "vitest";
import {
  getAppErrorCode,
  getAppErrorMessage,
  isProjectIdentityChangedError,
} from "./appErrors";

describe("serialized application errors", () => {
  it("reads a coded IPC error without stringifying the object", () => {
    const error = {
      code: "project_identity_changed",
      message: "The project path changed",
    };
    expect(getAppErrorCode(error)).toBe("project_identity_changed");
    expect(getAppErrorMessage(error)).toBe("The project path changed");
    expect(isProjectIdentityChangedError(error)).toBe(true);
  });

  it("keeps support for ordinary string and Error failures", () => {
    expect(getAppErrorMessage("failed")).toBe("failed");
    expect(getAppErrorMessage(new Error("failed"))).toBe("failed");
    expect(isProjectIdentityChangedError("project_identity_changed")).toBe(
      false,
    );
  });
});

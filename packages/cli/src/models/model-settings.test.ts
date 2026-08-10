import { describe, expect, it } from "vitest";
import { parseSettingValue } from "./model-settings";

describe("parseSettingValue", () => {
  it("preserves string settings", () => {
    expect(parseSettingValue({ type: "string" }, "cn-north-1")).toBe("cn-north-1");
  });

  it("parses number and boolean settings according to the vendor schema", () => {
    expect(parseSettingValue({ type: "number" }, "42")).toBe(42);
    expect(parseSettingValue({ type: "boolean" }, "TRUE")).toBe(true);
    expect(parseSettingValue({ type: "boolean" }, "false")).toBe(false);
  });

  it("rejects values that do not match their declared type", () => {
    expect(() => parseSettingValue({ type: "number" }, "many")).toThrow("valid number");
    expect(() => parseSettingValue({ type: "boolean" }, "yes")).toThrow("true or false");
  });
});

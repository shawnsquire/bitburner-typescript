import { describe, it, expect } from "vitest";
import { parseFeedback } from "/lib/darknet/solvers/types";

describe("parseFeedback", () => {
  it("parses a JSON record with data", () => {
    const line = JSON.stringify({ code: 401, passwordAttempted: "abc", message: "Unauthorized", data: "3 correct" });
    expect(parseFeedback(line)).toEqual({ code: 401, passwordAttempted: "abc", message: "Unauthorized", data: "3 correct" });
  });

  it("parses a JSON record without data (BufferOverflow shape)", () => {
    const line = JSON.stringify({ code: 401, passwordAttempted: "abc", passwordExpected: "xyz", message: "Unauthorized" });
    const parsed = parseFeedback(line);
    expect(parsed).toEqual({ code: 401, passwordAttempted: "abc", message: "Unauthorized" });
    expect(parsed?.data).toBeUndefined();
  });

  it("returns null for a noise line", () => {
    expect(parseFeedback("Connecting to n00dl3s:hunter2 ...")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseFeedback("")).toBeNull();
  });

  it("returns null for JSON that isn't an object (number, null, array)", () => {
    expect(parseFeedback("123")).toBeNull();
    expect(parseFeedback("null")).toBeNull();
    expect(parseFeedback("[1,2,3]")).toBeNull();
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(parseFeedback(JSON.stringify({ passwordAttempted: "abc", message: "x" }))).toBeNull();
    expect(parseFeedback(JSON.stringify({ code: "401", passwordAttempted: "abc", message: "x" }))).toBeNull();
  });

  it("keeps elapsedMs when present", () => {
    const line = JSON.stringify({ code: 401, passwordAttempted: "abc", message: "Unauthorized", elapsedMs: 42 });
    expect(parseFeedback(line)?.elapsedMs).toBe(42);
  });
});

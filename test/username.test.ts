import { describe, it, expect } from "vitest";
import { validateUsername, buildAddress } from "../src/username";

describe("validateUsername", () => {
  it("accepts and lowercases", () => {
    expect(validateUsername("Alice")).toEqual({ ok: true, username: "alice" });
    expect(validateUsername("a-b_c.d9")).toEqual({ ok: true, username: "a-b_c.d9" });
    expect(validateUsername("abc")).toEqual({ ok: true, username: "abc" });
    expect(validateUsername("a".repeat(32))).toEqual({ ok: true, username: "a".repeat(32) });
  });
  it("rejects", () => {
    for (const bad of ["", "a", "ab", "A..b", "a..b", "-x", "x-", ".abc", "abc.", "a b", "a".repeat(33), "üser", "alice@evil.com", "inbox/../x"]) {
      expect(validateUsername(bad).ok, bad).toBe(false);
    }
  });
});
describe("buildAddress", () => {
  it("joins with domain", () => {
    expect(buildAddress("alice", "mail.example.com")).toBe("alice@mail.example.com");
  });
});

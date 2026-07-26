import { describe, it, expect } from "vitest";
import { passwordProblem, hasEmailIdentity } from "./account";
import type { User, UserIdentity } from "@supabase/supabase-js";

const userWith = (providers: string[]) => ({
  identities: providers.map(provider => ({ provider } as UserIdentity)),
} as User);

describe("passwordProblem", () => {
  it("rejects a password shorter than the server minimum", () => {
    expect(passwordProblem("Abcdefghij1", "Abcdefghij1")).toBe("short"); // 11 chars
  });

  it("rejects a long password missing a character class", () => {
    expect(passwordProblem("abcdefghijkl1", "abcdefghijkl1")).toBe("classes"); // no uppercase
    expect(passwordProblem("ABCDEFGHIJKL1", "ABCDEFGHIJKL1")).toBe("classes"); // no lowercase
    expect(passwordProblem("Abcdefghijklm", "Abcdefghijklm")).toBe("classes"); // no digit
  });

  it("rejects a mismatched confirmation", () => {
    expect(passwordProblem("Abcdefghijk1", "Abcdefghijk2")).toBe("mismatch");
  });

  it("accepts a compliant password", () => {
    expect(passwordProblem("Abcdefghijk1", "Abcdefghijk1")).toBeNull();
  });
});

describe("hasEmailIdentity", () => {
  it("is false for a Google-only account (it needs a password SET, not changed)", () => {
    expect(hasEmailIdentity(userWith(["google"]))).toBe(false);
  });

  it("is true once an email identity exists, alone or alongside Google", () => {
    expect(hasEmailIdentity(userWith(["email"]))).toBe(true);
    expect(hasEmailIdentity(userWith(["google", "email"]))).toBe(true);
  });

  it("degrades to false when identities are missing from the session", () => {
    expect(hasEmailIdentity({} as User)).toBe(false);
  });
});

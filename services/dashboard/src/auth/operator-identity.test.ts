import { describe, expect, it } from "vitest";
import { operatorDisplayName, operatorInitials } from "./operator-identity";

describe("operatorDisplayName", () => {
  it("prefers a display name carried on the session metadata", () => {
    expect(
      operatorDisplayName({ email: "daniel.marsi@live.com", user_metadata: { full_name: "Daniel Marsi" } }),
    ).toBe("Daniel Marsi");
    expect(operatorDisplayName({ email: "ops@example.com", user_metadata: { name: "Ops Team" } })).toBe("Ops Team");
  });

  it("derives a name from the signed-in email when the session carries none", () => {
    expect(operatorDisplayName({ email: "daniel.marsi@live.com" })).toBe("Daniel Marsi");
    expect(operatorDisplayName({ email: "macauley@presciaiq.com", user_metadata: {} })).toBe("Macauley");
  });

  it("falls back to a neutral label when there is no email", () => {
    expect(operatorDisplayName({ email: null })).toBe("Operator");
  });
});

describe("operatorInitials", () => {
  it("builds initials from the resolved display name", () => {
    expect(operatorInitials("Daniel Marsi")).toBe("DM");
    expect(operatorInitials("Macauley")).toBe("M");
    expect(operatorInitials("")).toBe("?");
  });
});

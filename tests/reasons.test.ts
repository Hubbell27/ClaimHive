import { describe, expect, it } from "vitest";
import { CARC, RARC } from "@/lib/reference/codes";
import { actionFor, CATEGORY, codeHref, findReason, REASON_CODES, searchReasons } from "@/lib/reference/reasons";

describe("reason code list", () => {
  it("has each code once, with a label and something to do", () => {
    const keys = REASON_CODES.map((x) => `${x.kind}:${x.code}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of REASON_CODES) {
      expect(x.label.length).toBeGreaterThan(3);
      expect(CATEGORY[x.category]).toBeDefined();
      expect(actionFor(x).length).toBeGreaterThan(20);
    }
    expect(REASON_CODES.filter((x) => x.kind === "carc").length).toBeGreaterThan(100);
    expect(REASON_CODES.filter((x) => x.kind === "rarc").length).toBeGreaterThan(60);
    expect(REASON_CODES.filter((x) => x.kind === "group").map((x) => x.code)).toEqual(["CO", "PR", "OA", "PI"]);
  });

  it("keeps the wording used elsewhere in ClaimHive (letters, reports, evidence)", () => {
    expect(CARC.find((c) => c.code === "27")?.label).toBe("Service after coverage ended");
    expect(CARC.find((c) => c.code === "16")?.label).toBe("Claim lacks information or has submission/billing errors");
    expect(RARC.find((c) => c.code === "N706")?.label).toBe("Missing documentation");
  });
});

describe("searching", () => {
  const first = (q: string) => searchReasons(q)[0];
  it("finds a code exactly, with or without the group code, in any case", () => {
    expect(first("16")).toMatchObject({ kind: "carc", code: "16" });
    expect(first("CO-16")).toMatchObject({ kind: "carc", code: "16" });
    expect(first("co 16")).toMatchObject({ kind: "carc", code: "16" });
    expect(first("n706")).toMatchObject({ kind: "rarc", code: "N706" });
    expect(first("PR")).toMatchObject({ kind: "group", code: "PR" });
  });
  it("finds codes by words", () => {
    expect(searchReasons("x-ray")[0].code).toBe("N40"); // name matches rank above advice-only matches
    expect(searchReasons("xray").map((x) => x.code)).toContain("N40");
    expect(searchReasons("frequency").map((x) => x.code)).toContain("151");
    expect(searchReasons("tooth number").map((x) => x.code)).toContain("N37");
  });
  it("returns everything for an empty search, and nothing exact for an unknown code", () => {
    expect(searchReasons("")).toHaveLength(REASON_CODES.length);
    expect(searchReasons("9999").some((x) => x.code === "9999")).toBe(false);
  });
  it("links to the code's entry on the page", () => {
    expect(codeHref("rarc", "n706")).toBe("/app/codes?q=n706#rarc-N706");
    expect(findReason("carc", "a1")?.code).toBe("A1");
  });
});

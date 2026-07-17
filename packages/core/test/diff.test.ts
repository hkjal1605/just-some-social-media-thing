import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/diff";

describe("lineDiff (doc 10 §3.7)", () => {
  test("identical text is all 'same'", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.type === "same")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("a changed middle line shows as del + add", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
    ]);
  });

  test("pure additions and deletions", () => {
    expect(lineDiff("", "x")).toEqual([
      { type: "del", text: "" },
      { type: "add", text: "x" },
    ]);
    const add = lineDiff("a", "a\nb");
    expect(add.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["b"]);
    const del = lineDiff("a\nb", "a");
    expect(del.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["b"]);
  });

  test("preserves common lines around an insert", () => {
    const d = lineDiff("# Voice\n- old", "# Voice\n- old\n- new");
    expect(d.filter((l) => l.type === "same").map((l) => l.text)).toEqual(["# Voice", "- old"]);
    expect(d.find((l) => l.type === "add")?.text).toBe("- new");
  });
});

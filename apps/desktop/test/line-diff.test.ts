import { describe, expect, it } from "vitest";
import { diffLines } from "../src/renderer/src/features/memory/line-diff.js";

describe("diffLines", () => {
  it("returns every line as same for identical content", () => {
    expect(diffLines("one\ntwo", "one\ntwo")).toEqual([
      { type: "same", text: "one" },
      { type: "same", text: "two" },
    ]);
  });

  it("returns pure additions and removals", () => {
    expect(diffLines("", "one\ntwo")).toEqual([
      { type: "added", text: "one" },
      { type: "added", text: "two" },
    ]);
    expect(diffLines("one\ntwo", "")).toEqual([
      { type: "removed", text: "one" },
      { type: "removed", text: "two" },
    ]);
  });

  it("emits removed lines before added lines for a middle modification", () => {
    expect(diffLines("one\nold\nthree", "one\nnew\nthree")).toEqual([
      { type: "same", text: "one" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "same", text: "three" },
    ]);
  });

  it("returns no lines when both contents are empty", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("preserves a trailing newline as an empty final line", () => {
    expect(diffLines("one\n", "one")).toEqual([
      { type: "same", text: "one" },
      { type: "removed", text: "" },
    ]);
  });

  it("falls back to complete removals followed by additions for large products", () => {
    const before = Array.from({ length: 501 }, (_, index) => `before-${index}`);
    const after = Array.from({ length: 501 }, (_, index) => `after-${index}`);
    const result = diffLines(before.join("\n"), after.join("\n"));
    expect(result).toEqual([
      ...before.map((text) => ({ type: "removed" as const, text })),
      ...after.map((text) => ({ type: "added" as const, text })),
    ]);
  });
});

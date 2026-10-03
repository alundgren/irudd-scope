import { expect, test } from "vite-plus/test";
import { mergeHtml } from "../apps/plan-web/src/browser/merge.ts";

const base = "<h1>Human0-004</h1><p>Human1-004</p><p>Agent0-004</p>";
test("remote changes on both sides of a local edit preserve all three changes", () => {
  expect(
    mergeHtml(
      base,
      base.replace("Human1-004", "Human1-005"),
      base.replace("Human0-004", "Human0-005").replace("Agent0-004", "Agent0-005"),
    ),
  ).toBe(base.replaceAll("004", "005"));
});
test("identical shared changes appear once alongside each editor's independent changes", () => {
  const shared = base.replace("Human0-004", "Human0-shared");
  expect(
    mergeHtml(
      base,
      shared.replace("Human1-004", "Human1-local"),
      shared.replace("Agent0-004", "Agent0-remote"),
    ),
  ).toBe(shared.replace("Human1-004", "Human1-local").replace("Agent0-004", "Agent0-remote"));
  expect(mergeHtml("abc", "aXbc", "aXbC")).toBe("aXbC");
});
test("UTF-16 offsets preserve emoji and independent edits", () => {
  expect(mergeHtml("😀 one 🐶 two three", "😃 ONE 🐶 two three", "😀 one 🐶 two THREE")).toBe(
    "😃 ONE 🐶 two THREE",
  );
});
test("edits to different UTF-16 halves of one emoji require review", () => {
  expect(mergeHtml("😀", String.fromCodePoint(0x2f600), "😃")).toBeNull();
});
test("adjacent deletion and insertion merge, while competing insertions and interior changes conflict", () => {
  expect(mergeHtml("abcd", "acd", "abXcd")).toBe("aXcd");
  expect(mergeHtml("abcd", "abXcd", "abYcd")).toBeNull();
  expect(mergeHtml("abcd", "ad", "abXcd")).toBeNull();
  expect(
    mergeHtml(
      base,
      base.replace("Human1-004", "Human1-local"),
      base.replace("Human1-004", "Human1-remote"),
    ),
  ).toBeNull();
});
test("unrelated replacements beyond the diff budget remain explicit conflicts", () => {
  const original = "a".repeat(15_000);
  expect(mergeHtml(original, "b".repeat(15_000), `${original} remote`)).toBeNull();
});

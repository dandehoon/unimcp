import { describe, test, expect } from "bun:test";
import { parseJsonc, stripJsonComments } from "../src/utils.js";

describe("stripJsonComments", () => {
  test("passes plain JSON through unchanged", () => {
    const input = '{"key": "value"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  test("strips // line comments", () => {
    const input = '{\n  "key": "value" // comment\n}';
    const result = stripJsonComments(input);
    expect(result).toBe('{\n  "key": "value" \n}');
  });

  test("strips /* block comments */", () => {
    const input = '{ /* block */ "key": "value" }';
    const result = stripJsonComments(input);
    // Block comment is removed but surrounding whitespace remains
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  test("does not strip // inside quoted strings", () => {
    const input = '{"url": "http://example.com"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  test("does not strip /* inside quoted strings", () => {
    const input = '{"desc": "a /* b */ c"}';
    expect(stripJsonComments(input)).toBe(input);
  });

  test("handles escaped quotes inside strings", () => {
    const input = '{"key": "say \\"hello\\""}';
    expect(stripJsonComments(input)).toBe(input);
  });

  test("handles multiline block comments", () => {
    const input = '{\n  /* multi\n   line */\n  "key": 1\n}';
    const result = stripJsonComments(input);
    expect(JSON.parse(result)).toEqual({ key: 1 });
  });

  test("returns empty string unchanged", () => {
    expect(stripJsonComments("")).toBe("");
  });
});

describe("parseJsonc", () => {
  test("drops trailing commas and comments", () => {
    expect(parseJsonc('{ "a": [1, 2,], // c\n "b": { "c": 1, }, }')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  test("keeps commas inside strings", () => {
    expect(parseJsonc('{ "a": ",}", "b": "x\\\\", "c": "\\",]",}')).toEqual({ a: ",}", b: "x\\", c: '",]' });
  });

  test("throws on invalid JSON", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow();
  });
});

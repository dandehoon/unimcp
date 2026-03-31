import { describe, test, expect } from "bun:test";
import { stripJsonComments } from "../src/utils.js";

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

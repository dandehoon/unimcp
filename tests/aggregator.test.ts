import { describe, test, expect } from "bun:test";
import { matchesFilter } from "../src/aggregator.js";

describe("matchesFilter", () => {
  test("allows all tools when no filter", () => {
    expect(matchesFilter("search-web")).toBe(true);
    expect(matchesFilter("anything")).toBe(true);
  });

  test("allows tools matching include glob", () => {
    expect(matchesFilter("search-web", { include: ["search-*"] })).toBe(true);
    expect(matchesFilter("search-images", { include: ["search-*"] })).toBe(true);
  });

  test("blocks tools not matching include glob", () => {
    expect(matchesFilter("resolve-id", { include: ["search-*"] })).toBe(false);
  });

  test("blocks tools matching exclude glob", () => {
    expect(matchesFilter("search-internal", { include: ["search-*"], exclude: ["search-internal"] })).toBe(false);
  });

  test("allows tools matching include but not exclude", () => {
    expect(matchesFilter("search-web", { include: ["search-*"], exclude: ["search-internal"] })).toBe(true);
  });

  test("exclude-only (no include) defaults include to all", () => {
    expect(matchesFilter("search-web", { exclude: ["search-internal"] })).toBe(true);
    expect(matchesFilter("search-internal", { exclude: ["search-internal"] })).toBe(false);
  });

  test("supports wildcard * in exclude", () => {
    expect(matchesFilter("anything", { include: ["*"], exclude: ["*"] })).toBe(false);
  });

  test("empty include array blocks all tools", () => {
    expect(matchesFilter("search-web", { include: [] })).toBe(false);
  });
});

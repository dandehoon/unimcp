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

// listTools applies two consecutive matchesFilter checks: serverFilter then clientFilter.
// This describe verifies the composed behaviour mirrors what listTools(clientFilter) does.
describe("listTools client filter composition", () => {
  // Simulates: tool passes server filter, then is checked against client filter
  function passes(toolName: string, serverFilter: Parameters<typeof matchesFilter>[1], clientFilter: Parameters<typeof matchesFilter>[1]): boolean {
    return matchesFilter(toolName, serverFilter) && matchesFilter(toolName, clientFilter);
  }

  test("no client filter: all server-passing tools are visible", () => {
    expect(passes("searxng__search", undefined, undefined)).toBe(true);
    expect(passes("fetch__get", undefined, undefined)).toBe(true);
  });

  test("client exclude filter hides tools even if server allows them", () => {
    expect(passes("searxng__search", undefined, { exclude: ["searxng__*"] })).toBe(false);
    expect(passes("fetch__get", undefined, { exclude: ["searxng__*"] })).toBe(true);
  });

  test("client include filter shows only matching tools", () => {
    expect(passes("fetch__get", undefined, { include: ["fetch__*"] })).toBe(true);
    expect(passes("searxng__search", undefined, { include: ["fetch__*"] })).toBe(false);
  });

  test("server and client filters are both applied (AND)", () => {
    // server allows only fetch__*, client allows only searxng__* → nothing passes
    expect(passes("fetch__get", { include: ["fetch__*"] }, { include: ["searxng__*"] })).toBe(false);
    // server allows fetch__*, client allows fetch__* → passes
    expect(passes("fetch__get", { include: ["fetch__*"] }, { include: ["fetch__*"] })).toBe(true);
  });
});

import { describe, test, expect } from "bun:test";
import { hasLocalBrowser } from "../src/browser.js";

describe("hasLocalBrowser", () => {
  test("false over SSH", () => {
    expect(hasLocalBrowser({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin")).toBe(false);
    expect(hasLocalBrowser({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(false);
  });

  test("Linux needs a display", () => {
    expect(hasLocalBrowser({}, "linux")).toBe(false);
    expect(hasLocalBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(hasLocalBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(hasLocalBrowser({}, "darwin")).toBe(true);
  });
});

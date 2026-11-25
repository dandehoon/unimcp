import { spawn } from "child_process";
import { log } from "./utils.js";

/** False over SSH or on a Linux box with no display — a browser there can't be opened or reach us. */
export function hasLocalBrowser(env: NodeJS.ProcessEnv, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Opens `url` in the default browser, detached; a failure to launch is logged. */
export function openUrl(url: URL): void {
  // No shell anywhere: `cmd /c start` would run whatever follows an `&` in the query string.
  const [cmd, args] = process.platform === "darwin" ? ["open", [url.href]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url.href]]
    : ["xdg-open", [url.href]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" })
    .on("error", (err) => log("[browser] could not open:", err.message))
    .unref();
}

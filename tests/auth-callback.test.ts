import { describe, test, expect } from "bun:test";
import { PassThrough } from "stream";
import { listenForCallback, parseCallback } from "../src/auth-callback.js";

const STATE = "s1";
const redirect = (query: string) => new URL(`http://localhost:4849/callback?${query}`);

describe("parseCallback", () => {
  test("returns the code for our state", () => {
    expect(parseCallback(redirect(`code=c1&state=${STATE}`), STATE)).toEqual({ code: "c1" });
  });

  test("ignores another state or path", () => {
    expect(parseCallback(redirect("code=c1&state=other"), STATE)).toBeNull();
    expect(parseCallback(new URL(`http://localhost:4849/x?code=c1&state=${STATE}`), STATE)).toBeNull();
  });

  test("reports a denial, sanitized", () => {
    expect(parseCallback(redirect(`error=access%20denied&state=${STATE}`), STATE))
      .toEqual({ error: "authorization denied: access?denied" });
  });

  test("our state with no code is a denial", () => {
    expect(parseCallback(redirect(`state=${STATE}`), STATE)).toEqual({ error: "authorization denied: no code" });
  });
});

describe("listenForCallback paste", () => {
  async function listen() {
    const paste = new PassThrough();
    const callback = await listenForCallback({ redirectUrl: "http://localhost:0/callback", callbackPort: 0, expectedState: STATE, paste });
    return { paste, callback };
  }

  test("accepts the pasted redirect URL after skipping junk", async () => {
    const { paste, callback } = await listen();
    paste.write("not a url\n");
    paste.write(`http://localhost:4849/callback?code=c1&state=other\n`);
    paste.write(`  ${redirect(`code=c2&state=${STATE}`).href}  \n`);
    expect(await callback.code).toBe("c2");
    callback.close(true);
  });

  test("a pasted denial rejects", async () => {
    const { paste, callback } = await listen();
    paste.write(`${redirect(`error=access_denied&state=${STATE}`).href}\n`);
    await expect(callback.code).rejects.toThrow("authorization denied: access_denied");
    callback.close(false);
  });
});

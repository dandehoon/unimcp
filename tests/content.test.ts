import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { Client, InMemoryTransport, ProtocolError } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { Server } from "@modelcontextprotocol/server";
import { Aggregator, type ContentSource } from "../src/aggregator.js";
import type { Config, ToolFilter } from "../src/config.js";
import { CONTENT_CAPABILITIES, serveContent } from "../src/content.js";
import { listResources, route } from "../src/resources.js";

// Two real stdio upstreams serving the same skill, resource and template, behind the daemon's
// handlers: what a client lists, reads and verifies through them.

const FIXTURE = join(import.meta.dir, "fixtures", "stdio-server.ts");

const live: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((x) => x.close()));
});

async function upstreams(grants?: Config["grants"]): Promise<Aggregator> {
  const server = (label: string) => ({ command: process.execPath, args: [FIXTURE, "--content"], env: { LABEL: label } });
  const agg = new Aggregator();
  live.push({ close: () => agg.disconnect() });
  await agg.connect({ mcpServers: { a: server("a"), b: server("b") }, grants } as Config);
  return agg;
}

async function clientOf(aggregator: Aggregator, clientFilter?: ToolFilter): Promise<Client> {
  const server = new Server({ name: "unimcp-test", version: "0" }, { capabilities: CONTENT_CAPABILITIES });
  serveContent(server, { aggregator, clientFilter });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  live.push(client);
  return client;
}

const text = (result: { contents: unknown[] }) => (result.contents[0] as { text: string }).text;

describe("resources and skills through the daemon", () => {
  test("each server's skill keeps its own URI, and its files verify against the manifest", async () => {
    const skills = new SkillsClient(await clientOf(await upstreams()));
    const { skills: listed } = await skills.list();
    expect(listed.map((s) => s.uri)).toEqual(["skill://a/demo/SKILL.md", "skill://b/demo/SKILL.md"]);
    const guide = await skills.read(listed[1], "references/GUIDE.md");
    expect(guide.verified).toBe(true);
    expect(guide.text).toBe("# Guide from b\n");
    expect((await skills.read(listed[0])).verified).toBe(true);
    expect((await skills.get("skill://b/demo/SKILL.md")).skill.frontmatter.description).toBe("A demo skill from b");
  });

  test("a URI two servers share is the first's, for listing and reading alike", async () => {
    const client = await clientOf(await upstreams());
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["note://readme", "skill://a/demo/SKILL.md", "skill://b/demo/SKILL.md"]);
    expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual(["note://items/{id}"]);
    expect(text(await client.readResource({ uri: "note://readme" }))).toBe("readme from a");
    expect(text(await client.readResource({ uri: "note://items/7" }))).toBe("item 7 from a");
  });

  test("a client filter hides a skill by name, and its files become unknown", async () => {
    const client = await clientOf(await upstreams(), { exclude: ["demo"] });
    expect((await new SkillsClient(client).list()).skills).toEqual([]);
    const read = client.readResource({ uri: "skill://a/demo/SKILL.md" });
    await expect(read).rejects.toBeInstanceOf(ProtocolError);
    await expect(read).rejects.toThrow(/not available to this client/);
  });

  test("a grant locks one server's skill by its prefixed name, and an unheld one hides it", async () => {
    const aggregator = await upstreams({ ops: ["b__demo"] });
    const without = await clientOf(aggregator);
    expect((await new SkillsClient(without).list()).skills.map((s) => s.uri)).toEqual(["skill://a/demo/SKILL.md"]);
    const holding = await clientOf(aggregator, { grants: ["ops"] });
    expect((await new SkillsClient(holding).list()).skills).toHaveLength(2);
  });

  test("a URI no upstream lists is refused without asking any", async () => {
    const client = await clientOf(await upstreams());
    await expect(client.readResource({ uri: "skill://c/demo/SKILL.md" })).rejects.toThrow(/not available/);
    await expect(client.readResource({ uri: "note://elsewhere" })).rejects.toThrow(/not available/);
  });
});

describe("routing a profile member's URIs", () => {
  const member: ContentSource = {
    name: "db.prod",
    isMember: true,
    content: {
      resources: [{ uri: "note://readme", name: "readme" }],
      templates: [],
      skills: [{ uri: "skill://demo/SKILL.md", frontmatter: { name: "demo", description: "d" }, resources: "dynamic" }],
    },
    isVisible: () => true,
  };

  test("its skills carry the member's name; URIs every profile shares are not its to serve", () => {
    expect(route([member], "skill://db.prod/demo/notes/a.md")).toEqual({ source: member, uri: "skill://demo/notes/a.md" });
    expect(route([member], "note://readme")).toBeUndefined();
    expect(listResources([member])).toEqual([]);
  });
});

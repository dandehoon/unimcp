import type { Client, Resource, ResourceTemplateType as ResourceTemplate, Tool } from "@modelcontextprotocol/client";
import { SkillsClient, type Skill } from "@modelcontextprotocol/client/ext/skills";
import { log } from "./utils.js";

// What an upstream publishes: listed on connect, and again when it says its tools or resources changed.

/** Resources, resource templates and skills (SEP-2640), as the upstream names them. */
export type Content = { resources: Resource[]; templates: ResourceTemplate[]; skills: Skill[] };
export type Catalog = { tools: Tool[]; content: Content };

export const EMPTY_CONTENT: Content = { resources: [], templates: [], skills: [] };

/**
 * Lists everything at once. Tools decide whether the server is usable, so their failure fails the
 * listing; a server whose resources or skills fail to list keeps its tools and publishes no content.
 */
export async function listCatalog(client: Client, label: string): Promise<Catalog> {
  const [{ tools }, content] = await Promise.all([client.listTools(), listContent(client, label)]);
  return { tools, content };
}

// --- helpers ---

/** A server without the capability lists nothing: the SDK answers empty rather than asking it. */
async function listContent(client: Client, label: string): Promise<Content> {
  try {
    const [{ resources }, { resourceTemplates }, skills] = await Promise.all([
      client.listResources(),
      client.listResourceTemplates(),
      listSkills(client, label),
    ]);
    return { resources, templates: resourceTemplates, skills };
  } catch (err) {
    log(`${label} listing resources and skills failed — none published:`, String(err));
    return EMPTY_CONTENT;
  }
}

async function listSkills(client: Client, label: string): Promise<Skill[]> {
  const { skills, invalid } = await new SkillsClient(client, { skipInvalid: true }).list();
  for (const entry of invalid) log(`${label} invalid skill ${entry.uri ?? `#${entry.index}`} skipped: ${entry.reason}`);
  return skills;
}

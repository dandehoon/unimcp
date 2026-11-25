import type { Client, Resource, ResourceTemplateType as ResourceTemplate } from "@modelcontextprotocol/client";
import { SkillsClient, type Skill } from "@modelcontextprotocol/client/ext/skills";
import { log } from "./utils.js";

// What an upstream publishes besides tools: listed once it connects, and again when it says its resources changed.

/** Resources, resource templates and skills (SEP-2640), as the upstream names them. */
export type Content = { resources: Resource[]; templates: ResourceTemplate[]; skills: Skill[] };

export const EMPTY_CONTENT: Content = { resources: [], templates: [], skills: [] };

const SKILL_SCHEME = "skill://";

/** A server without the capability lists nothing: the SDK answers empty rather than asking it. */
export async function listContent(client: Client, label: string): Promise<Content> {
  const [{ resources }, { resourceTemplates }, skills] = await Promise.all([
    client.listResources(),
    client.listResourceTemplates(),
    listSkills(client, label),
  ]);
  return { resources, templates: resourceTemplates, skills };
}

// --- helpers ---

/** Only `skill://` skills: their URIs gain the server's name, which keeps two servers' skills apart. */
async function listSkills(client: Client, label: string): Promise<Skill[]> {
  const { skills, invalid } = await new SkillsClient(client, { skipInvalid: true }).list();
  for (const entry of invalid) log(`${label} invalid skill ${entry.uri ?? `#${entry.index}`} skipped: ${entry.reason}`);
  return skills.filter((skill) => {
    if (skill.uri.startsWith(SKILL_SCHEME)) return true;
    log(`${label} skill ${skill.uri} skipped: not a ${SKILL_SCHEME} URI`);
    return false;
  });
}

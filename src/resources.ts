import { type ReadResourceResult, type Resource, type ResourceTemplateType as ResourceTemplate, UriTemplate } from "@modelcontextprotocol/client";
import type { Skill } from "@modelcontextprotocol/client/ext/skills";
import type { ContentSource } from "./aggregator.js";

// Which upstream serves a URI a client names, and the URIs clients see.
//
// A `skill://` URI gains its server as the first path segment (`skill://<server>/<path>`), so two
// servers' skills never collide; the skill's own path, its last segment (its name), its relative
// references and its bytes stay as served. Any other URI passes unchanged: the first server in
// config order listing it serves it. A profile member's URIs are its skills' only — its other
// URIs are the same for every profile, with no way to tell which one a client means.

const SKILL_SCHEME = "skill://";

export type Route = { source: ContentSource; uri: string };

/** Resources a client may see, as it sees them. */
export function listResources(sources: ContentSource[]): Resource[] {
  return firstOwners(sources.flatMap((source) => source.content.resources
    .filter((r) => isServed(source, r.uri) && source.isVisible(r.name))
    .map((r) => ({ ...r, uri: toClientUri(source.name, r.uri) }))), (r) => r.uri);
}

export function listTemplates(sources: ContentSource[]): ResourceTemplate[] {
  return firstOwners(sources.flatMap((source) => source.content.templates
    .filter((t) => isServed(source, t.uriTemplate) && source.isVisible(t.name))
    .map((t) => ({ ...t, uriTemplate: toClientUri(source.name, t.uriTemplate) }))), (t) => t.uriTemplate);
}

export function listSkills(sources: ContentSource[]): Skill[] {
  return sources.flatMap((source) => source.content.skills
    .filter((s) => source.isVisible(s.frontmatter.name))
    .map((s) => toClientSkill(source.name, s)));
}

/**
 * The upstream serving a URI a client names, and the URI it knows it by. Only what an upstream
 * lists is served — a listed resource, a file under a listed skill, a URI one of its templates
 * matches — so a client can't reach past what it may see.
 */
export function route(sources: ContentSource[], clientUri: string): Route | undefined {
  if (clientUri.startsWith(SKILL_SCHEME)) {
    const rest = clientUri.slice(SKILL_SCHEME.length);
    const slash = rest.indexOf("/");
    const source = slash > 0 ? sources.find((s) => s.name === rest.slice(0, slash)) : undefined;
    const uri = `${SKILL_SCHEME}${rest.slice(slash + 1)}`;
    return source && isOwnedVisible(source, uri) ? { source, uri } : undefined;
  }
  const source = sources.find((s) => !s.isMember && isOwnedVisible(s, clientUri));
  return source ? { source, uri: clientUri } : undefined;
}

export function toClientSkill(server: string, skill: Skill): Skill {
  const resources = Array.isArray(skill.resources)
    ? skill.resources.map((r) => ({ ...r, uri: toClientUri(server, r.uri) }))
    : skill.resources;
  return { ...skill, uri: toClientUri(server, skill.uri), resources };
}

export function toClientRead(server: string, result: ReadResourceResult): ReadResourceResult {
  return { ...result, contents: result.contents.map((c) => ({ ...c, uri: toClientUri(server, c.uri) })) };
}

// --- helpers ---

function toClientUri(server: string, uri: string): string {
  return uri.startsWith(SKILL_SCHEME) ? `${SKILL_SCHEME}${server}/${uri.slice(SKILL_SCHEME.length)}` : uri;
}

function isServed(source: ContentSource, uri: string): boolean {
  return !source.isMember || uri.startsWith(SKILL_SCHEME);
}

function isOwnedVisible(source: ContentSource, uri: string): boolean {
  const name = itemName(source, uri);
  return name !== undefined && source.isVisible(name);
}

/** The name a URI is judged by: its skill's, or the listed resource's or template's that covers it. */
function itemName({ content }: ContentSource, uri: string): string | undefined {
  const skill = owningSkill(content.skills, uri);
  if (skill) return skill.frontmatter.name;
  const listed = content.resources.find((r) => r.uri === uri);
  if (listed) return listed.name;
  return content.templates.find((t) => matchesTemplate(t.uriTemplate, uri))?.name;
}

/** The innermost skill whose folder holds `uri`: a nested skill is its own. */
function owningSkill(skills: Skill[], uri: string): Skill | undefined {
  let best: Skill | undefined;
  for (const skill of skills) {
    const dir = skill.uri.slice(0, skill.uri.lastIndexOf("/") + 1);
    if (uri.startsWith(dir) && (!best || dir.length > best.uri.lastIndexOf("/") + 1)) best = skill;
  }
  return best;
}

/** An upstream's template is untrusted input: one that doesn't parse matches nothing. */
function matchesTemplate(template: string, uri: string): boolean {
  try {
    return new UriTemplate(template).match(uri) !== null;
  } catch {
    return false;
  }
}

/** Keeps the first of each key: earlier servers in config order win a shared URI. */
function firstOwners<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && Boolean(seen.add(key(item))));
}

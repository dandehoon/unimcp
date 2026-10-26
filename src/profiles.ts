import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, ProfileVars, ServerConfig } from "./config.js";

/** The argument that picks a profile on every call to a server with profiles. */
export const PROFILE_ARG = "profile";
// No `.` (it joins server and profile in member names) and no `__` (the tool-name separator).
export const PROFILE_RE = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;
const VAR_RE = /\{(\w+)\}/g;
// The fields a profile's vars fill in; filters and pinned args are the server's alone.
const TEMPLATE_KEYS = ["command", "args", "env", "url", "headers", "oauth"] as const;

/** A server listed once, whose calls route to one upstream per profile by the `profile` argument. */
export type ProfileGroup = {
  name: string;
  profiles: string[];
  /** The server's own config: its filters and pinned args apply to every member. */
  config: ServerConfig;
};

export type Member = { name: string; srv: ServerConfig };

export const memberName = (server: string, profile: string): string => `${server}.${profile}`;

/** One member per profile: the server's config with each `{var}` filled from that profile; throws on an invalid group. */
export function expandProfiles(name: string, srv: ServerConfig, profiles: Record<string, ProfileVars>): { group: ProfileGroup; members: Member[] } {
  if (srv.pinArgs && PROFILE_ARG in srv.pinArgs) throw new Error(`"${PROFILE_ARG}" can't be pinned on a server with profiles`);
  const names = Object.keys(profiles);
  const members = names.map((p) => ({ name: memberName(name, p), srv: fillVars(srv, profiles[p], p) }));
  return { group: { name, profiles: names, config: srv }, members };
}

/** Finds a server by name, including a profile member (`server.profile`) — the name `unimcp auth` takes. */
export function findServer(config: Config, name: string): ServerConfig | undefined {
  const direct = config.mcpServers[name];
  if (direct) return config.profiles?.[name] ? undefined : direct;
  const dot = name.lastIndexOf(".");
  const [server, profile] = [name.slice(0, dot), name.slice(dot + 1)];
  const srv = dot > 0 ? config.mcpServers[server] : undefined;
  const profiles = config.profiles?.[server];
  if (!srv || !profiles || !Object.hasOwn(profiles, profile)) return undefined;
  return fillVars(srv, profiles[profile], profile);
}

/** Whether a tool already takes an argument named like the selector, which would shadow it. */
export const takesProfileArg = (tool: Tool): boolean => Object.hasOwn(tool.inputSchema.properties ?? {}, PROFILE_ARG);

/** The selector added as a required argument listing every profile. */
export function withProfileArg(tool: Tool, group: ProfileGroup): Tool {
  const { properties = {}, required = [] } = tool.inputSchema;
  const selector = { type: "string", enum: group.profiles, description: `Which ${group.name} profile to use` };
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { [PROFILE_ARG]: selector, ...properties }, required: [PROFILE_ARG, ...required] },
  };
}

/** Pinned arguments taken out of the schema: the client can't see or set them. */
export function withoutPinnedArgs(tool: Tool, pinArgs: Record<string, unknown> | undefined): Tool {
  if (!pinArgs) return tool;
  const pinned = new Set(Object.keys(pinArgs));
  const { properties, required } = tool.inputSchema;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: properties && Object.fromEntries(Object.entries(properties).filter(([k]) => !pinned.has(k))),
      required: required?.filter((k) => !pinned.has(k)),
    },
  };
}

/** The member a group call goes to, and the arguments it receives (selector removed). */
export function routeProfile(group: ProfileGroup, args: Record<string, unknown>): { member: string; args: Record<string, unknown> } {
  const { [PROFILE_ARG]: profile, ...rest } = args;
  if (typeof profile !== "string" || !group.profiles.includes(profile)) {
    // No list: it would name profiles this client doesn't hold. Its tool schema lists the ones it does.
    throw new Error(`'${PROFILE_ARG}' must name one of your ${group.name} profiles`);
  }
  return { member: memberName(group.name, profile), args: rest };
}

/** The server's connection fields with every `{var}` replaced; a var the profile doesn't set is an error. */
function fillVars(srv: ServerConfig, vars: ProfileVars, profile: string): ServerConfig {
  const fill = (s: string) => s.replace(VAR_RE, (_m, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`profile '${profile}' sets no "${key}" var`);
    return vars[key];
  });
  const filled: Record<string, unknown> = { ...srv };
  for (const key of TEMPLATE_KEYS) {
    if (key in srv) filled[key] = mapValues((srv as Record<string, unknown>)[key], fill);
  }
  return filled as ServerConfig;
}

function mapValues(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapValues(v, fn));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapValues(v, fn)]));
  }
  return value;
}

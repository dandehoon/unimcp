import type { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import {
  GetSkillRequestParamsSchema, GetSkillResultSchema, ListSkillsRequestParamsSchema, ListSkillsResultSchema,
  SKILLS_EXTENSION_ID, SKILLS_GET_METHOD, SKILLS_LIST_METHOD,
} from "@modelcontextprotocol/core/ext/skills";
import { ProtocolError, ProtocolErrorCode, type Server, type ServerCapabilities } from "@modelcontextprotocol/server";
import type { Aggregator } from "./aggregator.js";
import type { ToolFilter } from "./config.js";
import { type Route, listResources, listSkills, listTemplates, route, toClientRead, toClientSkill } from "./resources.js";

// Resources and skills (SEP-2640) on unimcp's own servers: the daemon serves them, the bridge forwards them.

/** No `directoryRead`: a skill's `resources` already lists every file, so clients need no folder listing. */
export const CONTENT_CAPABILITIES: ServerCapabilities = {
  resources: { listChanged: true },
  extensions: { [SKILLS_EXTENSION_ID]: {} },
};

/** Skills have no lifetime of their own here: they change when their upstream says so. */
const CACHE_HINT = { ttlMs: 0, cacheScope: "private" } as const;
const LIST_SKILLS = { params: ListSkillsRequestParamsSchema, result: ListSkillsResultSchema };
const GET_SKILL = { params: GetSkillRequestParamsSchema, result: GetSkillResultSchema };

type ServeOptions = { aggregator: Aggregator; clientFilter?: ToolFilter };

/** The daemon's handlers: each lists from the cached catalogs and reads from the upstream that owns the URI. */
export function serveContent(server: Server, { aggregator, clientFilter }: ServeOptions): void {
  const sources = () => aggregator.contentSources(clientFilter);
  const send = <T>(target: Route, run: (client: Client) => Promise<T>) => upstreamErrors(aggregator.request(target.source.name, run));

  server.setRequestHandler("resources/list", async () => ({ resources: listResources(sources()) }));
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: listTemplates(sources()) }));
  server.setRequestHandler("resources/read", async (req) => {
    const target = routeOrThrow(req.params.uri, sources());
    return toClientRead(target.source.name, await send(target, (c) => c.readResource({ uri: target.uri })));
  });
  server.setRequestHandler(SKILLS_LIST_METHOD, LIST_SKILLS, async () => ({ skills: listSkills(sources()), ...CACHE_HINT }));
  server.setRequestHandler(SKILLS_GET_METHOD, GET_SKILL, async ({ uri }) => {
    const target = routeOrThrow(uri, sources());
    const { skill, ttlMs, cacheScope } = await send(target, (c) => new SkillsClient(c).get(target.uri));
    return { skill: toClientSkill(target.source.name, skill), ttlMs: ttlMs ?? CACHE_HINT.ttlMs, cacheScope: cacheScope ?? CACHE_HINT.cacheScope };
  });
}

/** `send`: runs a request on the daemon's client, reconnecting as the bridge's tool calls do. */
export function forwardContent(server: Server, send: <T>(run: (client: Client) => Promise<T>) => Promise<T>): void {
  server.setRequestHandler("resources/list", () => send((c) => c.listResources()));
  server.setRequestHandler("resources/templates/list", () => send((c) => c.listResourceTemplates()));
  server.setRequestHandler("resources/read", (req) => send((c) => c.readResource(req.params)));
  server.setRequestHandler(SKILLS_LIST_METHOD, LIST_SKILLS, () =>
    send((c) => c.request({ method: SKILLS_LIST_METHOD, params: {} }, ListSkillsResultSchema)));
  server.setRequestHandler(SKILLS_GET_METHOD, GET_SKILL, (params) =>
    send((c) => c.request({ method: SKILLS_GET_METHOD, params }, GetSkillResultSchema)));
}

// --- helpers ---

/** -32602, as the extension asks for an unknown skill or file: one this client may not see is unknown to it. */
function routeOrThrow(uri: string, sources: ReturnType<Aggregator["contentSources"]>): Route {
  const target = route(sources, uri);
  if (!target) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource not available to this client: ${uri}`);
  return target;
}

/** An upstream's protocol error (an unknown URI) reaches the client as it is; anything else is ours to wrap. */
async function upstreamErrors<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError(ProtocolErrorCode.InternalError, String(err));
  }
}

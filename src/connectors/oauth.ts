// OAuth for connectors, as the MCP spec has it: the server's protected resource metadata (RFC 9728), its authorization
// server's metadata (RFC 8414, or OpenID discovery), the authorization code flow with PKCE (S256), the resource
// parameter (RFC 8707), the issuer checked in the response when it's there (RFC 9207), and refresh tokens.
//
// gaidin's client id, in the spec's order: one the owner gave for the connector; a Client ID Metadata Document URL,
// the settings' connectors.clientId or else <web.url>/api/connectors/client.json, which gaidin serves; or one Dynamic
// Client Registration gives. A server that checks the redirect against the client id's host, as Home Assistant's
// IndieAuth does, takes gaidin's own URL without fetching it; one that fetches the document from the internet needs
// connectors.clientId to be a copy the owner hosts in public.
//
// Every URL a server names (its metadata, endpoints) must be on the connector's own host, or https and public, so a
// server can't send gaidin's requests into the LAN. The owner's browser makes the authorization request and comes back
// to gaidin's callback; nothing here passes through a model.
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blockedRanges } from "../fetch.ts";
import { array, attempt, boolean, integer, json, type Json, object, optional, parse, string } from "../parse.ts";

/** What an authorization server says about itself, as gaidin uses it. */
export type ServerMetadata = {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	cimd: boolean;
	/** The resource to name in the request (RFC 8707), and the scopes to ask for. */
	resource: string;
	scopes?: string[];
};

/** The tokens and what they're for, as the vault keeps them. */
export type Grant = {
	token: string;
	refresh?: string;
	expiresAt?: number;
	issuer: string;
	clientId: string;
	clientSecret?: string;
	tokenEndpoint: string;
	resource: string;
	scope?: string;
};

const PENDING_MS = 10 * 60_000;

/** A sign-in the owner's browser is away on, by its state. */
type Pending = { connector: string; verifier: string; metadata: ServerMetadata; clientId: string; clientSecret?: string; at: number };

const resourceMetadata = object({ resource: optional(string), authorization_servers: array(string), scopes_supported: optional(array(string)) });
const serverMetadata = object({
	issuer: optional(string),
	authorization_endpoint: string,
	token_endpoint: string,
	registration_endpoint: optional(string),
	client_id_metadata_document_supported: optional(boolean),
	code_challenge_methods_supported: optional(array(string)),
});
const tokenAnswer = object({ access_token: string, token_type: optional(string), expires_in: optional(integer), refresh_token: optional(string), scope: optional(string) });
const registration = object({ client_id: string, client_secret: optional(string) });

const base64url = (data: Buffer) => data.toString("base64url");

/** The `name="value"` parameters of a WWW-Authenticate challenge. */
export function challengeParams(challenge: string | undefined): Map<string, string> {
	const params = new Map<string, string>();
	for (const match of (challenge ?? "").matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params.set(match[1]!.toLowerCase(), match[2]!);
	return params;
}

export function createOAuth(options: {
	/** Where the owner's browser comes back to: <web.url>/api/connectors/callback. */
	redirectUri: string | undefined;
	/** The client id gaidin presents when nothing more specific is given. */
	clientId: string | undefined;
	fetch?: typeof fetch;
	resolve?: (host: string) => Promise<{ address: string }[]>;
}) {
	const send = options.fetch ?? fetch;
	const resolve = options.resolve ?? (async (host: string) => lookup(host, { all: true }));
	const blocked = blockedRanges();
	const pending = new Map<string, Pending>();

	/** Throws unless `url` is on the connector's host, or https on a public address. */
	async function checkUrl(url: string, connectorUrl: string, what: string): Promise<URL> {
		const parsed = URL.parse(url);
		if (parsed === null) throw new Error(`The server's ${what} isn't a URL: ${url}`);
		const home = new URL(connectorUrl);
		if (parsed.host === home.host && (parsed.protocol === home.protocol || parsed.protocol === "https:")) return parsed;
		if (parsed.protocol !== "https:") throw new Error(`The server's ${what}, ${url}, isn't https`);
		const host = parsed.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
		const local = addresses.find((a) => blocked.check(a, isIP(a) === 6 ? "ipv6" : "ipv4"));
		if (addresses.length === 0 || local !== undefined) throw new Error(`The server's ${what}, ${url}, isn't on a public address`);
		return parsed;
	}

	async function getJson(url: URL): Promise<Json | undefined> {
		const response = await send(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const body = await response.text();
		try {
			return attempt(JSON.parse(body.slice(0, 1_000_000)), json);
		} catch {
			return undefined;
		}
	}

	/** The server's protected resource metadata, then its authorization server's, from a challenge or the well-known paths. */
	async function discover(connectorUrl: string, challenge?: string): Promise<ServerMetadata> {
		const home = new URL(connectorUrl);
		const named = challengeParams(challenge).get("resource_metadata");
		const path = home.pathname === "/" ? "" : home.pathname.replace(/\/$/, "");
		const candidates = named !== undefined ? [named] : [`${home.origin}/.well-known/oauth-protected-resource${path}`, `${home.origin}/.well-known/oauth-protected-resource`];
		let found: ReturnType<typeof resourceMetadata> | undefined;
		for (const candidate of candidates) {
			const raw = await getJson(await checkUrl(candidate, connectorUrl, "resource metadata"));
			found = raw === undefined ? undefined : attempt(raw, resourceMetadata);
			if (found !== undefined && found.authorization_servers.length > 0) break;
		}
		if (found === undefined || found.authorization_servers.length === 0) throw new Error(`${home.host} doesn't say how to sign in (no protected resource metadata)`);
		// The resource must be this server, or a part of its URL that contains it, as Home Assistant gives its origin.
		const resource = found.resource ?? home.origin;
		if (!connectorUrl.startsWith(resource.replace(/\/$/, "")) || new URL(resource).origin !== home.origin) throw new Error(`${home.host}'s metadata is for another resource, ${resource}`);
		const issuer = found.authorization_servers[0]!;
		const issuerUrl = await checkUrl(issuer, connectorUrl, "authorization server");
		const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
		const wellKnown = [`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`];
		for (const url of new Set(wellKnown)) {
			const raw = await getJson(new URL(url));
			const metadata = raw === undefined ? undefined : attempt(raw, serverMetadata);
			if (metadata === undefined) continue;
			// RFC 8414: the issuer it states must be the one it was looked up as.
			if (metadata.issuer === undefined || metadata.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
				throw new Error(`${issuerUrl.host}'s metadata names ${metadata.issuer ?? "no issuer"}, not ${issuer}; check the server's configured URL`);
			}
			if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) throw new Error(`${issuerUrl.host} doesn't say it supports PKCE with S256, which MCP requires`);
			const result: ServerMetadata = {
				issuer,
				authorizationEndpoint: (await checkUrl(metadata.authorization_endpoint, connectorUrl, "authorization endpoint")).href,
				tokenEndpoint: (await checkUrl(metadata.token_endpoint, connectorUrl, "token endpoint")).href,
				cimd: metadata.client_id_metadata_document_supported === true,
				resource,
			};
			if (metadata.registration_endpoint !== undefined) result.registrationEndpoint = (await checkUrl(metadata.registration_endpoint, connectorUrl, "registration endpoint")).href;
			const scope = challengeParams(challenge).get("scope");
			const scopes = scope !== undefined ? scope.split(" ").filter((s) => s !== "") : found.scopes_supported;
			if (scopes !== undefined && scopes.length > 0) result.scopes = scopes;
			return result;
		}
		throw new Error(`${issuerUrl.host} has no authorization server metadata`);
	}

	/** The client id to present: the owner's, a metadata document's, or one registered now. */
	async function clientFor(metadata: ServerMetadata, given: string | undefined): Promise<{ clientId: string; clientSecret?: string }> {
		if (given !== undefined) return { clientId: given };
		if (options.redirectUri === undefined) throw new Error("Signing a connector in needs web.url in the settings, for the browser to come back to");
		if (metadata.cimd && options.clientId !== undefined) return { clientId: options.clientId };
		if (metadata.registrationEndpoint !== undefined) {
			const response = await send(metadata.registrationEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ client_name: "gaidin", redirect_uris: [options.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" }),
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
			const body = await response.text();
			if (!response.ok) throw new Error(`Registering with ${new URL(metadata.registrationEndpoint).host} failed: HTTP ${response.status} ${body.slice(0, 200)}`);
			const registered = parse(JSON.parse(body), registration, "the registration's answer");
			return registered.client_secret === undefined ? { clientId: registered.client_id } : { clientId: registered.client_id, clientSecret: registered.client_secret };
		}
		throw new Error(`${new URL(metadata.issuer).host} takes neither a client id document nor registration; give a client id for this connector`);
	}

	/** Starts signing `connector` in: the URL to send the owner's browser to. */
	async function start(connector: string, connectorUrl: string, challenge: string | undefined, givenClientId: string | undefined): Promise<string> {
		if (options.redirectUri === undefined) throw new Error("Signing a connector in needs web.url in the settings, for the browser to come back to");
		for (const [state, p] of pending) if (p.at < Date.now() - PENDING_MS) pending.delete(state);
		const metadata = await discover(connectorUrl, challenge);
		const client = await clientFor(metadata, givenClientId);
		const verifier = base64url(randomBytes(32));
		const state = base64url(randomBytes(24));
		const entry: Pending = { connector, verifier, metadata, clientId: client.clientId, at: Date.now() };
		if (client.clientSecret !== undefined) entry.clientSecret = client.clientSecret;
		pending.set(state, entry);
		const url = new URL(metadata.authorizationEndpoint);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", client.clientId);
		url.searchParams.set("redirect_uri", options.redirectUri);
		url.searchParams.set("state", state);
		url.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("resource", metadata.resource);
		if (metadata.scopes !== undefined) url.searchParams.set("scope", metadata.scopes.join(" "));
		return url.href;
	}

	/** Posts to a token endpoint, form-encoded, and reads the tokens. */
	async function tokens(endpoint: string, fields: URLSearchParams): Promise<ReturnType<typeof tokenAnswer>> {
		const response = await send(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: fields.toString(),
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		const body = await response.text();
		if (!response.ok) throw new Error(`${new URL(endpoint).host} refused the token request: HTTP ${response.status} ${body.slice(0, 200)}`);
		return parse(JSON.parse(body), tokenAnswer, "the token answer");
	}

	const grantOf = (answer: ReturnType<typeof tokenAnswer>, from: Omit<Grant, "token" | "refresh" | "expiresAt" | "scope">, keep?: string): Grant => {
		const grant: Grant = { ...from, token: answer.access_token };
		const refresh = answer.refresh_token ?? keep;
		if (refresh !== undefined) grant.refresh = refresh;
		if (answer.expires_in !== undefined) grant.expiresAt = Date.now() + answer.expires_in * 1000;
		if (answer.scope !== undefined) grant.scope = answer.scope;
		return grant;
	};

	/** The owner's browser came back: checks state and issuer, and redeems the code. */
	async function finish(query: URLSearchParams): Promise<{ connector: string; grant: Grant }> {
		const state = query.get("state") ?? "";
		const flow = pending.get(state);
		if (flow === undefined || flow.at < Date.now() - PENDING_MS) throw new Error("This sign-in isn't one gaidin started, or it took over 10 minutes; start it again");
		pending.delete(state);
		const error = query.get("error");
		if (error !== null) throw new Error(`${new URL(flow.metadata.issuer).host} said ${error}${query.get("error_description") === null ? "" : `: ${query.get("error_description")}`}`);
		const iss = query.get("iss");
		if (iss !== null && iss.replace(/\/$/, "") !== flow.metadata.issuer.replace(/\/$/, "")) throw new Error(`The answer came from ${iss}, not ${flow.metadata.issuer}`);
		const code = query.get("code");
		if (code === null) throw new Error("The answer has no code");
		const fields = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: options.redirectUri!, client_id: flow.clientId, code_verifier: flow.verifier, resource: flow.metadata.resource });
		if (flow.clientSecret !== undefined) fields.set("client_secret", flow.clientSecret);
		const answer = await tokens(flow.metadata.tokenEndpoint, fields);
		const from: Omit<Grant, "token" | "refresh" | "expiresAt" | "scope"> = { issuer: flow.metadata.issuer, clientId: flow.clientId, tokenEndpoint: flow.metadata.tokenEndpoint, resource: flow.metadata.resource };
		if (flow.clientSecret !== undefined) from.clientSecret = flow.clientSecret;
		return { connector: flow.connector, grant: grantOf(answer, from) };
	}

	/** A fresh grant from the refresh token. Throws when there's none or it's refused. */
	async function refresh(grant: Grant): Promise<Grant> {
		if (grant.refresh === undefined) throw new Error("There's no refresh token");
		const fields = new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refresh, client_id: grant.clientId, resource: grant.resource });
		if (grant.clientSecret !== undefined) fields.set("client_secret", grant.clientSecret);
		const { token: _token, refresh: kept, expiresAt: _expires, scope: _scope, ...from } = grant;
		return grantOf(await tokens(grant.tokenEndpoint, fields), from, kept);
	}

	/** The Client ID Metadata Document for `clientId`, which gaidin serves and the owner can host. */
	const document = (clientId: string) => ({ client_id: clientId, client_name: "gaidin", redirect_uris: [options.redirectUri ?? ""], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "web" });

	return { discover, start, finish, refresh, document, clientId: options.clientId };
}

export type OAuth = ReturnType<typeof createOAuth>;

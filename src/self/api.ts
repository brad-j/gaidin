// What a self-written extension sees (self/index.ts). Its files import these types with
// `import type { Tool } from "gaidin"`; nothing here exists at runtime.

/** A page fetched through the server, under fetch_url's rules. */
export type Fetched = { url: string; status: number; contentType: string; text: string };

export type ToolApi = {
	/** GETs a public http or https URL. A host the owner hasn't allowed waits for their approval. */
	fetch: (url: string) => Promise<Fetched>;
};

export type Tool = {
	name: string;
	description: string;
	/** A JSON Schema for the arguments. They're checked against it before `execute` runs. */
	parameters: { type: "object"; properties: Record<string, object>; required?: string[] };
	/** Returns the result text; a thrown error becomes an error result. `never` lets each tool type its own arguments. */
	execute: (args: never, api: ToolApi) => Promise<string>;
};

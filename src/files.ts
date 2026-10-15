// Files sent with the owner's messages, from Slack or the app. An image small enough goes to the model with the text;
// other files, such as PDFs, are saved in the agent's sandbox under uploads/, and the message says where. The app
// sends a message's files ahead of it to /api/files, which keeps them here until the message names them.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { number, object, optional, parseJson, string } from "./parse.ts";

/** The model takes images up to 5 MB, as base64; this leaves room for that. */
export const MAX_IMAGE = 3_750_000;
export const MAX_FILE = 20_000_000;

/** The image type from the bytes themselves, which a name or a thumbnail's URL doesn't prove, or nothing for another kind of file. */
export function imageType(data: Buffer): string | undefined {
	if (data.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
	if (data.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
	if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return undefined;
}

/** A file sent with a message. `prefix` makes its name in uploads/ the same each time the message is delivered. */
export type Attached = { name: string; type?: string; size?: number; prefix: string; load: () => Promise<Buffer> };

/**
 * The message with its images, and a note of where its other files are saved in `sandbox` or why one couldn't be
 * fetched. `from` says where they came from: "Slack", "the app".
 */
export async function withFiles(text: string, files: readonly Attached[], sandbox: string, from: string): Promise<UserInput> {
	const images: ImageContent[] = [];
	const notes: string[] = [];
	for (const file of files) {
		try {
			if ((file.size ?? 0) > MAX_FILE) throw new Error(`it's over ${MAX_FILE / 1_000_000} MB`);
			const data = await file.load();
			const mimeType = imageType(data);
			if (mimeType !== undefined && data.length <= MAX_IMAGE) {
				images.push({ type: "image", data: data.toString("base64"), mimeType });
				continue;
			}
			const path = `uploads/${file.prefix}-${file.name.replace(/[^\w.-]+/g, "_")}`;
			mkdirSync(join(sandbox, "uploads"), { recursive: true });
			writeFileSync(join(sandbox, path), data);
			notes.push(`${file.name} is saved as ${path} (${file.type ?? mimeType ?? "unknown type"}, ${Math.ceil(data.length / 1000)} KB)`);
		} catch (error) {
			notes.push(`${file.name} couldn't be fetched: ${error instanceof Error ? error.message : error}`);
		}
	}
	const note = notes.length === 0 ? "" : `\n\n[Files from ${from}: ${notes.join("; ")}. Read them with the file tools; for a PDF, run pdftotext FILE - in bash. uploads/ is read-only to commands, so write what you make from them elsewhere.]`;
	return images.length === 0 ? `${text}${note}` : [{ type: "text", text: `${text}${note}` }, ...images];
}

/** A file the app sent, as the message that names it will have it. */
export type Uploaded = { id: string; name: string; size: number; image: boolean };

const ID = /^[0-9a-f-]{36}$/;
const meta = object({ name: string, type: optional(string), size: number });
const DAY = 86_400_000;

/** Files the app sent ahead of the message that names them, in `dir`. A day after it came, one is gone. */
export function createUploads(dir: string) {
	function clear() {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) if (statSync(join(dir, name)).mtimeMs < Date.now() - DAY) rmSync(join(dir, name), { force: true });
	}

	return {
		save(name: string, type: string | undefined, data: Buffer): Uploaded {
			clear();
			mkdirSync(dir, { recursive: true });
			const id = randomUUID();
			writeFileSync(join(dir, id), data);
			writeFileSync(join(dir, `${id}.json`), JSON.stringify({ name, type, size: data.length }));
			return { id, name, size: data.length, image: imageType(data) !== undefined };
		},

		/** The upload `id` as a message's file. Throws when there's none, or it's gone. */
		attached(id: string): Attached {
			const file = join(dir, `${id}.json`);
			if (!ID.test(id) || !existsSync(file)) throw new Error(`There's no file ${id}; send it again.`);
			const { name, type, size } = parseJson(readFileSync(file, "utf8"), meta, "an upload's details");
			return { name, type, size, prefix: id.slice(0, 8), load: async () => readFileSync(join(dir, id)) };
		},
	};
}

export type Uploads = ReturnType<typeof createUploads>;

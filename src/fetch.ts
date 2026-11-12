import { handoffFor } from "./handoff.ts";
import { fetchHttp } from "./http.ts";
import type { Lookup } from "./ssrf.ts";
import { generateId, storeResult } from "./storage.ts";
import type { FetchMode, FetchOutput, FetchParams, StoredUrlContent } from "./types.ts";
import { codedError, mapLimit } from "./utils.ts";

export interface FetchDeps {
	/** Test seams only; defaults to the global fetch and system resolver. */
	fetch?: typeof fetch;
	lookup?: Lookup;
}

interface Target {
	url?: URL;
	error?: string;
}

function classifyTarget(raw: string): Target {
	if (/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])/.test(raw)) {
		return { error: "Local files are not supported; use the built-in bash/read tools and write outputs under $TMPDIR" };
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { error: `Invalid URL: ${raw}` };
	}
	if (url.protocol === "file:") {
		return { error: "Local files are not supported; use the built-in bash/read tools and write outputs under $TMPDIR" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: `Unsupported URL scheme: ${url.protocol}` };
	}
	if (url.username || url.password) {
		return { error: "URLs with embedded credentials are not supported" };
	}
	return { url };
}

function errorContent(url: string, error: string): StoredUrlContent {
	return { url, title: "", content: "", error };
}

function normalizeUrls(params: FetchParams): string[] {
	const single = params.url?.trim() ?? "";
	const many = (Array.isArray(params.urls) ? params.urls : []).map((url) => url.trim()).filter(Boolean);
	if (single && many.length > 0) {
		throw codedError("INVALID_REQUEST", "Pass either url or urls, not both");
	}
	const urls = single ? [single] : many;
	if (urls.length === 0) {
		throw codedError("INVALID_REQUEST", "url or urls must contain at least one non-empty string");
	}
	return [...new Set(urls)];
}

async function fetchOne(
	raw: string,
	mode: FetchMode,
	signal: AbortSignal | undefined,
	deps: FetchDeps | undefined,
): Promise<StoredUrlContent> {
	const target = classifyTarget(raw);
	if (target.error || !target.url) return errorContent(raw, target.error ?? "Invalid target");

	const handoff = handoffFor(target.url);
	if (handoff) return { ...errorContent(raw, handoff.message), handoff: handoff.kind };

	return fetchHttp(raw, {
		mode: mode === "raw" ? "raw" : "readable",
		signal,
		fetch: deps?.fetch,
		lookup: deps?.lookup,
	});
}

export async function fetchContent(
	params: FetchParams,
	signal?: AbortSignal,
	deps?: FetchDeps,
): Promise<FetchOutput> {
	const mode = params.mode ?? "readable";
	if (mode !== "readable" && mode !== "raw" && mode !== "answer") {
		throw codedError("INVALID_REQUEST", `Unknown fetch mode: ${String(mode)}`);
	}
	if (mode === "answer" && !params.prompt?.trim()) {
		throw codedError("INVALID_REQUEST", "prompt is required when mode is answer");
	}

	const urls = normalizeUrls(params);
	const results = await mapLimit(urls, 3, (url) => fetchOne(url, mode, signal, deps));
	const responseId = generateId();
	storeResult({ id: responseId, type: "fetch", timestamp: Date.now(), urls: results });
	return { responseId, urls: results };
}

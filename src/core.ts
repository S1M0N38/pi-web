import { formatSize, truncateHead, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { fetchContent as fetchContentPipeline } from "./fetch.ts";
import { webSearch } from "./search.ts";
import { sourceCheck as sourceCheckPipeline, type ResearchArtifact, type SourceCheckParams } from "./source-check.ts";
import { getResult } from "./storage.ts";
import type { CommandExec, FetchParams, QueryResult, StoredUrlContent, WebSearchParams } from "./types.ts";
import { codedError } from "./utils.ts";

export const MAX_INLINE_CONTENT_CHARS = 30_000;
const MAX_ANSWER_INPUT_BYTES = 100_000;

type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

export interface CoreContext {
	exec: CommandExec;
	signal?: AbortSignal;
	modelRegistry?: ExtensionContext["modelRegistry"];
}

export interface WebSearchResult {
	responseId: string;
	text: string;
	queries: QueryResult[];
	isError: boolean;
}

export interface FetchContentResult {
	responseId: string;
	text: string;
	urls: StoredUrlContent[];
	isError: boolean;
}

export interface GetSearchContentParams {
	responseId: string;
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	offset?: number;
	limit?: number;
}

export interface GetSearchContentResult {
	text: string;
	details: {
		responseId: string;
		type: "search" | "fetch" | "research";
		contentLength: number;
		offset: number;
		limit: number;
		returnedChars: number;
		nextOffset: number | null;
	};
}

function boundedText(text: string, responseId: string): string {
	const truncated = truncateHead(text, { maxBytes: MAX_INLINE_CONTENT_CHARS });
	if (!truncated.truncated) return text;
	return `${truncated.content}\n\n[Truncated: ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}. Use get_search_content({ responseId: "${responseId}", offset: ${truncated.content.length}, limit: ${MAX_INLINE_CONTENT_CHARS} }) for the next slice.]`;
}

function formatQuery(query: QueryResult, index: number): string {
	const lines = [`### Query ${index + 1}: ${query.query}`, `Provider: ${query.provider ?? "none"}`];
	if (query.answer.trim()) lines.push("", query.answer.trim());
	if (query.error) lines.push("", `Error: ${query.error}`);
	for (const [resultIndex, result] of query.results.entries()) {
		lines.push("", `${resultIndex + 1}. ${result.title}`, `   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	}
	if (!query.answer.trim() && !query.error && query.results.length === 0) lines.push("", "(no results)");
	return lines.join("\n");
}

export async function runWebSearch(params: WebSearchParams, ctx: CoreContext): Promise<WebSearchResult> {
	const output = await webSearch(params, ctx.exec, ctx.signal);
	const body = output.queries.map(formatQuery).join("\n\n---\n\n");
	const text = `${body}\n\nresponseId: ${output.responseId}\nUse get_search_content({ responseId: "${output.responseId}", queryIndex: 0, offset: 0, limit: ${MAX_INLINE_CONTENT_CHARS} }) for full numbered results.`;
	return {
		responseId: output.responseId,
		text: boundedText(text, output.responseId),
		queries: output.queries,
		isError: output.queries.length > 0 && output.queries.every((query) => query.error !== null),
	};
}

function formatFetch(output: { responseId: string; urls: StoredUrlContent[] }): string {
	const sections = output.urls.map((item, index) => {
		if (item.handoff) return item.error ?? "";
		if (item.error) return `ERROR: ${item.url}\n${item.error}`;
		const lines = [`### ${index + 1}. ${item.title || item.url}`, `URL: ${item.url}`, "", item.content || "(empty)"];
		if (item.pdfPath) lines.push("", `PDF: ${item.pdfPath}`, `Markdown: ${item.markdownPath}`);
		return lines.join("\n");
	});
	return `${sections.join("\n\n---\n\n")}\n\nresponseId: ${output.responseId}`;
}

function parseAnswerModel(value: string): { provider: string; modelId: string; reasoning?: ReasoningLevel } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw codedError("CONFIG", `Invalid answerModel: ${value}`);
	}
	let modelId = value.slice(slash + 1);
	const colon = modelId.lastIndexOf(":");
	const suffix = colon > 0 ? modelId.slice(colon + 1) : "";
	const reasoning = REASONING_LEVELS.has(suffix) ? suffix as ReasoningLevel : undefined;
	if (reasoning) modelId = modelId.slice(0, colon);
	return { provider: value.slice(0, slash), modelId, ...(reasoning ? { reasoning } : {}) };
}

async function answerWithModel(prompt: string, urls: StoredUrlContent[], ctx: CoreContext): Promise<string> {
	if (!ctx.modelRegistry) throw codedError("CONFIG", "Answer mode requires the Pi model registry");
	const { provider, modelId, reasoning } = parseAnswerModel(loadConfig().answerModel);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw codedError("CONFIG", `Answer model not found: ${provider}/${modelId}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw codedError("CONFIG", `No authentication configured for answer model: ${provider}/${modelId}`);
	}

	const content = urls.map((item) => `Source: ${item.url}\n${item.content}`).join("\n\n---\n\n");
	const bounded = truncateHead(content, { maxBytes: MAX_ANSWER_INPUT_BYTES });
	const input = `Question: ${prompt}\n\nContent:\n${bounded.content}${bounded.truncated ? "\n\n[Content truncated]" : ""}`;
	const stream = ctx.modelRegistry.streamSimple(
		model,
		{
			systemPrompt: "Answer the question using only the supplied content. Cite source URLs inline when useful. If the content does not contain the answer, say so plainly and do not guess.",
			messages: [{
				role: "user",
				content: [{ type: "text", text: input }],
				timestamp: Date.now(),
			}],
		},
		{ signal: ctx.signal, sessionId: uuidv7(), ...(reasoning ? { reasoning } : {}) },
	);
	const response = await stream.result();
	if (response.stopReason === "aborted") throw codedError("ABORT", "Answer aborted");
	if (response.stopReason === "error") throw codedError("NETWORK", response.errorMessage ?? "Answer model failed");
	const answer = response.content.filter((content) => content.type === "text").map((content) => content.text).join("\n").trim();
	if (!answer) throw codedError("INVALID_RESPONSE", "Answer model returned no text");
	return answer;
}

export async function runFetchContent(params: FetchParams, ctx: CoreContext): Promise<FetchContentResult> {
	const output = await fetchContentPipeline(params, ctx.signal);
	let text = formatFetch(output);
	if (params.mode === "answer") {
		const usable = output.urls.filter((item) => !item.error && item.content.trim().length > 0);
		if (usable.length > 0) {
			text = await answerWithModel(params.prompt ?? "", usable, ctx);
		} else {
			text = `${text}\n\nNo readable content to answer from.`;
		}
	}
	return {
		responseId: output.responseId,
		text: boundedText(text, output.responseId),
		urls: output.urls,
		isError: output.urls.length > 0 && output.urls.every((item) => item.error !== null && !item.handoff),
	};
}

function queryText(query: QueryResult, index: number): string {
	return formatQuery(query, index);
}

function fetchText(url: StoredUrlContent): string {
	if (url.handoff) return url.error ?? "";
	if (url.error) return `Error: ${url.error}`;
	return url.content;
}

export async function runGetSearchContent(params: GetSearchContentParams): Promise<GetSearchContentResult> {
	const data = getResult(params.responseId);
	if (!data) throw codedError("INVALID_REQUEST", `Unknown responseId: ${params.responseId}`);

	let content: string;
	if (data.type === "search") {
		const queries = data.queries ?? [];
		const index = params.query !== undefined
			? queries.findIndex((query) => query.query === params.query)
			: params.queryIndex ?? 0;
		if (index < 0 || index >= queries.length) {
			throw codedError("INVALID_REQUEST", `Unknown query in responseId ${params.responseId}`);
		}
		content = queryText(queries[index], index);
	} else if (data.type === "fetch") {
		const urls = data.urls ?? [];
		const index = params.url !== undefined
			? urls.findIndex((url) => url.url === params.url)
			: params.urlIndex ?? 0;
		if (index < 0 || index >= urls.length) {
			throw codedError("INVALID_REQUEST", `Unknown URL in responseId ${params.responseId}`);
		}
		content = fetchText(urls[index]);
	} else {
		content = JSON.stringify(data.artifact, null, 2);
	}

	const offset = params.offset ?? 0;
	const limit = params.limit ?? MAX_INLINE_CONTENT_CHARS;
	if (!Number.isInteger(offset) || offset < 0) {
		throw codedError("INVALID_REQUEST", "offset must be a non-negative integer");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INLINE_CONTENT_CHARS) {
		throw codedError("INVALID_REQUEST", `limit must be an integer from 1 to ${MAX_INLINE_CONTENT_CHARS}`);
	}
	if (offset > content.length) {
		throw codedError("INVALID_REQUEST", `offset ${offset} is out of range for content length ${content.length}`);
	}

	const end = Math.min(offset + limit, content.length);
	const nextOffset = end < content.length ? end : null;
	const slice = content.slice(offset, end);
	const text = nextOffset === null
		? slice
		: `${slice}\n\n[Showing chars ${offset}-${end} of ${content.length}. Use get_search_content({ responseId: "${params.responseId}", offset: ${end}, limit: ${limit} }) for the next slice.]`;
	return {
		text,
		details: {
			responseId: params.responseId,
			type: data.type,
			contentLength: content.length,
			offset,
			limit,
			returnedChars: slice.length,
			nextOffset,
		},
	};
}

export interface SourceCheckResult {
	responseId: string;
	text: string;
	artifact: ResearchArtifact;
}

export async function runSourceCheck(params: SourceCheckParams, ctx: CoreContext): Promise<SourceCheckResult> {
	const result = await sourceCheckPipeline(params, ctx.exec, ctx.signal);
	return { responseId: result.responseId, text: result.text, artifact: result.artifact };
}

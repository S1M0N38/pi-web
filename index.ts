import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./src/config.ts";
import {
	MAX_INLINE_CONTENT_CHARS,
	runFetchContent,
	runGetSearchContent,
	runSourceCheck,
	runWebSearch,
} from "./src/core.ts";

const RECENCY = Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")]);
const PROVIDER = Type.Union([
	Type.Literal("auto"),
	Type.Literal("brave"),
	Type.Literal("tavily"),
	Type.Literal("exa"),
	Type.Literal("duckduckgo"),
]);
const MODE = Type.Union([Type.Literal("readable"), Type.Literal("raw"), Type.Literal("answer")]);

const webSearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Single search query." })),
	queries: Type.Optional(Type.Array(Type.String(), { description: "Up to three queries run concurrently." })),
	numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Results per query (default 5)." })),
	recencyFilter: Type.Optional(RECENCY),
	domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Include domains, or prefix with '-' to exclude." })),
	provider: Type.Optional(PROVIDER),
});

const fetchContentSchema = Type.Object({
	url: Type.Optional(Type.String()),
	urls: Type.Optional(Type.Array(Type.String(), { description: "Up to three URLs fetched concurrently." })),
	mode: Type.Optional(MODE),
	prompt: Type.Optional(Type.String({ description: "Required when mode is 'answer'." })),
});

const getSearchContentSchema = Type.Object({
	responseId: Type.String(),
	query: Type.Optional(Type.String()),
	queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	url: Type.Optional(Type.String()),
	urlIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_INLINE_CONTENT_CHARS })),
});

const sourceCheckSchema = Type.Object({
	claim: Type.String(),
	queries: Type.Optional(Type.Array(Type.String())),
	numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	fetchContent: Type.Optional(Type.Boolean()),
	recencyFilter: Type.Optional(RECENCY),
	domainFilter: Type.Optional(Type.Array(Type.String())),
	provider: Type.Optional(PROVIDER),
});

export default function piWebAccessMin(pi: ExtensionAPI): void {
	loadConfig();

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web through the configured provider chain and store the results by responseId.",
		promptSnippet: "Search the web through the configured providers.",
		promptGuidelines: [
			"Use web_search for discovery; use fetch_content to read a result URL.",
			"Use get_search_content with the returned responseId to page full stored results.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runWebSearch(params, {
				exec: pi.exec,
				signal: signal ?? ctx.signal,
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: { responseId: result.responseId, queries: result.queries },
				isError: result.isError,
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch a URL as readable Markdown, raw text, or a grounded answer. Native-tool handoffs explain when to use gh, yt-dlp, or opencli.",
		promptSnippet: "Fetch a page or PDF, or get an answer from fetched content.",
		promptGuidelines: [
			"Use fetch_content when you need the contents of a specific URL.",
			"Use mode 'answer' with a prompt to keep large page content out of the session.",
			"Native-tool handoff messages tell you to use gh, yt-dlp, or opencli instead.",
		],
		parameters: fetchContentSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runFetchContent(params, {
				exec: pi.exec,
				signal: signal ?? ctx.signal,
				modelRegistry: ctx.modelRegistry,
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					responseId: result.responseId,
					urls: result.urls.map((item) => ({
						url: item.url,
						title: item.title,
						error: item.error,
						handoff: item.handoff,
						mimeType: item.mimeType,
						status: item.status,
						pdfPath: item.pdfPath,
						markdownPath: item.markdownPath,
					})),
				},
				isError: result.isError,
			};
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Page stored search results, fetched pages, or source-check artifacts by responseId.",
		promptSnippet: "Page stored results by responseId.",
		promptGuidelines: [
			"Use get_search_content with a responseId instead of fetching the same content again.",
			"Page with offset and limit when the previous result ended with a continuation notice.",
		],
		parameters: getSearchContentSchema,
		async execute(_toolCallId, params) {
			const result = await runGetSearchContent(params);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "source_check",
		label: "Source Check",
		description: "Gather source quality, hashes, and passage offsets for a claim. Does not judge the claim.",
		promptSnippet: "Gather evidence sources and passages for a claim.",
		promptGuidelines: [
			"Use source_check to collect evidence for a claim; it returns unclear or missing-evidence, not a verdict.",
			"Use get_search_content with the returned responseId to page the full JSON artifact.",
		],
		parameters: sourceCheckSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runSourceCheck(params, {
				exec: pi.exec,
				signal: signal ?? ctx.signal,
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					responseId: result.responseId,
					status: result.artifact.status,
					sources: result.artifact.sources.length,
					passages: result.artifact.passages.length,
				},
			};
		},
	});
}

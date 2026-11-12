import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommandExec = ExtensionAPI["exec"];

export type ProviderName = "brave" | "tavily" | "exa" | "duckduckgo";
export type RecencyFilter = "day" | "week" | "month" | "year";
export type SearchRoute = "auto" | ProviderName;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** One provider call: its optional answer plus the numbered results. */
export interface SearchResponse {
	provider: ProviderName;
	answer: string;
	results: SearchResult[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	signal?: AbortSignal;
}

export interface WebSearchParams {
	query?: string;
	queries?: string[];
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	provider?: SearchRoute;
}

export interface WebSearchOutput {
	responseId: string;
	queries: QueryResult[];
}

export type FetchMode = "readable" | "raw" | "answer";

export interface FetchParams {
	url?: string;
	urls?: string[];
	mode?: FetchMode;
	prompt?: string;
}

export interface FetchOutput {
	responseId: string;
	urls: StoredUrlContent[];
}

/** One query in a (possibly multi-query) web_search call. */
export interface QueryResult {
	query: string;
	provider: ProviderName | null;
	answer: string;
	results: SearchResult[];
	error: string | null;
}

export interface StoredUrlContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	mimeType?: string;
	status?: number;
	pdfPath?: string;
	markdownPath?: string;
	handoff?: "github" | "gist" | "youtube" | "opencli";
}

/** Everything get_search_content can read back, kept in process memory only. */
export interface StoredSearchData {
	id: string;
	type: "search" | "fetch" | "research";
	timestamp: number;
	queries?: QueryResult[];
	urls?: StoredUrlContent[];
	artifact?: unknown;
}

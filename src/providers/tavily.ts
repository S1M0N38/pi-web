import { parseDomainFilter, matchesDomainFilter } from "../domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import { codedError, fetchError, formatAnswer, httpError, normalizeResultCount, redact, requestSignal } from "../utils.ts";

const API_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 30_000;

interface TavilyResult {
	title?: string;
	url?: string;
	content?: string;
}

interface TavilyResponse {
	answer?: string;
	results?: TavilyResult[];
}

export async function searchWithTavily(query: string, apiKey: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = normalizeResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const body: Record<string, unknown> = {
		query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "basic",
		include_raw_content: false,
		...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
		...(filters.allow.length > 0 ? { include_domains: filters.allow } : {}),
		...(filters.deny.length > 0 ? { exclude_domains: filters.deny } : {}),
	};

	let response: Response;
	try {
		response = await fetch(API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal, TIMEOUT_MS),
		});
	} catch (err) {
		throw fetchError("Tavily", err, options.signal, TIMEOUT_MS);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (err) {
		throw fetchError("Tavily", err, options.signal, TIMEOUT_MS);
	}
	if (!response.ok) {
		throw httpError("Tavily", response.status, redact(text, apiKey), response.headers.get("retry-after"), [432]);
	}

	let data: TavilyResponse;
	try {
		data = JSON.parse(text) as TavilyResponse;
	} catch {
		throw codedError("INVALID_RESPONSE", "Tavily returned invalid JSON");
	}

	const results: SearchResult[] = [];
	for (const item of data.results ?? []) {
		if (!item.url || !matchesDomainFilter(item.url, filters)) continue;
		results.push({
			title: item.title || `Source ${results.length + 1}`,
			url: item.url,
			snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "",
		});
		if (results.length >= numResults) break;
	}

	return {
		provider: "tavily",
		answer: typeof data.answer === "string" ? data.answer : "",
		results,
	};
}

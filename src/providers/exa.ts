import { parseDomainFilter, matchesDomainFilter } from "../domain-filter-normalization.ts";
import type { RecencyFilter, SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import { codedError, fetchError, formatAnswer, httpError, normalizeResultCount, redact, requestSignal } from "../utils.ts";

const API_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 30_000;
const RECENCY_DAYS: Record<RecencyFilter, number> = { day: 1, week: 7, month: 30, year: 365 };

interface ExaResult {
	title?: string;
	url?: string;
	highlights?: unknown;
}

interface ExaResponse {
	results?: ExaResult[];
}

function startPublishedDate(filter: RecencyFilter): string {
	return new Date(Date.now() - RECENCY_DAYS[filter] * 86_400_000).toISOString();
}

function highlights(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ").trim();
}

function sourceLabel(url: string, index: number): string {
	try {
		return new URL(url).hostname || `Source ${index + 1}`;
	} catch {
		return `Source ${index + 1}`;
	}
}

export async function searchWithExa(query: string, apiKey: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = normalizeResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const body = {
		query,
		type: "auto",
		numResults,
		...(filters.allow.length > 0 ? { includeDomains: filters.allow } : {}),
		...(filters.deny.length > 0 ? { excludeDomains: filters.deny } : {}),
		...(options.recencyFilter ? { startPublishedDate: startPublishedDate(options.recencyFilter) } : {}),
		contents: { highlights: true },
	};

	let response: Response;
	try {
		response = await fetch(API_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: requestSignal(options.signal, TIMEOUT_MS),
		});
	} catch (err) {
		throw fetchError("Exa", err, options.signal, TIMEOUT_MS);
	}

	let text: string;
	try {
		text = await response.text();
	} catch (err) {
		throw fetchError("Exa", err, options.signal, TIMEOUT_MS);
	}
	if (!response.ok) {
		throw httpError("Exa", response.status, redact(text, apiKey), response.headers.get("retry-after"));
	}

	let data: ExaResponse;
	try {
		data = JSON.parse(text) as ExaResponse;
	} catch {
		throw codedError("INVALID_RESPONSE", "Exa returned invalid JSON");
	}

	const results: SearchResult[] = [];
	for (const item of data.results ?? []) {
		if (!item.url || !matchesDomainFilter(item.url, filters)) continue;
		results.push({
			title: item.title || sourceLabel(item.url, results.length),
			url: item.url,
			snippet: highlights(item.highlights).slice(0, 1000),
		});
		if (results.length >= numResults) break;
	}

	return { provider: "exa", answer: formatAnswer(results), results };
}

import { parseDomainFilter, matchesDomainFilter, type DomainFilters } from "../domain-filter-normalization.ts";
import type { RecencyFilter, SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import { codedError, fetchError, formatAnswer, httpError, normalizeResultCount, redact, requestSignal } from "../utils.ts";

const API_URL = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 30_000;
const FRESHNESS: Record<RecencyFilter, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&nbsp;": " ",
	"&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
	"&rdquo;": "”", "&ldquo;": "“", "&middot;": "·", "&bull;": "•", "&deg;": "°",
};

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&(?:#(x?)([0-9a-f]+)|[a-z]+);/gi, (entity, hex: string | undefined, digits: string | undefined) => {
			if (!digits) return HTML_ENTITIES[entity.toLowerCase()] ?? entity;
			const code = Number.parseInt(digits, hex ? 16 : 10);
			return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
		})
		.trim();
}

function buildQuery(query: string, filters: DomainFilters): string {
	const parts = [query];
	if (filters.allow.length === 1) parts.push(`site:${filters.allow[0]}`);
	else if (filters.allow.length > 1) parts.push(filters.allow.map((domain) => `site:${domain}`).join(" OR "));
	for (const domain of filters.deny) parts.push(`NOT site:${domain}`);
	return parts.join(" ");
}

interface BraveResponse {
	web?: {
		results?: Array<{ title?: string; url?: string; description?: string }>;
	};
}

export async function searchWithBrave(query: string, apiKey: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = normalizeResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const params = new URLSearchParams({
		q: buildQuery(query, filters),
		count: String(filters.allow.length > 0 || filters.deny.length > 0 ? 20 : numResults),
	});
	if (options.recencyFilter) params.set("freshness", FRESHNESS[options.recencyFilter]);

	let response: Response;
	try {
		response = await fetch(`${API_URL}?${params.toString()}`, {
			headers: {
				"X-Subscription-Token": apiKey,
				Accept: "application/json",
			},
			signal: requestSignal(options.signal, TIMEOUT_MS),
		});
	} catch (err) {
		throw fetchError("Brave", err, options.signal, TIMEOUT_MS);
	}

	let body: string;
	try {
		body = await response.text();
	} catch (err) {
		throw fetchError("Brave", err, options.signal, TIMEOUT_MS);
	}
	if (!response.ok) {
		throw httpError("Brave", response.status, redact(body, apiKey), response.headers.get("retry-after"));
	}

	let data: BraveResponse;
	try {
		data = JSON.parse(body) as BraveResponse;
	} catch {
		throw codedError("INVALID_RESPONSE", "Brave returned invalid JSON");
	}

	const results: SearchResult[] = [];
	for (const item of data.web?.results ?? []) {
		if (!item.url || !matchesDomainFilter(item.url, filters)) continue;
		results.push({
			title: stripHtml(item.title ?? "") || item.url,
			url: item.url,
			snippet: stripHtml(item.description ?? ""),
		});
		if (results.length >= numResults) break;
	}

	return { provider: "brave", answer: formatAnswer(results), results };
}

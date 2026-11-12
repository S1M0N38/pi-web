import { parseHTML } from "linkedom";
import { parseDomainFilter, matchesDomainFilter } from "../domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "../types.ts";
import { codedError, fetchError, formatAnswer, httpError, normalizeResultCount, requestSignal } from "../utils.ts";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 30_000;
const USER_AGENT = "Mozilla/5.0 (compatible; pi-web/1.0)";

function decodeResultUrl(href: string): string | null {
	try {
		const link = new URL(href, SEARCH_URL);
		const destination = link.searchParams.get("uddg") ?? link.href;
		const url = new URL(destination);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

export async function searchWithDuckDuckGo(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const url = new URL(SEARCH_URL);
	url.searchParams.set("q", query);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Accept: "text/html", "User-Agent": USER_AGENT },
			signal: requestSignal(options.signal, TIMEOUT_MS),
		});
	} catch (err) {
		throw fetchError("DuckDuckGo", err, options.signal, TIMEOUT_MS);
	}

	let html: string;
	try {
		html = await response.text();
	} catch (err) {
		throw fetchError("DuckDuckGo", err, options.signal, TIMEOUT_MS);
	}

	if (response.status === 202) throw codedError("RATE_LIMIT", "DuckDuckGo returned a bot check");
	if (!response.ok) {
		throw httpError("DuckDuckGo", response.status, html, response.headers.get("retry-after"));
	}

	const { document } = parseHTML(html);
	if (document.querySelector(".anomaly-modal__box, #challenge-form")) {
		throw codedError("RATE_LIMIT", "DuckDuckGo returned a bot check");
	}

	const numResults = normalizeResultCount(options.numResults);
	const filters = parseDomainFilter(options.domainFilter);
	const results: SearchResult[] = [];
	let parseable = 0;

	for (const container of document.querySelectorAll(".result")) {
		if (container.classList.contains("result--ad")) continue;
		const anchor = container.querySelector(".result__a");
		const title = anchor?.textContent?.trim() ?? "";
		const href = anchor?.getAttribute("href")?.trim() ?? "";
		const resultUrl = href ? decodeResultUrl(href) : null;
		if (!title || !resultUrl) continue;
		parseable++;
		if (!matchesDomainFilter(resultUrl, filters)) continue;
		const snippet = container.querySelector(".result__snippet")?.textContent?.trim() ?? "";
		results.push({ title, url: resultUrl, snippet });
		if (results.length >= numResults) break;
	}

	if (parseable === 0 && !document.querySelector(".no-results__message")) {
		throw codedError("INVALID_RESPONSE", "DuckDuckGo returned no parseable results");
	}

	return { provider: "duckduckgo", answer: formatAnswer(results), results };
}

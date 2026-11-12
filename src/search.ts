import { getApiKey, loadConfig } from "./config.ts";
import { generateId, storeResult } from "./storage.ts";
import type {
	CommandExec,
	ProviderName,
	QueryResult,
	RecencyFilter,
	SearchOptions,
	SearchResponse,
	SearchRoute,
	WebSearchOutput,
	WebSearchParams,
} from "./types.ts";
import { codedError, errorCode, errorMessage, mapLimit } from "./utils.ts";

const PROVIDER_NAMES: readonly ProviderName[] = ["brave", "tavily", "exa", "duckduckgo"];
const PROVIDER_LABELS: Record<ProviderName, string> = {
	brave: "Brave",
	tavily: "Tavily",
	exa: "Exa",
	duckduckgo: "DuckDuckGo",
};
const RECENCY_FILTERS = new Set<string>(["day", "week", "month", "year"]);

/** Providers are skipped by `auto` and rejected when named, for the rest of the process. */
const coolingDown = new Set<ProviderName>();

/** Test hook: the cooldown otherwise lasts the process lifetime, as designed. */
export function resetSearchCooldown(): void {
	coolingDown.clear();
}

function isProviderName(value: string): value is ProviderName {
	return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function normalizeQueries(params: WebSearchParams): string[] {
	const single = params.query?.trim() ?? "";
	const many = (Array.isArray(params.queries) ? params.queries : []).map((query) => query.trim()).filter(Boolean);
	if (single && many.length > 0) {
		throw codedError("INVALID_REQUEST", "Pass either query or queries, not both");
	}
	const queries = single ? [single] : many;
	if (queries.length === 0) {
		throw codedError("INVALID_REQUEST", "query or queries must contain at least one non-empty string");
	}
	return [...new Set(queries)];
}

function errorResult(query: string, provider: ProviderName | null, message: string): QueryResult {
	return { query, provider, answer: "", results: [], error: message };
}

async function callProvider(
	provider: ProviderName,
	query: string,
	options: SearchOptions,
	exec: CommandExec,
): Promise<SearchResponse> {
	switch (provider) {
		case "brave": {
			const { searchWithBrave } = await import("./providers/brave.ts");
			return searchWithBrave(query, await getApiKey("brave", exec, options.signal), options);
		}
		case "tavily": {
			const { searchWithTavily } = await import("./providers/tavily.ts");
			return searchWithTavily(query, await getApiKey("tavily", exec, options.signal), options);
		}
		case "exa": {
			const { searchWithExa } = await import("./providers/exa.ts");
			return searchWithExa(query, await getApiKey("exa", exec, options.signal), options);
		}
		case "duckduckgo": {
			const { searchWithDuckDuckGo } = await import("./providers/duckduckgo.ts");
			return searchWithDuckDuckGo(query, options);
		}
	}
}

async function searchOne(
	query: string,
	route: SearchRoute,
	configured: readonly ProviderName[],
	options: SearchOptions,
	exec: CommandExec,
): Promise<QueryResult> {
	if (route !== "auto" && !configured.includes(route)) {
		return errorResult(query, route, `Provider "${route}" is not listed in providers (${configured.join(", ")})`);
	}

	const providers = route === "auto" ? configured : [route];
	const diagnostics: string[] = [];

	for (const provider of providers) {
		const label = PROVIDER_LABELS[provider];
		if (coolingDown.has(provider)) {
			diagnostics.push(`${label}: cooling down after a rate limit`);
			continue;
		}

		try {
			const response = await callProvider(provider, query, options, exec);
			return { query, provider, answer: response.answer, results: response.results, error: null };
		} catch (err) {
			const message = errorMessage(err);
			if (errorCode(err) === "ABORT") throw err;
			if (errorCode(err) === "RATE_LIMIT") {
				coolingDown.add(provider);
				diagnostics.push(`${label}: ${message}`);
				continue;
			}
			return errorResult(query, provider, `${label}: ${message}`);
		}
	}

	return errorResult(
		query,
		route === "auto" ? null : route,
		`All providers unavailable:\n- ${diagnostics.join("\n- ") || "no providers configured"}`,
	);
}

export async function webSearch(
	params: WebSearchParams,
	exec: CommandExec,
	signal?: AbortSignal,
): Promise<WebSearchOutput> {
	const config = loadConfig();
	const queries = normalizeQueries(params);
	const route = params.provider ?? "auto";
	if (route !== "auto" && !isProviderName(route)) {
		throw codedError("INVALID_REQUEST", `Unknown search provider: ${String(route)}`);
	}
	if (params.recencyFilter !== undefined && !RECENCY_FILTERS.has(params.recencyFilter)) {
		throw codedError("INVALID_REQUEST", `Unknown recency filter: ${String(params.recencyFilter)}`);
	}
	if (params.domainFilter !== undefined && !Array.isArray(params.domainFilter)) {
		throw codedError("INVALID_REQUEST", "domainFilter must be an array of domain strings");
	}

	const options: SearchOptions = {
		numResults: params.numResults,
		recencyFilter: params.recencyFilter as RecencyFilter | undefined,
		domainFilter: params.domainFilter,
		signal,
	};
	const results = await mapLimit(queries, 3, (query) => searchOne(query, route, config.providers, options, exec));
	const responseId = generateId();
	storeResult({ id: responseId, type: "search", timestamp: Date.now(), queries: results });
	return { responseId, queries: results };
}

import { createHash } from "node:crypto";
import { fetchContent as fetchContentPipeline } from "./fetch.ts";
import { webSearch } from "./search.ts";
import { generateId, storeResult } from "./storage.ts";
import type { CommandExec, QueryResult, RecencyFilter, SearchRoute, StoredUrlContent } from "./types.ts";
import { codedError } from "./utils.ts";

export type SourceQuality = "official_docs" | "vendor_docs" | "repo_issue" | "blog" | "forum" | "news" | "unknown";
export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";

export interface ResearchSource {
	rank: number;
	url: string;
	title: string;
	snippet?: string;
	quality: SourceQuality;
	fetched?: boolean;
	fetch_timestamp?: number;
	content_hash?: string;
	fetch_error?: string;
}

export interface ResearchPassage {
	passage_id: string;
	source_url: string;
	source_rank: number;
	text: string;
	extraction_span?: { start: number; end: number };
	content_hash?: string;
}

export interface ResearchArtifact {
	id: string;
	type: "research";
	timestamp: number;
	claim: string;
	queries: string[];
	status: ClaimStatus;
	sources: ResearchSource[];
	passages: ResearchPassage[];
	provider?: string;
	filters?: { recency?: RecencyFilter; domain_include: string[]; domain_exclude: string[] };
	errors?: Array<{ query: string; error: string }>;
	content_hash?: string;
}

export interface SourceCheckParams {
	claim: string;
	queries?: string[];
	numResults?: number;
	fetchContent?: boolean;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	provider?: SearchRoute;
}

export interface SourceCheckOutput {
	responseId: string;
	text: string;
	artifact: ResearchArtifact;
}

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blogs?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(\/|$)/i;

export function classifySource(url: string): SourceQuality {
	let host = "";
	let path = "";
	try {
		const parsed = new URL(url);
		host = parsed.hostname;
		path = parsed.pathname;
	} catch {
		return "unknown";
	}
	if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
	if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
	if (VENDOR_DOCS_PATHS.test(path)) return "vendor_docs";
	if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return "news";
	if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return "forum";
	if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return "blog";
	return "unknown";
}

export function hashContent(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Span {
	text: string;
	start: number;
	end: number;
}

function terms(value: string): string[] {
	return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))];
}

function sentences(content: string): Span[] {
	const spans: Span[] = [];
	const pattern = /[^.!?\n]+[.!?]*/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		const raw = match[0];
		const text = raw.trim();
		if (text.length === 0 || text.length > 500) continue;
		const start = match.index + raw.indexOf(text);
		spans.push({ text, start, end: start + text.length });
	}
	return spans;
}

function relevantSpans(content: string, claim: string): Span[] {
	const claimTerms = terms(claim);
	const scored = sentences(content).map((span, index) => ({
		span,
		index,
		score: claimTerms.filter((term) => span.text.toLowerCase().includes(term)).length,
	}));
	const ranked = scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
	return ranked.filter((entry) => entry.score > 0).map((entry) => entry.span);
}

function buildPassages(sources: ResearchSource[], fetched: StoredUrlContent[], claim: string): ResearchPassage[] {
	const passages: ResearchPassage[] = [];
	const fetchedByUrl = new Map(fetched.map((item) => [item.url, item]));
	for (const source of sources) {
		if (source.snippet) {
			passages.push({
				passage_id: `p-${source.rank}-0`,
				source_url: source.url,
				source_rank: source.rank,
				text: source.snippet,
				content_hash: hashContent(source.snippet),
			});
		}
		const page = fetchedByUrl.get(source.url);
		if (!page || page.error || !page.content) continue;
		for (const [index, span] of relevantSpans(page.content, claim).entries()) {
			passages.push({
				passage_id: `p-${source.rank}-${index + 1}`,
				source_url: source.url,
				source_rank: source.rank,
				text: span.text,
				extraction_span: { start: span.start, end: span.end },
				content_hash: hashContent(span.text),
			});
		}
	}
	return passages;
}

function buildArtifact(
	claim: string,
	queries: QueryResult[],
	fetched: StoredUrlContent[],
	filters: SourceCheckParams,
): ResearchArtifact {
	const fetchedByUrl = new Map(fetched.map((item) => [item.url, item]));
	const sources: ResearchSource[] = [];
	const seen = new Set<string>();
	for (const query of queries) {
		for (const result of query.results) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			const page = fetchedByUrl.get(result.url);
			sources.push({
				rank: sources.length + 1,
				url: result.url,
				title: result.title,
				snippet: result.snippet,
				quality: classifySource(result.url),
				...(page ? { fetched: !page.error, fetch_timestamp: Date.now() } : {}),
				...(page && !page.error ? { content_hash: hashContent(page.content) } : {}),
				...(page?.error ? { fetch_error: page.error } : {}),
			});
		}
	}
	const passages = buildPassages(sources, fetched, claim);
	const domainFilter = filters.domainFilter ?? [];
	const provider = queries.find((query) => query.provider)?.provider;
	return {
		id: generateId(),
		type: "research",
		timestamp: Date.now(),
		claim,
		queries: queries.map((query) => query.query),
		status: passages.length > 0 ? "unclear" : "missing-evidence",
		sources,
		passages,
		...(provider ? { provider } : {}),
		filters: {
			...(filters.recencyFilter ? { recency: filters.recencyFilter } : {}),
			domain_include: domainFilter.filter((domain) => !domain.startsWith("-")),
			domain_exclude: domainFilter.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1)),
		},
		...(queries.some((query) => query.error)
			? { errors: queries.filter((query) => query.error).map((query) => ({ query: query.query, error: query.error ?? "" })) }
			: {}),
		...(passages.length > 0 ? { content_hash: hashContent(passages.map((passage) => passage.text).join("\n")) } : {}),
	};
}

function formatArtifact(artifact: ResearchArtifact): string {
	const fetched = artifact.sources.filter((source) => source.fetched).length;
	const lines = [
		`Source check: ${artifact.claim}`,
		`Status: ${artifact.status}`,
		`Sources: ${artifact.sources.length} (${fetched} fetched)`,
		`Passages: ${artifact.passages.length}`,
	];
	if (artifact.errors?.length) {
		lines.push("", "Errors:", ...artifact.errors.map((error) => `- ${error.query}: ${error.error}`));
	}
	lines.push(
		"",
		`responseId: ${artifact.id}`,
		`Use get_search_content({ responseId: "${artifact.id}", offset: 0, limit: 30000 }) to page the JSON artifact.`,
	);
	return lines.join("\n");
}

export async function sourceCheck(
	params: SourceCheckParams,
	exec: CommandExec,
	signal?: AbortSignal,
): Promise<SourceCheckOutput> {
	const claim = params.claim?.trim();
	if (!claim) throw codedError("INVALID_REQUEST", "claim must be a non-empty string");
	const queries = (params.queries ?? []).map((query) => query.trim()).filter(Boolean);

	const search = await webSearch({
		queries: queries.length > 0 ? queries : [claim],
		numResults: params.numResults,
		recencyFilter: params.recencyFilter,
		domainFilter: params.domainFilter,
		provider: params.provider,
	}, exec, signal);

	const urls: string[] = [];
	const seen = new Set<string>();
	for (const query of search.queries) {
		for (const result of query.results) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			urls.push(result.url);
			if (urls.length >= 5) break;
		}
		if (urls.length >= 5) break;
	}

	const fetched = params.fetchContent === true && urls.length > 0
		? (await fetchContentPipeline({ urls }, signal)).urls
		: [];
	const artifact = buildArtifact(claim, search.queries, fetched, params);
	storeResult({ id: artifact.id, type: "research", timestamp: artifact.timestamp, artifact });
	return { responseId: artifact.id, text: formatArtifact(artifact), artifact };
}

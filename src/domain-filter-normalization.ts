export interface DomainFilters {
	allow: string[];
	deny: string[];
}

export function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

/** Split `["example.com", "-spam.com"]` into allow/deny lists, dropping invalid entries. */
export function parseDomainFilter(domainFilter: readonly string[] | undefined): DomainFilters {
	const filters: DomainFilters = { allow: [], deny: [] };
	for (const raw of domainFilter ?? []) {
		if (typeof raw !== "string") continue;
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.deny : filters.allow;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function matchesDomainFilter(url: string, filters: DomainFilters): boolean {
	if (filters.allow.length === 0 && filters.deny.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allow.length > 0 && !filters.allow.some((domain) => hostMatches(hostname, domain))) return false;
	return !filters.deny.some((domain) => hostMatches(hostname, domain));
}

/** Apply the shared include/exclude filter to a provider's already-mapped results. */
export function applyDomainFilter<T extends { url: string }>(results: readonly T[], domainFilter: readonly string[] | undefined): T[] {
	const filters = parseDomainFilter(domainFilter);
	if (filters.allow.length === 0 && filters.deny.length === 0) return [...results];
	return results.filter((result) => matchesDomainFilter(result.url, filters));
}

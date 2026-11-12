import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResult } from "./types.ts";

export const TEMP_ROOT = join(tmpdir(), "pi-web");

export type TempKind = "pdf";
export type ErrorCode =
	| "RATE_LIMIT"
	| "AUTH"
	| "INVALID_REQUEST"
	| "NETWORK"
	| "INVALID_RESPONSE"
	| "CONFIG"
	| "ABORT"
	| "UNKNOWN";

const ERROR_CODES = new Set<string>([
	"RATE_LIMIT",
	"AUTH",
	"INVALID_REQUEST",
	"NETWORK",
	"INVALID_RESPONSE",
	"CONFIG",
	"ABORT",
	"UNKNOWN",
]);

/** Deterministic, user-only temp directory under $TMPDIR/pi-web/<kind>. */
export function tempRoot(kind: TempKind): string {
	const dir = join(TEMP_ROOT, kind);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Replace known secrets in text before it reaches an error message or log. */
export function redact(text: string, ...secrets: Array<string | null | undefined>): string {
	let result = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 4) result = result.split(secret).join("[redacted]");
	}
	return result;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function codedError(code: ErrorCode, message: string): Error {
	const error = new Error(message) as Error & { code: ErrorCode };
	error.name = "WebAccessError";
	error.code = code;
	return error;
}

export function errorCode(error: unknown): ErrorCode {
	const code = typeof error === "object" && error !== null && "code" in error
		? (error as { code?: unknown }).code
		: undefined;
	return typeof code === "string" && ERROR_CODES.has(code) ? code as ErrorCode : "UNKNOWN";
}

export function normalizeResultCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs = 30_000): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function fetchError(provider: string, error: unknown, callerSignal?: AbortSignal, timeoutMs = 30_000): Error {
	if (callerSignal?.aborted) return codedError("ABORT", `${provider} request aborted`);
	const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
	const message = errorMessage(error);
	if (name === "TimeoutError" || /aborted due to timeout|timed out/i.test(message)) {
		return codedError("NETWORK", `${provider} request timed out after ${Math.round(timeoutMs / 1000)}s`);
	}
	return codedError("NETWORK", `${provider} request failed: ${message}`);
}

export function httpError(
	provider: string,
	status: number,
	body: string,
	retryAfter: string | null,
	extraRateLimitStatuses: readonly number[] = [],
): Error {
	const rateLimited = status === 429 || status === 402 || extraRateLimitStatuses.includes(status) ||
		(status === 503 && retryAfter !== null && retryAfter !== "");
	const code: ErrorCode = rateLimited
		? "RATE_LIMIT"
		: status === 401 || status === 403
			? "AUTH"
			: status === 400 || status === 404 || status === 422
				? "INVALID_REQUEST"
				: status === 408 || status === 425
					? "NETWORK"
					: "UNKNOWN";
	const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
	return codedError(code, `${provider} API error ${status}${detail ? `: ${detail}` : ""}`);
}

export function formatAnswer(results: readonly SearchResult[]): string {
	return results.map((result) => result.snippet
		? `${result.snippet}\nSource: ${result.title} (${result.url})`
		: `Source: ${result.title} (${result.url})`).join("\n\n");
}

/** Run `fn` over `items` with a fixed number of concurrent workers, preserving order. */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

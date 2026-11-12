import type TurndownService from "turndown";
import { extractPdf } from "./pdf.ts";
import { fetchRemoteUrl, type Lookup } from "./ssrf.ts";
import type { StoredUrlContent } from "./types.ts";
import { codedError, errorCode, errorMessage, requestSignal } from "./utils.ts";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MIN_USEFUL_CHARS = 500;
const JINA_READER = "https://r.jina.ai/";
const USER_AGENT = "Mozilla/5.0 (compatible; pi-web/1.0)";
const MARKDOWN_ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export interface HttpFetchOptions {
	mode?: "readable" | "raw";
	signal?: AbortSignal;
	/** Test seams only; defaults to the global fetch and system resolver. */
	fetch?: typeof fetch;
	lookup?: Lookup;
}

let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ??= import("turndown").then(({ default: TurndownService }) =>
		new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
	);
	return turndownPromise;
}

function errorContent(url: string, error: string, extra: Partial<StoredUrlContent> = {}): StoredUrlContent {
	return { url, title: "", content: "", error, ...extra };
}

function isTextContentType(contentType: string): boolean {
	const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/ld+json" ||
		mime === "application/xml" ||
		mime === "application/xhtml+xml" ||
		mime === "application/javascript" ||
		mime === "application/x-javascript" ||
		mime.endsWith("+json") ||
		mime.endsWith("+xml");
}

function isPdfUrl(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function shouldFallbackToJina(status: number): boolean {
	return status === 403 || status === 429 || status >= 500;
}

function headingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	return match ? match[1].replace(/\*+/g, "").trim() || null : null;
}

function titleFromText(text: string, url: string): string {
	const heading = headingTitle(text);
	if (heading) return heading;
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
	} catch {
		return url;
	}
}

function decodeText(bytes: Uint8Array, contentType: string): string {
	const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

async function readLimitedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	const limitMessage = `Response too large (over ${Math.round(maxBytes / 1024 / 1024)} MB)`;
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) throw codedError("INVALID_RESPONSE", limitMessage);

	const reader = response.body?.getReader();
	if (!reader) {
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > maxBytes) throw codedError("INVALID_RESPONSE", limitMessage);
		return buffer;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw codedError("INVALID_RESPONSE", limitMessage);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function extractWithDefuddle(html: string, url: string): Promise<{ title: string; content: string }> {
	const { Defuddle } = await import("defuddle/node");
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	Object.defineProperty(document, "location", { value: new URL(url), configurable: true });
	const result = await Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false });
	return {
		title: typeof result.title === "string" ? result.title : "",
		content: typeof result.content === "string" ? result.content.trim() : "",
	};
}

async function extractReadable(html: string, url: string): Promise<{ title: string; content: string }> {
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	const documentTitle = document.title?.trim() ?? "";

	try {
		const { Readability } = await import("@mozilla/readability");
		const article = new Readability(document as unknown as Document).parse();
		if (article && typeof article.content === "string") {
			const markdown = (await getTurndown()).turndown(article.content);
			if (markdown.trim().length >= MIN_USEFUL_CHARS) {
				return { title: article.title || documentTitle, content: markdown };
			}
		}
	} catch {
		// Defuddle and Jina are the fallbacks.
	}

	try {
		const defuddle = await extractWithDefuddle(html, url);
		if (defuddle.content.length >= MIN_USEFUL_CHARS) {
			return { title: documentTitle || defuddle.title, content: defuddle.content };
		}
	} catch {
		// Jina is the last fallback.
	}

	return { title: documentTitle, content: "" };
}

async function fetchViaJina(
	target: string,
	originalUrl: string,
	reason: string,
	options: HttpFetchOptions,
): Promise<StoredUrlContent> {
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(`${JINA_READER}${target}`, {
			headers: {
				Accept: "text/markdown",
				"X-No-Cache": "true",
				"User-Agent": USER_AGENT,
			},
			signal: requestSignal(options.signal, FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (options.signal?.aborted) throw codedError("ABORT", "Fetch aborted");
		return errorContent(originalUrl, `${reason}\nJina Reader failed: ${errorMessage(err)}`);
	}

	if (!response.ok) {
		return errorContent(originalUrl, `${reason}\nJina Reader failed: HTTP ${response.status}`);
	}

	let text: string;
	try {
		const bytes = await readLimitedBytes(response, MAX_TEXT_BYTES);
		text = decodeText(bytes, response.headers.get("content-type") ?? "");
	} catch (err) {
		if (options.signal?.aborted) throw codedError("ABORT", "Fetch aborted");
		return errorContent(originalUrl, `${reason}\nJina Reader failed: ${errorMessage(err)}`);
	}

	const marker = "Markdown Content:";
	const index = text.indexOf(marker);
	const content = (index >= 0 ? text.slice(index + marker.length) : text).trim();
	if (content.length < 100) {
		return errorContent(originalUrl, `${reason}\nJina Reader returned no usable content`);
	}

	return {
		url: originalUrl,
		title: headingTitle(content) ?? titleFromText(content, originalUrl),
		content,
		error: null,
		mimeType: "text/markdown",
		status: response.status,
	};
}

export async function fetchHttp(url: string, options: HttpFetchOptions = {}): Promise<StoredUrlContent> {
	const mode = options.mode ?? "readable";
	let response: Response;
	try {
		response = await fetchRemoteUrl(url, {
			headers: {
				Accept: mode === "raw" ? BROWSER_ACCEPT : MARKDOWN_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"User-Agent": USER_AGENT,
			},
			signal: requestSignal(options.signal, FETCH_TIMEOUT_MS),
		}, { fetch: options.fetch, lookup: options.lookup });
	} catch (err) {
		if (options.signal?.aborted) throw codedError("ABORT", "Fetch aborted");
		return errorContent(url, errorMessage(err));
	}

	const status = response.status;
	const contentType = response.headers.get("content-type") ?? "";
	const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const finalUrl = response.url || url;

	if (!response.ok) {
		const reason = `HTTP ${status}${response.statusText ? `: ${response.statusText}` : ""}`;
		if (mode === "readable" && shouldFallbackToJina(status)) {
			return fetchViaJina(finalUrl, url, reason, options);
		}
		return errorContent(url, reason, { status, ...(mime ? { mimeType: mime } : {}) });
	}

	const pdf = mime === "application/pdf" || isPdfUrl(finalUrl);
	if (pdf) {
		if (mode === "raw") {
			return errorContent(url, `Unsupported content type in raw mode: ${mime || "application/pdf"}`, { status, mimeType: mime });
		}
		let bytes: Uint8Array;
		try {
			bytes = await readLimitedBytes(response, MAX_PDF_BYTES);
		} catch (err) {
			if (options.signal?.aborted) throw codedError("ABORT", "Fetch aborted");
			if (errorCode(err) === "ABORT") throw err;
			return errorContent(url, errorMessage(err), { status, mimeType: mime });
		}
		try {
			const extracted = await extractPdf(toArrayBuffer(bytes), finalUrl, options.signal);
			return {
				url,
				title: extracted.title,
				content: extracted.markdown,
				error: null,
				mimeType: "text/markdown",
				status,
				pdfPath: extracted.pdfPath,
				markdownPath: extracted.markdownPath,
			};
		} catch (err) {
			if (errorCode(err) === "ABORT") throw err;
			return errorContent(url, errorMessage(err), { status, mimeType: mime });
		}
	}

	if (!isTextContentType(contentType)) {
		const label = mode === "raw" ? " in raw mode" : "";
		return errorContent(url, `Unsupported content type${label}: ${mime || "missing"}`, { status, ...(mime ? { mimeType: mime } : {}) });
	}

	let bytes: Uint8Array;
	try {
		bytes = await readLimitedBytes(response, MAX_TEXT_BYTES);
	} catch (err) {
		if (options.signal?.aborted) throw codedError("ABORT", "Fetch aborted");
		if (errorCode(err) === "ABORT") throw err;
		return errorContent(url, errorMessage(err), { status, mimeType: mime });
	}
	const text = decodeText(bytes, contentType);

	const html = mime === "text/html" || mime === "application/xhtml+xml";
	if (mode === "raw" || !html) {
		return {
			url,
			title: titleFromText(text, finalUrl),
			content: text,
			error: null,
			mimeType: mime,
			status,
		};
	}

	let readable = { title: "", content: "" };
	try {
		readable = await extractReadable(text, finalUrl);
	} catch {
		// Jina is the fallback for unparseable HTML.
	}
	if (readable.content.length >= MIN_USEFUL_CHARS) {
		return {
			url,
			title: readable.title || titleFromText(text, finalUrl),
			content: readable.content,
			error: null,
			mimeType: mime,
			status,
		};
	}

	return fetchViaJina(
		finalUrl,
		url,
		`Extracted content was shorter than ${MIN_USEFUL_CHARS} characters`,
		options,
	);
}

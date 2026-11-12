import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codedError, errorMessage, tempRoot } from "./utils.ts";

const MAX_PAGES = 100;

export interface PdfExtractResult {
	title: string;
	markdown: string;
	pdfPath: string;
	markdownPath: string;
	pages: number;
}

function fileNameFromUrl(url: string): string {
	try {
		const raw = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "document";
		const name = decodeURIComponent(raw)
			.replace(/\.pdf$/i, "")
			.replace(/[^A-Za-z0-9._-]/g, "-")
			.replace(/^-+|-+$/g, "");
		return name || "document";
	} catch {
		return "document";
	}
}

function titleFromUrl(url: string): string {
	return fileNameFromUrl(url).replace(/[_-]+/g, " ").trim() || "document";
}

export async function extractPdf(buffer: ArrayBuffer, url: string, signal?: AbortSignal): Promise<PdfExtractResult> {
	if (signal?.aborted) throw codedError("ABORT", "PDF extraction aborted");

	const bytes = new Uint8Array(buffer);
	const input = bytes.slice();
	const unpdf = await import("unpdf");
	// Pi may load extensions through a non-Node resolver. Resolve the bundled PDF.js
	// build from this module instead of letting unpdf resolve its own package self-reference.
	const pdfjs = await import("unpdf/pdfjs");
	await unpdf.definePDFJSModule(async () => pdfjs);
	const pdf = await unpdf.getDocumentProxy(input);
	try {
		const totalPages = pdf.numPages;
		const pagesToExtract = Math.min(totalPages, MAX_PAGES);
		const pages: Array<{ pageNum: number; text: string }> = [];

		for (let pageNum = 1; pageNum <= pagesToExtract; pageNum++) {
			if (signal?.aborted) throw codedError("ABORT", "PDF extraction aborted");
			const page = await pdf.getPage(pageNum);
			const textContent = await page.getTextContent();
			const text = textContent.items
				.map((item) => (item as { str?: string }).str ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (text) pages.push({ pageNum, text });
		}

		if (pages.length === 0) {
			throw codedError("INVALID_RESPONSE", "PDF contains no extractable text");
		}

		const title = titleFromUrl(url);
		const truncated = totalPages > MAX_PAGES;
		const lines = [
			`# ${title}`,
			"",
			`> Source: ${url}`,
			`> Pages: ${totalPages}${truncated ? ` (extracted first ${MAX_PAGES})` : ""}`,
			"",
			"---",
			"",
		];
		for (let index = 0; index < pages.length; index++) {
			if (index > 0) lines.push("", `<!-- Page ${pages[index].pageNum} -->`, "");
			lines.push(pages[index].text);
		}
		if (truncated) {
			lines.push("", "---", "", `*[Truncated: only the first ${MAX_PAGES} of ${totalPages} pages extracted]*`);
		}
		const markdown = lines.join("\n");

		if (signal?.aborted) throw codedError("ABORT", "PDF extraction aborted");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const name = fileNameFromUrl(url);
		const dir = tempRoot("pdf");
		const pdfPath = join(dir, `${hash}-${name}.pdf`);
		const markdownPath = join(dir, `${hash}-${name}.md`);
		await writeFile(pdfPath, bytes, { mode: 0o600 });
		await writeFile(markdownPath, markdown, { mode: 0o600, encoding: "utf-8" });

		return { title, markdown, pdfPath, markdownPath, pages: totalPages };
	} catch (err) {
		if (err instanceof Error && "code" in err) throw err;
		throw codedError("INVALID_RESPONSE", `PDF extraction failed: ${errorMessage(err)}`);
	} finally {
		await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
	}
}

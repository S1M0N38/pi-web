import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piWebAccessMin from "../index.ts";
import { getApiKey, loadConfig, resolveCredential } from "../src/config.ts";
import { runFetchContent, runGetSearchContent, runSourceCheck, runWebSearch } from "../src/core.ts";
import { fetchContent } from "../src/fetch.ts";
import { handoffFor } from "../src/handoff.ts";
import { fetchHttp } from "../src/http.ts";
import { getResult } from "../src/storage.ts";
import { fetchRemoteUrl, validateRemoteUrl } from "../src/ssrf.ts";
import { resetSearchCooldown, webSearch } from "../src/search.ts";
import type { CommandExec } from "../src/types.ts";

const realFetch = globalThis.fetch;
const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-test-"));
const configPath = join(tempRoot, "web.json");
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const MINIMAL_PDF = Buffer.from(
	"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0MCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMzMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=",
	"base64",
);

process.env.PI_CODING_AGENT_DIR = tempRoot;

function writeConfig(value: unknown): void {
	writeFileSync(configPath, JSON.stringify(value));
	chmodSync(configPath, 0o600);
}

function fakeExec(): CommandExec {
	return (async () => ({ stdout: "from-command\n", stderr: "", code: 0, killed: false, truncated: false })) as CommandExec;
}

function stubFetch(handler: (url: URL, init?: RequestInit) => Response): URL[] {
	const calls: URL[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		calls.push(url);
		return handler(url, init);
	}) as typeof fetch;
	return calls;
}

beforeEach(() => {
	resetSearchCooldown();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(configPath, { force: true });
});

describe("foundation", () => {
	test("config reports missing, unknown, and invalid keys together", () => {
		writeConfig({ providers: ["brave"], extra: true, answerModel: "" });
		assert.throws(
			() => loadConfig(),
			(error: Error) => error.message.includes('unknown key "extra"') &&
				error.message.includes('"braveApiKey"') &&
				error.message.includes('"answerModel"'),
		);
	});

	test("credentials support env, escapes, literal, and cached commands", async () => {
		process.env.BRAVE_TEST_KEY = "brave-env";
		writeConfig({
			providers: ["brave", "tavily", "exa"],
			braveApiKey: "$BRAVE_TEST_KEY",
			tavilyApiKey: "$$literal-$!bang",
			exaApiKey: "!printf from-command",
			answerModel: "provider/model",
		});

		let commands = 0;
		const exec = (async () => {
			commands++;
			return { stdout: "from-command\n", stderr: "", code: 0, killed: false, truncated: false };
		}) as CommandExec;

		assert.equal(await getApiKey("brave", exec), "brave-env");
		assert.equal(await getApiKey("tavily", exec), "$literal-!bang");
		assert.equal(await getApiKey("exa", exec), "from-command");
		assert.equal(await getApiKey("exa", exec), "from-command");
		assert.equal(commands, 1);
		assert.equal(await resolveCredential("$!literal", fakeExec()), "!literal");
		delete process.env.BRAVE_TEST_KEY;
	});

	test("SSRF blocks private targets and redirect pivots", async () => {
		await assert.rejects(validateRemoteUrl("http://127.0.0.1/"));
		await assert.rejects(validateRemoteUrl("http://[::ffff:127.0.0.1]/"));

		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } });
		}) as typeof fetch;

		await assert.rejects(fetchRemoteUrl("http://public.example/", {}, {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			fetch: fetchImpl,
		}));
		assert.equal(calls, 1);
	});
});

describe("search chain", () => {
	test("falls through only on rate limits and stores results", async () => {
		writeConfig({
			providers: ["brave", "tavily"],
			braveApiKey: "brave-key",
			tavilyApiKey: "tavily-key",
			answerModel: "provider/model",
		});
		const calls = stubFetch((url) => {
			if (url.hostname === "api.search.brave.com") return new Response("quota", { status: 429 });
			return new Response(JSON.stringify({
				answer: "Tavily answer",
				results: [{ title: "T", url: "https://example.com/a", content: "snippet" }],
			}), { status: 200 });
		});

		const output = await webSearch({ query: "hello" }, fakeExec());
		assert.equal(output.queries[0].provider, "tavily");
		assert.equal(output.queries[0].answer, "Tavily answer");
		assert.deepEqual(output.queries[0].results, [{ title: "T", url: "https://example.com/a", snippet: "snippet" }]);
		assert.equal(getResult(output.responseId)?.queries?.[0].provider, "tavily");
		assert.deepEqual(calls.map((url) => url.hostname), ["api.search.brave.com", "api.tavily.com"]);

		await webSearch({ query: "again" }, fakeExec());
		assert.deepEqual(calls.map((url) => url.hostname), [
			"api.search.brave.com",
			"api.tavily.com",
			"api.tavily.com",
		]);
	});

	test("a non-rate-limit error stops the chain", async () => {
		writeConfig({
			providers: ["brave", "tavily"],
			braveApiKey: "brave-key",
			tavilyApiKey: "tavily-key",
			answerModel: "provider/model",
		});
		const calls = stubFetch((url) => url.hostname === "api.search.brave.com"
			? new Response("bad key", { status: 401 })
			: new Response(JSON.stringify({ answer: "", results: [] }), { status: 200 }));

		const output = await webSearch({ query: "hello" }, fakeExec());
		assert.equal(output.queries[0].provider, "brave");
		assert.match(output.queries[0].error ?? "", /Brave API error 401/);
		assert.equal(calls.length, 1);
	});

	test("an explicit provider must be configured", async () => {
		writeConfig({ providers: ["duckduckgo"], answerModel: "provider/model" });
		const calls = stubFetch(() => new Response("unexpected", { status: 500 }));

		const output = await webSearch({ query: "hello", provider: "brave" }, fakeExec());
		assert.match(output.queries[0].error ?? "", /not listed in providers/);
		assert.equal(calls.length, 0);
	});

	test("a DuckDuckGo bot check is a rate limit with no fallback", async () => {
		writeConfig({ providers: ["duckduckgo"], answerModel: "provider/model" });
		stubFetch(() => new Response("challenge", { status: 202 }));

		const output = await webSearch({ query: "hello" }, fakeExec());
		assert.equal(output.queries[0].provider, null);
		assert.match(output.queries[0].error ?? "", /DuckDuckGo: DuckDuckGo returned a bot check/);
	});

	test("Brave, Exa, and DuckDuckGo map successful responses", async () => {
		writeConfig({
			providers: ["brave", "exa", "duckduckgo"],
			braveApiKey: "brave-key",
			exaApiKey: "exa-key",
			answerModel: "provider/model",
		});
		stubFetch((url) => {
			if (url.hostname === "api.search.brave.com") {
				return new Response(JSON.stringify({
					web: { results: [{ title: "<b>Brave</b>", url: "https://brave.example/a", description: "brave &amp; snippet" }] },
				}), { status: 200 });
			}
			if (url.hostname === "api.exa.ai") {
				return new Response(JSON.stringify({
					results: [{ title: "Exa", url: "https://exa.example/a", highlights: ["exa highlight"] }],
				}), { status: 200 });
			}
			return new Response(
				'<div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example%2Fa">Duck title</a><div class="result__snippet">duck snippet</div></div>',
				{ status: 200 },
			);
		});

		const brave = await webSearch({ query: "q", provider: "brave" }, fakeExec());
		assert.deepEqual(brave.queries[0].results, [
			{ title: "Brave", url: "https://brave.example/a", snippet: "brave & snippet" },
		]);

		const exa = await webSearch({ query: "q", provider: "exa" }, fakeExec());
		assert.deepEqual(exa.queries[0].results, [
			{ title: "Exa", url: "https://exa.example/a", snippet: "exa highlight" },
		]);

		const ddg = await webSearch({ query: "q", provider: "duckduckgo" }, fakeExec());
		assert.deepEqual(ddg.queries[0].results, [
			{ title: "Duck title", url: "https://ddg.example/a", snippet: "duck snippet" },
		]);
	});
});

describe("fetch", () => {
	test("extracts readable HTML to Markdown", async () => {
		const article = `<html><head><title>Test Article</title></head><body><article><h1>Test Article</h1><p>${"Readable paragraph text. ".repeat(40)}</p></article></body></html>`;
		stubFetch(() => new Response(article, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));

		const result = await fetchHttp("https://example.com/article", { lookup: publicLookup });
		assert.equal(result.error, null);
		assert.equal(result.title, "Test Article");
		assert.match(result.content, /Readable paragraph text/);
	});

	test("returns raw text unchanged", async () => {
		stubFetch(() => new Response("plain text body", { status: 200, headers: { "content-type": "text/plain" } }));

		const result = await fetchHttp("https://example.com/raw.txt", { mode: "raw", lookup: publicLookup });
		assert.equal(result.error, null);
		assert.equal(result.content, "plain text body");
	});

	test("falls back to Jina when extraction is short", async () => {
		const calls = stubFetch((url) => {
			if (url.hostname === "r.jina.ai") {
				return new Response(`Title: Jina\n\nMarkdown Content:\n# Jina Title\n\n${"Jina fallback content. ".repeat(20)}`, {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			return new Response("<html><body><p>too short</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});

		const result = await fetchHttp("https://example.com/short", { lookup: publicLookup });
		assert.equal(result.error, null);
		assert.equal(result.title, "Jina Title");
		assert.match(result.content, /Jina fallback content/);
		assert.deepEqual(calls.map((url) => url.hostname), ["example.com", "r.jina.ai"]);
	});

	test("extracts PDF text and writes both temp files", async () => {
		stubFetch(() => new Response(MINIMAL_PDF, { status: 200, headers: { "content-type": "application/pdf" } }));

		const result = await fetchHttp("https://example.com/paper.pdf", { lookup: publicLookup });
		assert.equal(result.error, null);
		assert.match(result.content, /Hello PDF/);
		assert.ok(result.pdfPath && result.markdownPath);
		assert.ok(existsSync(result.pdfPath));
		assert.match(readFileSync(result.markdownPath, "utf-8"), /Hello PDF/);
		rmSync(result.pdfPath, { force: true });
		rmSync(result.markdownPath, { force: true });
	});

	test("fetchContent routes HTTP URLs and stores the response", async () => {
		stubFetch(() => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));

		const output = await fetchContent({ url: "https://example.com/data.json" }, undefined, { lookup: publicLookup });
		assert.equal(output.urls[0].error, null);
		assert.equal(output.urls[0].content, '{"ok":true}');
		assert.equal(getResult(output.responseId)?.urls?.[0].content, '{"ok":true}');
	});

	test("hands gist, YouTube, and local files off to native tools", async () => {
		const output = await fetchContent({
			urls: ["https://gist.github.com/user/123", "https://www.youtube.com/watch?v=abc", "/tmp/video.mp4"],
		});
		assert.equal(output.urls[0].handoff, "gist");
		assert.equal(output.urls[1].handoff, "youtube");
		assert.match(output.urls[0].error ?? "", /Gists are handled by gh\/curl/);
		assert.match(output.urls[1].error ?? "", /yt-dlp/);
		assert.match(output.urls[1].error ?? "", /\$TMPDIR/);
		assert.match(output.urls[2].error ?? "", /Local files are not supported/);
		const withCredentials = await fetchContent({ url: "https://user:pass@reddit.com/r/x" });
		assert.match(withCredentials.urls[0].error ?? "", /credentials/);
	});

	test("hands GitHub off to gh/git", async () => {
		const output = await fetchContent({
			urls: ["https://github.com/owner/repo", "https://github.com/owner/repo/pull/1"],
		});
		for (const result of output.urls) {
			assert.equal(result.handoff, "github");
			assert.match(result.error ?? "", /HANDOFF → gh\/git/);
			assert.match(result.error ?? "", /gh repo clone owner\/repo/);
			assert.match(result.error ?? "", /\$TMPDIR/);
			assert.match(result.error ?? "", /gh\/git/);
		}
	});

	test("hands OpenCLI sites off with site-specific help", async () => {
		const cases: Array<[string, string]> = [
			["https://x.com/user/status/1", "twitter"],
			["https://twitter.com/user/status/1", "twitter"],
			["https://old.reddit.com/r/x", "reddit"],
			["https://redd.it/abc", "reddit"],
			["https://www.linkedin.com/in/x", "linkedin"],
			["https://m.facebook.com/x", "facebook"],
			["https://www.instagram.com/p/x", "instagram"],
			["https://www.tiktok.com/@x/video/1", "tiktok"],
			["https://www.bilibili.com/video/BV1", "bilibili"],
			["https://www.zhihu.com/question/1", "zhihu"],
			["https://www.xiaohongshu.com/explore/1", "xiaohongshu"],
			["https://www.rednote.com/explore/1", "rednote"],
			["https://weibo.com/1", "weibo"],
			["https://www.douyin.com/video/1", "douyin"],
			["https://movie.douban.com/subject/1", "douban"],
			["https://www.pixiv.net/artworks/1", "pixiv"],
			["https://www.pinterest.com/pin/1", "pinterest"],
			["https://www.amazon.co.uk/dp/1", "amazon"],
			["https://item.taobao.com/item.htm?id=1", "taobao"],
			["https://item.jd.com/1.html", "jd"],
			["https://detail.1688.com/offer/1.html", "1688"],
			["https://www.coupang.com/vp/products/1", "coupang"],
			["https://www.goofish.com/item?id=1", "xianyu"],
			["https://www.zhipin.com/job_detail/1.html", "boss"],
			["https://jobs.51job.com/1.html", "51job"],
			["https://www.upwork.com/jobs/1", "upwork"],
			["https://www.indeed.com/viewjob?jk=1", "indeed"],
			["https://hotels.ctrip.com/hotel/1.html", "ctrip"],
			["https://www.trip.com/hotels/1", "trip"],
			["https://www.booking.com/hotel/1.html", "booking"],
			["https://www.bloomberg.com/news/articles/1", "bloomberg"],
			["https://www.reuters.com/world/1", "reuters"],
			["https://medium.com/@x/y", "medium"],
			["https://scholar.google.com/citations?user=1", "google-scholar"],
		];
		const output = await fetchContent({ urls: cases.map(([url]) => url) });
		for (let index = 0; index < cases.length; index++) {
			const [url, site] = cases[index];
			const error = output.urls[index].error ?? "";
			assert.ok(error.includes(`OpenCLI handles ${site} pages`), url);
			assert.ok(error.includes(`opencli list --site ${site}`), url);
			assert.ok(error.includes(`opencli ${site} --help`), url);
			assert.ok(error.includes("opencli web read --url"), url);
			assert.ok(error.includes("$TMPDIR"), url);
			assert.ok(!error.includes("-f json"), url);
		}
		assert.equal(handoffFor(new URL("https://example.com")), null);
	});
});

describe("tools", () => {
	test("registers exactly four tools", () => {
		writeConfig({ providers: ["duckduckgo"], answerModel: "provider/model" });
		const names: string[] = [];
		const api = {
			registerTool(tool: { name: string }) {
				names.push(tool.name);
			},
		} as unknown as ExtensionAPI;
		piWebAccessMin(api);
		assert.deepEqual(names.sort(), ["fetch_content", "get_search_content", "source_check", "web_search"]);
	});

	test("handoffs are successful routing results, not tool errors", async () => {
		const handoff = await runFetchContent({ url: "https://github.com/sindresorhus/p-limit" }, { exec: fakeExec() });
		assert.equal(handoff.isError, false);
		assert.match(handoff.text, /^HANDOFF → gh\/git/);
		assert.equal(handoff.urls[0].handoff, "github");

		const blocked = await runFetchContent({ url: "http://127.0.0.1/" }, { exec: fakeExec() });
		assert.equal(blocked.isError, true);
		assert.match(blocked.text, /^ERROR: http:\/\/127\.0\.0\.1\//);
	});

	test("pages search results and source-check artifacts", async () => {
		writeConfig({ providers: ["tavily"], tavilyApiKey: "tavily-key", answerModel: "provider/model" });
		stubFetch(() => new Response(JSON.stringify({
			answer: "Tavily answer",
			results: [{ title: "Docs", url: "https://example.com/docs", content: "snippet support text" }],
		}), { status: 200 }));

		const search = await runWebSearch({ query: "hello", provider: "tavily" }, { exec: fakeExec() });
		const first = await runGetSearchContent({ responseId: search.responseId, queryIndex: 0, offset: 0, limit: 20 });
		assert.equal(first.details.type, "search");
		assert.ok(first.details.nextOffset !== null);
		const rest = await runGetSearchContent({
			responseId: search.responseId,
			queryIndex: 0,
			offset: first.details.nextOffset ?? 0,
			limit: 30000,
		});
		assert.equal(rest.details.nextOffset, null);

		const check = await runSourceCheck({ claim: "snippet", queries: ["hello"], fetchContent: false }, { exec: fakeExec() });
		assert.equal(check.artifact.status, "unclear");
		assert.ok(check.artifact.passages.length > 0);
		assert.equal(check.artifact.sources[0].quality, "official_docs");
		const artifact = await runGetSearchContent({ responseId: check.responseId, offset: 0, limit: 30000 });
		assert.equal((JSON.parse(artifact.text) as { claim: string }).claim, "snippet");
	});
});

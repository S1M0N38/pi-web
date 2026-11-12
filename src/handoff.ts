export interface Handoff {
	kind: "github" | "gist" | "youtube" | "opencli";
	message: string;
}

interface OpenCliRule {
	match: RegExp;
	site: string;
	commands: readonly string[];
}

/** Hardcoded host table. Order matters: GitHub/Gist/YouTube are checked before OpenCLI. */
export const OPENCLI_RULES: readonly OpenCliRule[] = [
	{ match: /(?:^|\.)(?:x\.com|twitter\.com)$/i, site: "twitter", commands: ["thread", "search"] },
	{ match: /(?:^|\.)(?:reddit\.com|redd\.it)$/i, site: "reddit", commands: ["read", "search"] },
	{ match: /(?:^|\.)linkedin\.com$/i, site: "linkedin", commands: ["profile-read", "job-detail"] },
	{ match: /(?:^|\.)facebook\.com$/i, site: "facebook", commands: ["profile", "search"] },
	{ match: /(?:^|\.)instagram\.com$/i, site: "instagram", commands: ["profile", "search"] },
	{ match: /(?:^|\.)tiktok\.com$/i, site: "tiktok", commands: ["profile", "search"] },
	{ match: /(?:^|\.)bilibili\.com$/i, site: "bilibili", commands: ["video", "search"] },
	{ match: /(?:^|\.)zhihu\.com$/i, site: "zhihu", commands: ["answer-detail", "search"] },
	{ match: /(?:^|\.)xiaohongshu\.com$/i, site: "xiaohongshu", commands: ["note", "search"] },
	{ match: /(?:^|\.)rednote\.com$/i, site: "rednote", commands: ["note", "search"] },
	{ match: /(?:^|\.)weibo\.com$/i, site: "weibo", commands: ["post", "search"] },
	{ match: /(?:^|\.)douyin\.com$/i, site: "douyin", commands: ["detail", "search"] },
	{ match: /(?:^|\.)douban\.com$/i, site: "douban", commands: ["subject", "search"] },
	{ match: /(?:^|\.)pixiv\.net$/i, site: "pixiv", commands: ["detail", "search"] },
	{ match: /(?:^|\.)pinterest\.com$/i, site: "pinterest", commands: ["pin", "search-pins"] },
	{ match: /(?:^|\.)amazon\.[a-z.]+$/i, site: "amazon", commands: ["product", "search"] },
	{ match: /(?:^|\.)taobao\.com$/i, site: "taobao", commands: ["detail", "search"] },
	{ match: /(?:^|\.)jd\.com$/i, site: "jd", commands: ["item", "search"] },
	{ match: /(?:^|\.)1688\.com$/i, site: "1688", commands: ["item", "search"] },
	{ match: /(?:^|\.)coupang\.com$/i, site: "coupang", commands: ["product", "search"] },
	{ match: /(?:^|\.)goofish\.com$/i, site: "xianyu", commands: ["item", "search"] },
	{ match: /(?:^|\.)zhipin\.com$/i, site: "boss", commands: ["detail", "search"] },
	{ match: /(?:^|\.)51job\.com$/i, site: "51job", commands: ["detail", "search"] },
	{ match: /(?:^|\.)upwork\.com$/i, site: "upwork", commands: ["detail", "search"] },
	{ match: /(?:^|\.)indeed\.com$/i, site: "indeed", commands: ["job", "search"] },
	{ match: /(?:^|\.)ctrip\.com$/i, site: "ctrip", commands: ["hotel", "search"] },
	{ match: /(?:^|\.)trip\.com$/i, site: "trip", commands: ["hotel", "search"] },
	{ match: /(?:^|\.)booking\.com$/i, site: "booking", commands: ["search"] },
	{ match: /(?:^|\.)bloomberg\.com$/i, site: "bloomberg", commands: ["news"] },
	{ match: /(?:^|\.)reuters\.com$/i, site: "reuters", commands: ["article-detail", "search"] },
	{ match: /(?:^|\.)medium\.com$/i, site: "medium", commands: ["search"] },
	{ match: /(?:^|\.)scholar\.google\.com$/i, site: "google-scholar", commands: ["search"] },
];

function openCliMessage(url: URL, rule: OpenCliRule): string {
	const commandHelp = rule.commands
		.map((command) => `opencli ${rule.site} ${command} --help`)
		.join("; ");
	return [
		`HANDOFF → opencli`, 
		`OpenCLI handles ${rule.site} pages; plain HTTP is usually blocked.`,
		`Read this URL: opencli web read --url "${url.toString()}" --stdout true --download-images false`,
		`Discover commands: opencli list --site ${rule.site}`,
		`Site help: opencli ${rule.site} --help`,
		`Command help: ${commandHelp}`,
		"Write any files under $TMPDIR.",
	].join("\n");
}

function githubMessage(url: URL): string {
	const parts = url.pathname.split("/").filter(Boolean);
	const owner = parts[0];
	const repo = parts[1]?.replace(/\.git$/i, "");
	const clone = owner && repo
		? `gh repo clone ${owner}/${repo} "$TMPDIR/pi-web/github/${owner}-${repo}"`
		: `gh repo clone <owner>/<repo> "$TMPDIR/pi-web/github/<owner>-<repo>"`;
	return `HANDOFF → gh/git\nGitHub is handled by gh/git. Clone once: ${clone}. Use gh/git for PRs, issues, trees, blobs, commits, and releases; write outputs under $TMPDIR.`;
}

function gistMessage(): string {
	return "HANDOFF → gh/curl\nGists are handled by gh/curl. Use gh gist view <id> or curl, and write any outputs under $TMPDIR.";
}

function youtubeMessage(url: URL): string {
	return `HANDOFF → yt-dlp\nYouTube is handled by yt-dlp. Use yt-dlp directly for ${url.toString()} and write outputs under $TMPDIR/pi-web/youtube/<videoId>/.`;
}

function isYoutubeHost(host: string): boolean {
	return host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" ||
		host === "music.youtube.com" || host === "youtu.be" || host === "www.youtu.be" ||
		host === "youtube-nocookie.com" || host === "www.youtube-nocookie.com";
}

/** Return a native-tool handoff for this URL, or null when the normal HTTP pipeline should run. */
export function handoffFor(url: URL): Handoff | null {
	const host = url.hostname.toLowerCase().replace(/\.$/, "");

	if (host === "gist.github.com" || host === "gist.githubusercontent.com") {
		return { kind: "gist", message: gistMessage() };
	}
	if (host === "github.com" || host === "www.github.com") {
		return { kind: "github", message: githubMessage(url) };
	}
	if (isYoutubeHost(host)) {
		return { kind: "youtube", message: youtubeMessage(url) };
	}
	for (const rule of OPENCLI_RULES) {
		if (rule.match.test(host)) return { kind: "opencli", message: openCliMessage(url, rule) };
	}
	return null;
}

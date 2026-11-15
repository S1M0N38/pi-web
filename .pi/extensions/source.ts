/**
 * `/source` — show or switch where this checkout is installed from: the published
 * (git) package or the local working copy.
 *
 *   /source            show where this checkout is installed from
 *   /source github    install git:<remote>, remove the local entry
 *   /source local     install this checkout's path, remove the git entry
 *
 * Project extension: it only loads in this repository.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const USAGE = "usage: /source local|github";
const INSTALL_TIMEOUT_MS = 120_000;
const REMOVE_TIMEOUT_MS = 30_000;
const SOURCE_PREFIX = /^(?:git:|npm:|https?:|builtin:)/;

type Mode = "local" | "github";

interface ExecOutput {
	stdout: string;
	stderr: string;
	code: number;
}

type Exec = (command: string, args: string[], timeout: number) => Promise<ExecOutput>;

interface State {
	repoRoot: string;
	gitSource: string;
	local: boolean;
	github: boolean;
	/** Stored declaration strings, for reporting and removal. */
	localEntry?: string;
	githubEntry?: string;
	hasNodeModules: boolean;
	hasDeps: boolean;
}

function piBinary(): string {
	return basename(process.execPath) === "pi" ? process.execPath : "pi";
}

async function run(exec: Exec, command: string, args: string[], timeout: number): Promise<string | undefined> {
	const result = await exec(command, args, timeout);
	const text = result.stdout.trim();
	return result.code === 0 && text ? text : undefined;
}

/** `git@github.com:owner/repo.git` or `https://host/owner/repo.git` -> `host/owner/repo`. */
function remotePath(url: string): string {
	const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
	const scp = cleaned.match(/^[^@/]+@([^:/]+):(.+)$/);
	if (scp) return `${scp[1]}/${scp[2]}`;
	try {
		const parsed = new URL(cleaned);
		if (parsed.host && parsed.pathname !== "/") return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
	} catch {
		// not a URL: fall through
	}
	return cleaned;
}

function readPackages(settingsPath: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
		if (!Array.isArray(parsed.packages)) return [];
		return parsed.packages.flatMap((entry) => {
			if (typeof entry === "string") return [entry];
			const source = (entry as { source?: unknown } | null)?.source;
			return typeof source === "string" ? [source] : [];
		});
	} catch {
		return [];
	}
}

/** A local declaration is stored relative to the settings file, so resolve it against the agent dir. */
function resolveEntry(entry: string, settingsDir: string): string {
	if (entry === "~") return homedir();
	if (entry.startsWith("~/")) return join(homedir(), entry.slice(2));
	return resolve(settingsDir, entry);
}

function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function hasDeclaredDeps(repoRoot: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
			dependencies?: Record<string, unknown>;
		};
		return Object.keys(parsed.dependencies ?? {}).length > 0;
	} catch {
		return false;
	}
}

async function resolveState(exec: Exec, cwd: string): Promise<State> {
	const repoRoot = (await run(exec, "git", ["rev-parse", "--show-toplevel"], 5_000)) ?? cwd;
	const remote = await run(exec, "git", ["remote", "get-url", "origin"], 5_000);
	const gitSource = remote ? `git:${remotePath(remote)}` : "";
	const settingsDir = getAgentDir();
	const entries = readPackages(join(settingsDir, "settings.json"));
	const root = realPath(repoRoot);

	const localEntry = entries.find((entry) => !SOURCE_PREFIX.test(entry) && realPath(resolveEntry(entry, settingsDir)) === root);
	const githubEntry = gitSource
		? entries.find((entry) => entry === gitSource || entry.startsWith(`${gitSource}@`))
		: undefined;

	return {
		repoRoot,
		gitSource,
		local: localEntry !== undefined,
		github: githubEntry !== undefined,
		...(localEntry !== undefined ? { localEntry } : {}),
		...(githubEntry !== undefined ? { githubEntry } : {}),
		hasNodeModules: existsSync(join(repoRoot, "node_modules")),
		hasDeps: hasDeclaredDeps(repoRoot),
	};
}

function describe(state: State): string {
	if (state.local && state.github) return `installed from local and ${state.gitSource} — ${USAGE}`;
	if (state.local) return `installed from local (${state.localEntry}) — /source github to switch`;
	if (state.github) return `installed from ${state.gitSource} — /source local to switch`;
	return `not installed — ${USAGE}`;
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? "(no output)";
}

async function switchTo(mode: Mode, exec: Exec, ctx: ExtensionCommandContext): Promise<void> {
	const state = await resolveState(exec, ctx.cwd);
	const target = mode === "github" ? state.gitSource : state.repoRoot;

	if (mode === "github" && !state.gitSource) {
		ctx.ui.notify("no git remote origin — cannot install from github", "error");
		return;
	}

	const installed = mode === "github" ? state.github : state.local;
	const otherInstalled = mode === "github" ? state.local : state.github;
	if (installed && !otherInstalled) {
		ctx.ui.notify(`already installed from ${mode}`, "info");
		return;
	}

	if (!installed) {
		const result = await exec(piBinary(), ["install", target], INSTALL_TIMEOUT_MS);
		if (result.code !== 0) {
			ctx.ui.notify(`pi install failed: ${firstLine(result.stderr || result.stdout)}`, "error");
			return;
		}
	}

	if (otherInstalled) {
		const other = mode === "github" ? state.repoRoot : state.gitSource;
		const result = await exec(piBinary(), ["remove", other], REMOVE_TIMEOUT_MS);
		if (result.code !== 0) {
			ctx.ui.notify(`installed from ${mode}, but pi remove failed: ${firstLine(result.stderr || result.stdout)}`, "error");
			return;
		}
	}

	const missingDeps = mode === "local" && state.hasDeps && !state.hasNodeModules;
	ctx.ui.notify(missingDeps ? "switched to local — run npm install, then /reload" : `switched to ${mode} — reloading`, "info");
	await ctx.reload();
}

export default function sourceCommand(pi: ExtensionAPI): void {
	const exec: Exec = (command, args, timeout) => pi.exec(command, args, { timeout });
	pi.registerCommand("source", {
		description: "Show or switch where this checkout is installed from (local or github)",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const items = ["github", "local"].filter((value) => value.startsWith(prefix.trim()));
			return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (!mode) {
				ctx.ui.notify(describe(await resolveState(exec, ctx.cwd)), "info");
				return;
			}
			if (mode !== "local" && mode !== "github") {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			await switchTo(mode, exec, ctx);
		},
	});
}

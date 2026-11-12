import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CommandExec, ProviderName } from "./types.ts";

const CONFIG_FILE = "web.json";
const PROVIDER_NAMES: readonly ProviderName[] = ["brave", "tavily", "exa", "duckduckgo"];
const KEY_FIELDS = {
	brave: "braveApiKey",
	tavily: "tavilyApiKey",
	exa: "exaApiKey",
} as const;
const ALLOWED_KEYS = new Set<string>(["providers", ...Object.values(KEY_FIELDS), "answerModel"]);
const MAX_CREDENTIAL_BYTES = 16_384;
const COMMAND_TIMEOUT_MS = 10_000;

export interface WebSearchConfig {
	providers: ProviderName[];
	braveApiKey?: string;
	tavilyApiKey?: string;
	exaApiKey?: string;
	answerModel: string;
}

export function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

function configError(message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.name = "ConfigError";
	error.code = "CONFIG";
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown, path: string): string[] {
	if (!isRecord(value)) return [`${path} must contain a JSON object`];

	const problems: string[] = [];
	for (const key of Object.keys(value)) {
		if (!ALLOWED_KEYS.has(key)) problems.push(`unknown key "${key}"`);
	}

	const listed: ProviderName[] = [];
	const providers = value.providers;
	if (providers === undefined) {
		problems.push(`missing required key "providers"`);
	} else if (!Array.isArray(providers)) {
		problems.push(`"providers" must be an array`);
	} else if (providers.length === 0) {
		problems.push(`"providers" must not be empty`);
	} else {
		for (const entry of providers) {
			if (typeof entry !== "string" || !PROVIDER_NAMES.includes(entry as ProviderName)) {
				problems.push(`"providers" has an invalid entry: ${JSON.stringify(entry)} (expected brave, tavily, exa, or duckduckgo)`);
				continue;
			}
			const provider = entry as ProviderName;
			if (listed.includes(provider)) problems.push(`"providers" has a duplicate entry: ${provider}`);
			else listed.push(provider);
		}
	}

	for (const provider of listed) {
		const field = KEY_FIELDS[provider as keyof typeof KEY_FIELDS];
		if (!field) continue;
		const credential = value[field];
		if (credential === undefined) {
			problems.push(`missing required key "${field}" for provider "${provider}"`);
		} else if (typeof credential !== "string" || credential.trim().length === 0) {
			problems.push(`"${field}" must be a non-empty string`);
		}
	}

	const model = value.answerModel;
	if (model === undefined) {
		problems.push(`missing required key "answerModel"`);
	} else if (typeof model !== "string" || !isModelReference(model.trim())) {
		problems.push(`"answerModel" must be a "provider/model" string, optionally suffixed with a reasoning level (e.g. "opencode-go/deepseek-v4.1-flash:low")`);
	}

	return problems;
}

function isModelReference(value: string): boolean {
	if (!value || /\s/.test(value)) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
}

/** Strict structural validation only: credentials are resolved lazily, on first use. */
export function loadConfig(): WebSearchConfig {
	const path = getConfigPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw configError(`Failed to read ${path}: ${message}\nCreate it with: { "providers": ["duckduckgo"], "answerModel": "provider/model" }`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw configError(`Failed to parse ${path}: ${message}`);
	}

	const problems = validate(parsed, path);
	if (problems.length > 0) {
		throw configError(`Invalid ${path}:\n- ${problems.join("\n- ")}`);
	}
	return parsed as WebSearchConfig;
}

type TemplatePart = { literal: string } | { env: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Pi's `auth.json` template syntax: $VAR, ${VAR}, $$ and $! escapes. */
function parseTemplate(value: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	const appendLiteral = (text: string) => {
		if (!text) return;
		const last = parts[parts.length - 1];
		if (last && "literal" in last) last.literal += text;
		else parts.push({ literal: text });
	};

	let index = 0;
	while (index < value.length) {
		const dollar = value.indexOf("$", index);
		if (dollar < 0) {
			appendLiteral(value.slice(index));
			break;
		}
		appendLiteral(value.slice(index, dollar));
		const next = value[dollar + 1];
		if (next === "$" || next === "!") {
			appendLiteral(next);
			index = dollar + 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", dollar + 2);
			if (end < 0) {
				appendLiteral("$");
				index = dollar + 1;
				continue;
			}
			const name = value.slice(dollar + 2, end);
			if (ENV_NAME.test(name)) parts.push({ env: name });
			else appendLiteral(value.slice(dollar, end + 1));
			index = end + 1;
			continue;
		}
		const match = value.slice(dollar + 1).match(ENV_PREFIX);
		if (match) {
			parts.push({ env: match[0] });
			index = dollar + 1 + match[0].length;
			continue;
		}
		appendLiteral("$");
		index = dollar + 1;
	}
	return parts;
}

function resolveTemplate(parts: TemplatePart[]): string {
	let resolved = "";
	const missing: string[] = [];
	for (const part of parts) {
		if ("literal" in part) {
			resolved += part.literal;
			continue;
		}
		const value = process.env[part.env];
		if (value === undefined || value === "") missing.push(part.env);
		else resolved += value;
	}
	if (missing.length > 0) {
		throw configError(`Credential environment variable not set: ${[...new Set(missing)].join(", ")}`);
	}
	return resolved;
}

const commandCache = new Map<string, string>();

async function resolveCommand(source: string, exec: CommandExec, signal?: AbortSignal): Promise<string> {
	const cached = commandCache.get(source);
	if (cached !== undefined) return cached;

	const command = source.slice(1).trim();
	if (!command) throw configError("Credential command is empty");

	let result: Awaited<ReturnType<CommandExec>>;
	try {
		result = await exec("sh", ["-c", command], { timeout: COMMAND_TIMEOUT_MS, signal });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw configError(`Credential command failed to run: ${message}`);
	}
	if (result.killed) throw configError(signal?.aborted ? "Credential command aborted" : "Credential command timed out");
	if (result.code !== 0) throw configError(`Credential command exited with code ${result.code}`);

	const value = result.stdout.trim();
	if (!value) throw configError("Credential command returned empty output");
	if (/[\0-\x1f\x7f]/.test(value)) throw configError("Credential command returned control characters");
	if (Buffer.byteLength(value, "utf-8") > MAX_CREDENTIAL_BYTES) {
		throw configError(`Credential command output exceeds ${MAX_CREDENTIAL_BYTES} bytes`);
	}

	commandCache.set(source, value);
	return value;
}

/** Resolve one credential value. Commands are cached for the process lifetime. */
export async function resolveCredential(value: string, exec: CommandExec, signal?: AbortSignal): Promise<string> {
	const resolved = value.startsWith("!") ? await resolveCommand(value, exec, signal) : resolveTemplate(parseTemplate(value));
	if (!resolved) throw configError("Credential resolved to an empty string");
	return resolved;
}

export async function getApiKey(
	provider: Exclude<ProviderName, "duckduckgo">,
	exec: CommandExec,
	signal?: AbortSignal,
): Promise<string> {
	const config = loadConfig();
	const field = KEY_FIELDS[provider];
	const value = config[field];
	if (!value) throw configError(`"${field}" is required for provider "${provider}"`);
	return resolveCredential(value, exec, signal);
}

import type { StoredSearchData } from "./types.ts";

export const MAX_ENTRIES = 128;
export const MAX_BYTES = 128 * 1024 * 1024;

interface Entry {
	data: StoredSearchData;
	bytes: number;
}

/** Insertion order is LRU order: every read moves an entry to the end. */
const entries = new Map<string, Entry>();
let totalBytes = 0;

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function storageError(message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.name = "StorageError";
	error.code = "STORAGE";
	return error;
}

function remove(id: string): boolean {
	const entry = entries.get(id);
	if (!entry) return false;
	entries.delete(id);
	totalBytes -= entry.bytes;
	return true;
}

export function storeResult(data: StoredSearchData): void {
	const bytes = Buffer.byteLength(JSON.stringify(data), "utf-8");
	if (bytes > MAX_BYTES) {
		throw storageError(`Result ${data.id} is ${bytes} bytes, over the ${MAX_BYTES}-byte storage limit`);
	}

	remove(data.id);
	entries.set(data.id, { data, bytes });
	totalBytes += bytes;

	while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
		const oldest = entries.keys().next();
		if (oldest.done) break;
		remove(oldest.value);
	}
}

export function getResult(id: string): StoredSearchData | null {
	const entry = entries.get(id);
	if (!entry) return null;
	entries.delete(id);
	entries.set(id, entry);
	return entry.data;
}

export function deleteResult(id: string): boolean {
	return remove(id);
}

export function clearResults(): void {
	entries.clear();
	totalBytes = 0;
}

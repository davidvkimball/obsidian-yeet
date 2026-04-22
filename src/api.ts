/**
 * HTTP client for the yeet.md API.
 *
 * Two endpoints only, matching the web app's contract:
 *   POST   /api/share           → create an immutable snapshot
 *   DELETE /api/delete/<id>     → unpublish a snapshot (token-gated)
 *
 * Uses Obsidian's `requestUrl` helper rather than the browser `fetch`
 * so requests bypass CORS on desktop and behave consistently across
 * platforms (plugin-review rule: no-restricted-globals).
 */

import { requestUrl } from "obsidian";

export interface ShareResponse {
	id: string;
	url: string;
	deleteToken: string;
}

interface RawShareResponse {
	id?: string;
	url?: string;
	deleteToken?: string;
}

export class YeetApiError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = "YeetApiError";
	}
}

/** Trim trailing slash so we can concat cleanly. */
function normalizeBase(base: string): string {
	return base.replace(/\/+$/, "");
}

export async function postShare(params: {
	baseUrl: string;
	clientId: string;
	content: string;
}): Promise<ShareResponse> {
	const res = await requestUrl({
		url: `${normalizeBase(params.baseUrl)}/api/share`,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Client-Id": params.clientId,
		},
		body: JSON.stringify({ content: params.content }),
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new YeetApiError(`Publish failed (HTTP ${res.status}).`, res.status);
	}
	const data = res.json as RawShareResponse;
	if (!data.id || !data.url || !data.deleteToken) {
		throw new YeetApiError("Publish succeeded but response was malformed.");
	}
	return { id: data.id, url: data.url, deleteToken: data.deleteToken };
}

export async function deleteShare(params: {
	baseUrl: string;
	clientId: string;
	sharedId: string;
	deleteToken: string;
}): Promise<void> {
	const res = await requestUrl({
		url: `${normalizeBase(params.baseUrl)}/api/delete/${encodeURIComponent(params.sharedId)}`,
		method: "DELETE",
		headers: {
			"Content-Type": "application/json",
			"X-Client-Id": params.clientId,
			"Authorization": `Bearer ${params.deleteToken}`,
		},
		body: JSON.stringify({ token: params.deleteToken }),
		throw: false,
	});
	// 404 means the snapshot is already gone — treat as success so the
	// plugin's record can still be cleaned up.
	if ((res.status < 200 || res.status >= 300) && res.status !== 404) {
		throw new YeetApiError(`Unpublish failed (HTTP ${res.status}).`, res.status);
	}
}

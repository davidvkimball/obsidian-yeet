/**
 * Delete-token storage backed by Obsidian's SecretStorage (available
 * since 1.11.4). Rationale: delete tokens are the only sensitive thing
 * this plugin holds. Keeping them out of data.json means they don't
 * get synced through Obsidian Sync / iCloud / git, which in turn means
 * a leaked or shared vault can't be used to unpublish someone else's
 * snapshots. Trade-off: tokens are device-local, so unpublish has to
 * happen from the same device that published.
 *
 * All tokens live in ONE secret as a JSON map
 *   { sharedId1: token1, sharedId2: token2, ... }
 * instead of one secret per snapshot, because users shouldn't see
 * dozens of individual "yeet-token-xyz" entries in their system
 * keychain viewer.
 */
import type { App } from "obsidian";

// Augment the `obsidian` module to expose the SecretStorage shape we
// use. Keeps code free of `any` casts while tolerating older bundles
// where `App.secretStorage` isn't yet in the type definitions.
declare module "obsidian" {
	interface App {
		secretStorage?: {
			getSecret(id: string): string | null;
			setSecret(id: string, value: string): void;
			listSecrets(): string[];
		};
	}
}

const SECRET_ID = "yeet-delete-tokens";

type TokenMap = Record<string, string>;

function safeParse(raw: string | null): TokenMap {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as TokenMap;
		}
	} catch {
		// Corrupt secret — treat as empty. Next write replaces it cleanly.
	}
	return {};
}

function load(app: App): TokenMap {
	const storage = app.secretStorage;
	if (!storage) return {};
	return safeParse(storage.getSecret(SECRET_ID));
}

function save(app: App, map: TokenMap): void {
	const storage = app.secretStorage;
	if (!storage) return;
	storage.setSecret(SECRET_ID, JSON.stringify(map));
}

export function getDeleteToken(app: App, sharedId: string): string | null {
	const map = load(app);
	return map[sharedId] ?? null;
}

export function setDeleteToken(app: App, sharedId: string, token: string): void {
	const map = load(app);
	map[sharedId] = token;
	save(app, map);
}

export function removeDeleteToken(app: App, sharedId: string): void {
	const map = load(app);
	if (sharedId in map) {
		delete map[sharedId];
		save(app, map);
	}
}

/** Which snapshot ids currently have a local delete token. Used by
 *  the settings tab to flag snapshots published from another device
 *  as unmanageable from here. */
export function knownTokenIds(app: App): Set<string> {
	return new Set(Object.keys(load(app)));
}

/** Runtime probe: is SecretStorage available on this Obsidian build. */
export function secretStorageAvailable(app: App): boolean {
	return app.secretStorage !== undefined;
}

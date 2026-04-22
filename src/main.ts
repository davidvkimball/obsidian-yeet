import {
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
} from "obsidian";
import { deleteShare, postShare, YeetApiError } from "./api";
import { generateClientId, sha256Hex, stripProperties } from "./content";
import {
	ConfirmPublishModal,
	ConfirmUnpublishModal,
	PublishConflictChoice,
	PublishConflictModal,
} from "./modals";
import { PublishedSnapshotsModal } from "./published-notes-modal";
import {
	DEFAULT_SETTINGS,
	findMatchingSnapshot,
	PublishedSnapshot,
	snapshotsForPath,
	YeetPluginSettings,
	YeetSettingTab,
} from "./settings";
import {
	getDeleteToken,
	removeDeleteToken,
	secretStorageAvailable,
	setDeleteToken,
} from "./token-storage";

const STATUS_PUBLISHED = "yeet.md \u2713";
const STATUS_OUT_OF_DATE = "yeet.md \u2191";

export default class YeetPlugin extends Plugin {
	settings!: YeetPluginSettings;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Per-vault client id, generated once and reused. Not a secret,
		// not an auth token; just a stable handle for server-side
		// rate-limit buckets.
		if (!this.settings.clientId) {
			this.settings.clientId = generateClientId();
			await this.saveSettings();
		}

		this.registerCommands();
		this.registerVaultEvents();

		// Status bar indicator: skip on mobile (addStatusBarItem is a
		// desktop-only API, and the status bar isn't visible there
		// anyway).
		if (!Platform.isMobile) {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass("yeet-status");
			this.statusBarEl.addEventListener("click", () => {
				void this.handleStatusClick();
			});
		}

		this.registerEvent(
			this.app.workspace.on("file-open", () => void this.refreshStatusBar())
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => void this.refreshStatusBar())
		);

		this.addSettingTab(new YeetSettingTab(this.app, this));
		void this.refreshStatusBar();
	}

	onunload(): void {
		// this.register* handles all teardown. No manual cleanup needed.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<YeetPluginSettings>
		);
		this.migrateLegacySchema();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Handles two legacy shapes in a single pass:
	 *
	 * 1. v0.0.1 stored one record per note path in `publishedNotes`,
	 *    which silently dropped the delete token on re-publish. Moved
	 *    to `publishedSnapshots` keyed by sharedId.
	 *
	 * 2. Up to v0.0.2 the delete token lived on the snapshot record
	 *    inside data.json, which syncs with the vault and therefore
	 *    with iCloud / Obsidian Sync / git. Moved to SecretStorage
	 *    (device-local) so a leaked vault can't be used to unpublish.
	 *
	 * Both migrations mutate in place; the next saveSettings write
	 * persists the cleaned record without tokens.
	 */
	private migrateLegacySchema(): void {
		let dirty = false;

		// Legacy path-keyed store -> sharedId-keyed store.
		type LegacyRecord = {
			sharedId: string;
			deleteToken?: string;
			url: string;
			publishedAt: number;
			contentHash: string;
			sourcePath?: string;
		};
		const legacy = (this.settings as unknown as {
			publishedNotes?: Record<string, LegacyRecord>;
		}).publishedNotes;
		if (legacy) {
			for (const [path, record] of Object.entries(legacy)) {
				if (!record?.sharedId) continue;
				if (this.settings.publishedSnapshots[record.sharedId]) continue;
				this.settings.publishedSnapshots[record.sharedId] = {
					sharedId: record.sharedId,
					url: record.url,
					publishedAt: record.publishedAt,
					contentHash: record.contentHash,
					sourcePath: path,
				};
				if (record.deleteToken && secretStorageAvailable(this.app)) {
					setDeleteToken(this.app, record.sharedId, record.deleteToken);
				}
			}
			delete (this.settings as unknown as { publishedNotes?: unknown }).publishedNotes;
			dirty = true;
		}

		// Lift any lingering deleteToken fields out of data.json records.
		if (secretStorageAvailable(this.app)) {
			for (const snap of Object.values(this.settings.publishedSnapshots)) {
				const legacyToken = (snap as unknown as { deleteToken?: string }).deleteToken;
				if (legacyToken) {
					setDeleteToken(this.app, snap.sharedId, legacyToken);
					delete (snap as unknown as { deleteToken?: string }).deleteToken;
					dirty = true;
				}
			}
		}

		if (dirty) void this.saveSettings();
	}

	// ---------- commands ----------

	private registerCommands(): void {
		// No default hotkey: Obsidian plugin guidelines discourage them
		// (high conflict risk with user bindings). README tells users to
		// bind Ctrl/Cmd+Shift+Y via Settings → Hotkeys.
		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.publishFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "copy-published-link",
			name: "Copy published link for current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const latest = snapshotsForPath(this.settings.publishedSnapshots, file.path)[0];
				if (!latest) return false;
				if (!checking) void this.copySnapshot(latest);
				return true;
			},
		});

		this.addCommand({
			id: "unpublish-current-note",
			name: "Unpublish latest snapshot of current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const latest = snapshotsForPath(this.settings.publishedSnapshots, file.path)[0];
				if (!latest) return false;
				if (!checking) this.promptUnpublish(file.path, latest);
				return true;
			},
		});

		this.addCommand({
			id: "show-published-snapshots",
			name: "Show all published snapshots from this vault",
			callback: () => {
				new PublishedSnapshotsModal(this.app, this).open();
			},
		});
	}

	// ---------- publish flow ----------

	private async publishFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const hash = await sha256Hex(content);

		// Exact-match snapshot? Treat as a no-op: copy the URL instead
		// of creating a duplicate.
		const exact = findMatchingSnapshot(this.settings.publishedSnapshots, file.path, hash);
		if (exact) {
			await this.copySnapshot(exact);
			return;
		}

		// Any other snapshots of this note? Buffer has diverged since
		// the latest one; route through the conflict modal.
		const existingLatest = snapshotsForPath(this.settings.publishedSnapshots, file.path)[0];
		if (existingLatest) {
			new PublishConflictModal(this.app, existingLatest.url, (choice) => {
				void this.resolveConflict(file, content, hash, existingLatest, choice);
			}).open();
			return;
		}

		// No prior snapshot for this note. Fresh publish.
		await this.performPublish(file, content, hash);
	}

	private async resolveConflict(
		file: TFile,
		content: string,
		hash: string,
		latest: PublishedSnapshot,
		choice: PublishConflictChoice
	): Promise<void> {
		if (choice === "copy") {
			await this.copySnapshot(latest);
			return;
		}
		if (choice === "replace") {
			// Delete the latest snapshot, then publish a new one. The
			// new snapshot takes the latest's slot in the store; older
			// snapshots for this note (if any) stay put so the user
			// keeps a full history until they clean them up.
			const token = getDeleteToken(this.app, latest.sharedId);
			if (!token) {
				new Notice(
					"Can't delete the old snapshot: its token isn't on this device. Publishing a new one alongside."
				);
			} else {
				try {
					await deleteShare({
						baseUrl: this.settings.apiBaseUrl,
						clientId: this.settings.clientId,
						sharedId: latest.sharedId,
						deleteToken: token,
					});
					removeDeleteToken(this.app, latest.sharedId);
				} catch (err) {
					new Notice(
						`Could not delete old snapshot: ${err instanceof Error ? err.message : String(err)}`
					);
				}
				delete this.settings.publishedSnapshots[latest.sharedId];
				await this.saveSettings();
			}
		}
		// "new" choice: keep latest snapshot untouched, publish a new
		// one alongside it. Both live in the store going forward.
		await this.performPublish(file, content, hash);
	}

	private async performPublish(
		file: TFile,
		content: string,
		hash: string
	): Promise<void> {
		// Gate every actual POST behind the confirm modal when the
		// setting is on. "Copy existing URL" paths don't land here so
		// they're never prompted, which matches user expectation (they
		// didn't ask to publish).
		if (this.settings.confirmOnPublish) {
			new ConfirmPublishModal(this.app, file.path, () => {
				void this.doPublish(file, content, hash);
			}).open();
			return;
		}
		await this.doPublish(file, content, hash);
	}

	private async doPublish(file: TFile, content: string, hash: string): Promise<void> {
		// Visible "in flight" feedback. If the publish silently fails
		// the toast is the first thing that shows the user something is
		// happening at all.
		new Notice("Publishing...");
		const toPublish = stripProperties(content, this.settings.stripProperties);
		try {
			const result = await postShare({
				baseUrl: this.settings.apiBaseUrl,
				clientId: this.settings.clientId,
				content: toPublish,
			});
			const snap: PublishedSnapshot = {
				sharedId: result.id,
				url: result.url,
				publishedAt: Date.now(),
				contentHash: hash,
				sourcePath: file.path,
			};
			this.settings.publishedSnapshots[snap.sharedId] = snap;
			// Token to SecretStorage, not data.json. Makes this device
			// the authoritative unpublisher for this snapshot.
			setDeleteToken(this.app, snap.sharedId, result.deleteToken);
			await this.saveSettings();

			if (this.settings.copyUrlOnPublish) {
				await navigator.clipboard.writeText(result.url);
			}
			if (this.settings.openUrlOnPublish) {
				window.open(result.url, "_blank", "noopener");
			}
			if (this.settings.showToast) {
				new Notice(`Published: ${result.url}`);
			}
			void this.refreshStatusBar();
		} catch (err) {
			const msg = err instanceof YeetApiError ? err.message : String(err);
			new Notice(`Publish failed: ${msg}`);
		}
	}

	// ---------- unpublish ----------

	private promptUnpublish(path: string, snap: PublishedSnapshot): void {
		new ConfirmUnpublishModal(this.app, path, snap.url, () => {
			void this.unpublishBySharedId(snap.sharedId);
		}).open();
	}

	async unpublishBySharedId(sharedId: string): Promise<void> {
		const snap = this.settings.publishedSnapshots[sharedId];
		if (!snap) return;
		const token = getDeleteToken(this.app, sharedId);
		if (!token) {
			new Notice(
				"This snapshot can only be deleted from the device that published it. Its token is stored in that device's secret storage."
			);
			return;
		}
		try {
			await deleteShare({
				baseUrl: this.settings.apiBaseUrl,
				clientId: this.settings.clientId,
				sharedId: snap.sharedId,
				deleteToken: token,
			});
			new Notice("Snapshot deleted.");
		} catch (err) {
			const msg = err instanceof YeetApiError ? err.message : String(err);
			new Notice(`Delete failed: ${msg}`);
			return;
		}
		removeDeleteToken(this.app, sharedId);
		delete this.settings.publishedSnapshots[sharedId];
		await this.saveSettings();
		void this.refreshStatusBar();
	}

	// ---------- rename tracking ----------

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				let changed = false;
				for (const snap of Object.values(this.settings.publishedSnapshots)) {
					if (snap.sourcePath === oldPath) {
						snap.sourcePath = file.path;
						changed = true;
					}
				}
				if (changed) void this.saveSettings();
			})
		);
	}

	// ---------- status bar ----------

	private async copySnapshot(snap: PublishedSnapshot): Promise<void> {
		await navigator.clipboard.writeText(snap.url);
		if (this.settings.showToast) {
			new Notice(`Link copied: ${snap.url}`);
		}
	}

	private async handleStatusClick(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const latest = snapshotsForPath(this.settings.publishedSnapshots, file.path)[0];
		if (!latest) return;
		await this.publishFile(file);
	}

	private async refreshStatusBar(): Promise<void> {
		if (!this.statusBarEl) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) {
			this.statusBarEl.empty();
			return;
		}
		const snaps = snapshotsForPath(this.settings.publishedSnapshots, file.path);
		if (snaps.length === 0) {
			this.statusBarEl.empty();
			return;
		}
		const latest = snaps[0];
		if (!latest) {
			this.statusBarEl.empty();
			return;
		}
		try {
			const current = await this.app.vault.read(file);
			const currentHash = await sha256Hex(current);
			const matching = findMatchingSnapshot(this.settings.publishedSnapshots, file.path, currentHash);
			this.statusBarEl.empty();
			const isUpToDate = !!matching;
			const label = isUpToDate ? STATUS_PUBLISHED : STATUS_OUT_OF_DATE;
			const countSuffix = snaps.length > 1 ? ` (${snaps.length})` : "";
			const span = this.statusBarEl.createEl("span", { text: `${label}${countSuffix}` });
			span.setAttr(
				"title",
				isUpToDate
					? `Published at ${(matching ?? latest).url}. ${snaps.length > 1 ? `${snaps.length} snapshots for this note. ` : ""}Click to copy.`
					: `Buffer differs from latest snapshot (${latest.url}). Click to publish.`
			);
			span.toggleClass("yeet-status-stale", !isUpToDate);
		} catch {
			this.statusBarEl.empty();
		}
	}
}

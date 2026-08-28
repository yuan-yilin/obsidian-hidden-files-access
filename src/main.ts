import {
	App,
	ButtonComponent,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

/* ── Type augmentations for internal Obsidian APIs ─────────── */

declare module "obsidian" {
	interface Vault {
		getConfig(key: string): unknown;
		setConfig(key: string, value: unknown): void;
	}
}

/** Internal adapter methods that exist at runtime but aren't typed. */
interface PrivateAdapter {
	_exists(fullPath: string, path: string): Promise<boolean>;
	getFullPath(path: string): string;
	getFullRealPath(realPath: string): string;
	getRealPath(path: string): string;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	listRecursive(path: string): Promise<void>;
	listRecursiveChild(parent: string, name: string): Promise<void>;
	reconcileDeletion(realPath: string, path: string): Promise<void>;
	reconcileFile?(e: string, t: string, silent?: boolean): Promise<void>;
	reconcileFileInternal?(realPath: string, path: string): Promise<void>;
	reconcileFolderCreation(realPath: string, path: string): Promise<void>;
}

/* ── Settings ──────────────────────────────────────────────── */

/** How the filter list is applied to hidden paths. */
type FilterMode = "all" | "whitelist" | "blacklist";

interface ShowHiddenFilesSettings {
	showAllFileTypes: boolean;
	showHiddenFiles: boolean;
	filterMode: FilterMode;
	/** Raw filter list — one entry per line (name or vault-relative path). */
	filterList: string;
}

const DEFAULT_SETTINGS: ShowHiddenFilesSettings = {
	showAllFileTypes: true,
	showHiddenFiles: true,
	filterMode: "all",
	filterList: "",
};

/** Obsidian internal directories that should never be exposed. */
const ALWAYS_EXCLUDED = new Set([".trash"]);

/** Check if any segment of a path is a dotfile/dotfolder (excluding vault config dir and .trash). */
function isHiddenPath(path: string, configDir: string): boolean {
	const segments = path.split("/");
	return segments.some(
		(s) => s.startsWith(".") && s !== configDir && !ALWAYS_EXCLUDED.has(s),
	);
}

/**
 * Entry matching on segment boundaries: a single-segment name (e.g. `.git`)
 * matches same-named items at any depth; a multi-segment path matches that
 * path's subtree (e.g. `a/.claude` matches `a/.claude/x`).
 */
function pathMatchesEntry(path: string, entry: string): boolean {
	return ("/" + path + "/").includes("/" + entry + "/");
}

/**
 * Filter decision for a hidden path. Whitelist mode also allows ancestors of
 * listed entries (so a deep file entry can be reached through its parent
 * chain); blacklist mode drops the entry's whole subtree.
 */
function isAllowedByFilter(
	path: string,
	mode: FilterMode,
	entries: readonly string[],
): boolean {
	if (mode === "all") return true;
	const matched = entries.some((e) => pathMatchesEntry(path, e));
	if (mode === "blacklist") return !matched;
	return matched || entries.some((e) => e.startsWith(path + "/"));
}

/** Parse the raw filter list text into clean entries. */
function parseFilterList(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
		.filter((line) => line.length > 0);
}

/* ── Plugin ────────────────────────────────────────────────── */

export default class ShowHiddenFilesPlugin extends Plugin {
	settings!: ShowHiddenFilesSettings;
	private previousShowUnsupportedFiles = false;
	private originalReconcileDeletion:
		| PrivateAdapter["reconcileDeletion"]
		| null = null;
	private originalListRecursiveChild:
		| PrivateAdapter["listRecursiveChild"]
		| null = null;
	private originalReconcileFile:
		| PrivateAdapter["reconcileFile"]
		| null = null;
	private originalI18nT: ((...args: unknown[]) => string) | null = null;
	private hiddenPaths = new Set<string>();
	/** Parsed cache of settings.filterList, refreshed on load/save. */
	private filterEntries: string[] = [];

	async onload() {
		await this.loadSettings();

		this.previousShowUnsupportedFiles =
			(this.app.vault.getConfig("showUnsupportedFiles") as boolean) ??
			false;

		this.applyShowAllFileTypes();

		this.app.workspace.onLayoutReady(async () => {
			if (this.settings.showHiddenFiles) {
				this.patchAdapter();
				this.suppressDotfileWarning();
				await this.rescanVault();
			}
		});

		this.addSettingTab(new ShowHiddenFilesSettingTab(this.app, this));
	}

	onunload() {
		void this.restoreAdapter();
		this.restoreDotfileWarning();
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.previousShowUnsupportedFiles,
		);
	}

	/* ── settings persistence ──────────────────────────────── */

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ShowHiddenFilesSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		this.filterEntries = parseFilterList(this.settings.filterList);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Update the filter mode and persist it. */
	async updateFilterMode(mode: FilterMode): Promise<void> {
		this.settings.filterMode = mode;
		await this.saveSettings();
	}

	/** Update the filter list (settings + parsed cache) and persist it. */
	async updateFilterList(raw: string): Promise<void> {
		this.settings.filterList = raw;
		this.filterEntries = parseFilterList(raw);
		await this.saveSettings();
	}

	/* ── show all file types ───────────────────────────────── */

	applyShowAllFileTypes() {
		this.app.vault.setConfig(
			"showUnsupportedFiles",
			this.settings.showAllFileTypes,
		);
	}

	/* ── show hidden files — adapter monkey-patch ──────────── */

	private adapter(): PrivateAdapter {
		return this.app.vault.adapter as unknown as PrivateAdapter;
	}

	private patchAdapter() {
		const adapter = this.adapter();

		if (this.originalReconcileDeletion) return; // already patched
		this.originalReconcileDeletion =
			adapter.reconcileDeletion.bind(adapter);
		this.originalListRecursiveChild =
			adapter.listRecursiveChild.bind(adapter);
		if (adapter.reconcileFile) {
			this.originalReconcileFile = adapter.reconcileFile.bind(adapter);
		}

		const origReconcileDeletion = this.originalReconcileDeletion;
		const origListRecursiveChild = this.originalListRecursiveChild;
		const origReconcileFile = this.originalReconcileFile;

		adapter.reconcileDeletion = async (
			realPath: string,
			path: string,
		) => {
			if (await this.maybeReveal(path)) return;
			// Path no longer exists on disk (or is not hidden) — remove it.
			this.hiddenPaths.delete(path);
			return origReconcileDeletion(realPath, path);
		};

		// Key recursion fix: Obsidian's folder walker applies the hidden filter
		// in listRecursiveChild and never descends into hidden folders, so only
		// top-level dotfiles were ever visited. Re-register hidden children so
		// the walk continues recursively into them at any depth.
		adapter.listRecursiveChild = async (
			parent: string,
			name: string,
		) => {
			const path = parent === "" ? name : `${parent}/${name}`;
			if (await this.maybeReveal(path)) return;
			return origListRecursiveChild(parent, name);
		};

		// Keep live fs events (create/edit) on hidden files working.
		if (origReconcileFile) {
			adapter.reconcileFile = async (
				e: string,
				t: string,
				silent?: boolean,
			) => {
				if (await this.maybeReveal(t)) return;
				this.hiddenPaths.delete(t);
				return origReconcileFile(e, t, silent);
			};
		}
	}

	/** Register a hidden path with the vault if it exists on disk. Returns true if revealed. */
	private async maybeReveal(path: string): Promise<boolean> {
		const adapter = this.adapter();
		if (!this.settings.showHiddenFiles) return false;
		if (!isHiddenPath(path, this.app.vault.configDir)) return false;
		if (
			!isAllowedByFilter(
				path,
				this.settings.filterMode,
				this.filterEntries,
			)
		) {
			return false;
		}
		const fullPath = adapter.getFullPath(path);
		if (!(await adapter._exists(fullPath, path))) return false;
		this.hiddenPaths.add(path);
		await this.showFile(path);
		return true;
	}

	private async restoreAdapter(): Promise<void> {
		if (this.originalReconcileDeletion) {
			const adapter = this.adapter();

			// Restore originals first so the cleanup below removes, not re-reveals.
			adapter.reconcileDeletion = this.originalReconcileDeletion;
			if (this.originalListRecursiveChild) {
				adapter.listRecursiveChild = this.originalListRecursiveChild;
			}
			if (this.originalReconcileFile) {
				adapter.reconcileFile = this.originalReconcileFile;
			}
			this.originalReconcileDeletion = null;
			this.originalListRecursiveChild = null;
			this.originalReconcileFile = null;

			// Hide all files we previously revealed — deepest first so folders
			// are emptied before they are removed.
			const paths = [...this.hiddenPaths].sort(
				(a, b) => b.length - a.length,
			);
			for (const path of paths) {
				await adapter.reconcileDeletion(adapter.getRealPath(path), path);
			}
			this.hiddenPaths.clear();
		}
	}

	/** Re-register a dotfile/dotfolder with the vault. */
	private async showFile(path: string): Promise<void> {
		const adapter = this.adapter();
		const realPath = adapter.getRealPath(path);

		if (adapter.reconcileFileInternal) {
			await adapter.reconcileFileInternal(realPath, path);
		}
	}

	/** Hide a previously shown dotfile. */
	private async hideFile(path: string): Promise<void> {
		const adapter = this.adapter();
		if (this.originalReconcileDeletion) {
			await this.originalReconcileDeletion(
				adapter.getRealPath(path),
				path,
			);
		}
	}

	/** Trigger a full vault rescan so all dotfiles hit our patched adapter methods. */
	private async rescanVault(): Promise<void> {
		const adapter = this.adapter();
		await adapter.listRecursive("");
		// listRecursive("") only reconciles top-level entries — hidden folders
		// nested under already-registered folders are never visited, so only
		// root-level dotfiles were revealed. Force a subtree walk for every
		// top-level folder so the patched listRecursiveChild fires for hidden
		// paths at any depth. (.obsidian/.trash remain excluded by isHiddenPath.)
		const configDir = this.app.vault.configDir;
		const { folders } = await adapter.list("");
		for (const folder of folders) {
			if (folder === configDir || ALWAYS_EXCLUDED.has(folder)) continue;
			// Skip hidden top-level folders the filter rejects outright — no
			// point walking (and reconciling) e.g. a blacklisted .git subtree.
			if (
				isHiddenPath(folder, configDir) &&
				!isAllowedByFilter(
					folder,
					this.settings.filterMode,
					this.filterEntries,
				)
			) {
				continue;
			}
			await adapter.listRecursive(folder);
		}
	}

	/** Enable hidden files — patch + rescan. */
	async enableHiddenFiles(): Promise<void> {
		this.patchAdapter();
		this.suppressDotfileWarning();
		await this.rescanVault();
	}

	/** Disable hidden files — hide all revealed files + restore. */
	async disableHiddenFiles(): Promise<void> {
		// Hide all currently visible dotfiles — deepest first so folders are
		// emptied before they are removed.
		const paths = [...this.hiddenPaths].sort((a, b) => b.length - a.length);
		for (const path of paths) {
			await this.hideFile(path);
		}
		this.hiddenPaths.clear();
		await this.restoreAdapter();
		this.restoreDotfileWarning();
	}

	/** Re-apply after a filter change — hide everything, rescan with new rules. */
	async reapplyFilter(): Promise<void> {
		if (!this.settings.showHiddenFiles) return;
		await this.disableHiddenFiles();
		await this.enableHiddenFiles();
	}

	/* ── suppress the "bad dotfile" warning ────────────────── */

	private suppressDotfileWarning() {
		const win = window as unknown as {
			i18next?: { t: (...args: unknown[]) => string };
		};
		if (!win.i18next || this.originalI18nT) return;

		this.originalI18nT = win.i18next.t.bind(win.i18next);
		const origT = this.originalI18nT;

		win.i18next.t = function (...args: unknown[]): string {
			if (args[0] === "plugins.file-explorer.msg-bad-dotfile") {
				return "";
			}
			return origT(...args);
		};
	}

	private restoreDotfileWarning() {
		if (this.originalI18nT) {
			const win = window as unknown as {
				i18next?: { t: (...args: unknown[]) => string };
			};
			if (win.i18next) {
				win.i18next.t = this.originalI18nT;
			}
			this.originalI18nT = null;
		}
	}
}

/* ── Settings tab ──────────────────────────────────────────── */

class ShowHiddenFilesSettingTab extends PluginSettingTab {
	plugin: ShowHiddenFilesPlugin;

	constructor(app: App, plugin: ShowHiddenFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("显示所有文件类型")
			.setDesc(
				"在文件列表中显示 Obsidian 默认不支持扩展名的文件（如 .json、.yml）。" +
					"与 Obsidian 原生设置「检测所有文件扩展名」联动。",
			)
			.addToggle((toggle) => {
				const current =
					(this.app.vault.getConfig(
						"showUnsupportedFiles",
					) as boolean) ?? false;
				toggle.setValue(current).onChange(async (value) => {
					this.plugin.settings.showAllFileTypes = value;
					await this.plugin.saveSettings();
					this.plugin.applyShowAllFileTypes();
				});
			});

		new Setting(containerEl)
			.setName("显示隐藏文件")
			.setDesc(
				"显示以点（.）开头的文件和文件夹（如 .gitignore、.env）。" +
					"关闭后，下方过滤规则同样不生效。",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHiddenFiles)
					.onChange(async (value) => {
						this.plugin.settings.showHiddenFiles = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.enableHiddenFiles();
						} else {
							await this.plugin.disableHiddenFiles();
						}
					}),
			);

		new Setting(containerEl)
			.setName("隐藏项过滤模式")
			.setDesc(
				"「显示全部」不做过滤；「仅显示指定项」只显示列表中的项（含其内部内容）；" +
					"「仅排除指定项」不显示列表中的项（含其内部内容）。变更后立即生效。",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("all", "显示全部（默认）")
					.addOption("whitelist", "仅显示指定项")
					.addOption("blacklist", "仅排除指定项")
					.setValue(this.plugin.settings.filterMode)
					.onChange(async (value) => {
						await this.plugin.updateFilterMode(
							value as FilterMode,
						);
						await this.plugin.reapplyFilter();
						new Notice("隐藏项过滤模式已应用");
					}),
			);

		let listDraft = this.plugin.settings.filterList;
		let applyButton: ButtonComponent | null = null;
		const refreshApplyState = () => {
			if (applyButton) {
				applyButton.setDisabled(
					listDraft === this.plugin.settings.filterList,
				);
			}
		};

		new Setting(containerEl)
			.setName("指定项列表")
			.setDesc(
				"每行一项：写名称（如 .git，匹配任意层级的同名项）或写路径" +
					"（如 call-match-loop-engineering/.claude，匹配该路径及其内部所有内容）。" +
					"仅显示模式下会自动放行列表条目的父级路径。" +
					"Obsidian 配置目录与 .trash 回收站始终不会显示。",
			)
			.addTextArea((text) => {
				text.setValue(this.plugin.settings.filterList).onChange(
					(value) => {
						listDraft = value;
						refreshApplyState();
					},
				);
				text.inputEl.rows = 6;
				text.inputEl.setCssProps({ width: "100%" });
			});

		new Setting(containerEl).addButton((btn) => {
			applyButton = btn;
			btn.setButtonText("保存列表并重新扫描")
				.setDisabled(true)
				.onClick(async () => {
					await this.plugin.updateFilterList(listDraft);
					await this.plugin.reapplyFilter();
					new Notice("隐藏项过滤列表已应用");
					refreshApplyState();
				});
		});
	}
}

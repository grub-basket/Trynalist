import { App, TFile, requestUrl, TFolder } from "obsidian";
import { convertDynalistNodes, writeImport, ImportNode } from "./import";
import { applyDocUpdate } from "./update-import";
import { listDocs } from "./store";
import { safeName } from "./id-service";
import type { DocRef } from "./types";
import { isReservedFolderName } from "./types";

/** Dynalist ids are opaque alphanumerics. They are used verbatim as file names
 *  under `_source/`, so anything else — however unlikely from the real API — is
 *  refused rather than written. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const isSafeId = (id: unknown): id is string => typeof id === "string" && SAFE_ID_RE.test(id);

/** A thin, READ-ONLY client for the Dynalist API.
 *
 *  It calls exactly two endpoints — `file/list` and `doc/read` — and never any
 *  edit endpoint (file edit, doc edit, inbox add), so importing can NEVER write
 *  back to someone's Dynalist. That guarantee is the whole reason this is a
 *  separate, self-contained module: the surface area is small enough to audit
 *  at a glance.
 *
 *  `requestUrl` (not `fetch`) is used deliberately: Obsidian routes it through
 *  the desktop app, which bypasses the CORS wall a browser fetch to dynalist.io
 *  would hit. */

const BASE = "https://dynalist.io/api/v1";

/** file/list entry: a document or a folder. Folders carry child ids. */
interface DlFile {
	id: string;
	title: string;
	type: "document" | "folder";
	permission?: number;
	children?: string[];
}

/** 0–4 as returned by file/list. */
export function permissionLabel(p: number | undefined): string {
	switch (p) {
		case 4: return "owner";
		case 3: return "manage";
		case 2: return "edit";
		case 1: return "read-only";
		case 0: return "none";
		default: return "unknown";
	}
}
interface DlFileListResponse {
	_code: string;
	_msg?: string;
	root_file_id?: string;
	files?: DlFile[];
}
interface DlDocReadResponse {
	_code: string;
	_msg?: string;
	title?: string;
	version?: number;
	nodes?: Array<Record<string, unknown>>;
}

/** Dynalist error codes are returned in the BODY with HTTP 200, so a naive
 *  status check would treat every failure as success. Translate the ones a
 *  person can act on into plain language. */
function explain(code: string, msg?: string): string {
	switch (code) {
		case "InvalidToken": return "Dynalist rejected the token. Re-copy it from Settings → Developer.";
		case "TooManyRequests": return "Dynalist is rate-limiting; the importer will slow down and retry.";
		case "LockFail": return "Dynalist could not read a document right now (it was locked).";
		case "NoInbox": return "No inbox is configured in Dynalist.";
		case "NotFound": return "A document went missing between listing and reading it.";
		default: return msg || code || "Unknown Dynalist error.";
	}
}

class DynalistError extends Error {
	constructor(public code: string, msg?: string) { super(explain(code, msg)); }
}

/** A request that exceeded its time budget — distinct from a real failure so the
 *  importer can defer the document and revisit it later with a longer budget. */
class DynalistTimeoutError extends Error {}

/** requestUrl has no timeout, so a hung connection blocks forever — and one
 *  stuck doc/read would wedge the whole sequential import. Race every request
 *  against a ceiling; on timeout the call throws, which for a per-document read
 *  is caught and the import moves on to the next document. */
const REQUEST_TIMEOUT_MS = 30000;

async function call<T extends { _code: string; _msg?: string }>(path: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
	let res;
	try {
		res = await Promise.race([
			requestUrl({
				url: `${BASE}/${path}`,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(body),
				throw: false,   // handle non-2xx ourselves; Dynalist also errors at 200
			}),
			sleep(timeoutMs).then((): never => { throw new DynalistTimeoutError(`Dynalist ${path} timed out after ${timeoutMs / 1000}s.`); }),
		]);
	} catch (e) {
		// Preserve a timeout as itself so the caller can defer + revisit; wrap
		// everything else as an unreachable-network error.
		if (e instanceof DynalistTimeoutError) throw e;
		throw new Error(`Could not reach Dynalist (${String(e)}). Check your connection.`);
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Dynalist returned HTTP ${res.status}.`);
	}
	const data = res.json as T;
	// The API returns "Ok" in practice, though its docs say "OK" — compare
	// case-insensitively so a successful response is never treated as an error.
	if (!data || (data._code ?? "").toUpperCase() !== "OK") throw new DynalistError(data?._code ?? "Unknown", data?._msg);
	return data;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** doc/read is capped at 30/min. One read every 2.1s stays comfortably under
 *  that without needing to model the token bucket. */
const DOC_READ_INTERVAL_MS = 2100;

export interface ImportProgress {
	done: number;
	total: number;
	title: string;
}

export interface DynalistImportSummary {
	documents: number;
	items: number;
	folders: number;
	/** The per-run parent folder everything landed in (vault-relative). */
	runFolder: string;
	/** Shared-with-you documents skipped because that setting was off. */
	skippedShared: number;
	/** The user cancelled partway; documents already written are kept. */
	cancelled: boolean;
	failures: Array<{ id: string; title: string; reason: string }>;
	warnings: string[];
}

/** A filesystem-safe, minute-stamped name for THIS run's parent folder, made
 *  unique so two imports in the same minute don't merge. Each run is walled off
 *  in its own folder because re-importing is additive — without this, a second
 *  run's duplicates ("My Doc 2") would scatter among the first run's documents.
 *  With it, run one and run two sit side by side and never intermingle. */
function uniqueRunFolder(app: App, rootFolder: string): string {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, "0");
	const base = `Dynalist import ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
	let name = base;
	let n = 2;
	while (app.vault.getAbstractFileByPath(`${rootFolder}/${name}`)) name = `${base} (${n++})`;
	return name;
}

/** A document to import, with the vault-relative folder path it should land in
 *  (mirroring the Dynalist folder tree). */
interface PlannedDoc {
	id: string;
	title: string;
	/** Ancestor folder titles, outermost first; empty for a top-level doc. */
	folder: string[];
	/** The account's access to this document (0–4), from file/list. */
	permission?: number;
}

/** Walk the file/list tree from the root, producing one PlannedDoc per document
 *  with its folder path. Guards against the cycles a corrupt tree could contain
 *  and against a folder that lists a child id it never defines. */
function planDocuments(files: DlFile[], rootId: string): { docs: PlannedDoc[]; folders: number } {
	const byId = new Map<string, DlFile>();
	for (const f of files) byId.set(f.id, f);
	const docs: PlannedDoc[] = [];
	const folders = new Set<string>();
	const seen = new Set<string>();

	const walk = (id: string, folder: string[]): void => {
		if (seen.has(id)) return;             // cycle or a doc reachable twice
		seen.add(id);
		const node = byId.get(id);
		if (!node) return;
		if (node.type === "folder") {
			// The synthetic root folder is not a real folder in the vault.
			const here = id === rootId ? folder : [...folder, sanitizeFolder(node.title)];
			if (id !== rootId) folders.add(here.join("/"));
			for (const childId of node.children ?? []) walk(childId, here);
		} else {
			docs.push({ id: node.id, title: node.title || "Untitled", folder, permission: node.permission });
		}
	};
	walk(rootId, []);
	return { docs, folders: folders.size };
}

/** Folder titles become vault folder names, so strip what the filesystem and
 *  Obsidian reject — the same rule createDoc applies to titles. A Dynalist
 *  folder that happens to be called `_trash` or `_archive` would otherwise be
 *  created verbatim, and discovery skips reserved names, so every document
 *  inside it would silently vanish from the panel. */
function sanitizeFolder(title: string): string {
	const safe = safeName(title, "Untitled");
	return isReservedFolderName(safe) ? `${safe} (folder)` : safe;
}

export interface ImportOptions {
	importShared?: boolean;
	keepSource?: boolean;
	/** When set, only these Dynalist document ids are processed — used to retry
	 *  just the documents that failed a previous run. */
	onlyDocIds?: string[];
	/** Polled once per document; returning true stops the run and keeps whatever
	 *  was already written. */
	isCancelled?: () => boolean;
}

/** Everything needed to run OR resume an import, persisted to disk so an abrupt
 *  quit can pick up where it left off. Written once as `_import-plan.json` in the
 *  run folder. */
interface ImportPlan {
	version: 1;
	rootFolder: string;
	runFolder: string;
	importedAt: string;
	keepSource: boolean;
	skippedShared: number;
	folders: number;
	docs: PlannedDoc[];
}

/** The moving parts, rewritten after each document so a resume knows exactly
 *  what is left and the final summary is complete even across a restart. */
interface ImportProgressFile {
	version: 1;
	done: string[];               // doc ids attempted (success or failure)
	documents: number;
	items: number;
	failures: Array<{ id: string; title: string; reason: string }>;
	warnings: string[];
	/** Which device is running the import, and when it last wrote progress.
	 *  The run folder syncs; without this a second device offered to "resume"
	 *  an import still running on the first, and resuming trashed the
	 *  documents the first had just finished (L26). */
	device?: string;
	heartbeat?: string;
}

/** This device's id: Obsidian's per-vault local storage, which does not sync
 *  (the same key the safety net uses). */
function deviceId(app: App): string {
	let id = app.loadLocalStorage("trynalist-device-id") as string | null;
	if (!id) {
		id = Math.random().toString(36).slice(2, 8);
		app.saveLocalStorage("trynalist-device-id", id);
	}
	return id;
}

/** Progress written by another device within this window means that import
 *  is alive there. */
const HEARTBEAT_FRESH_MS = 15 * 60_000;

const PLAN_FILE = "_import-plan.json";
const PROGRESS_FILE = "_import-progress.json";

async function writeVaultJson(app: App, path: string, data: unknown): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	const json = JSON.stringify(data, null, 2);
	if (existing instanceof TFile) await app.vault.modify(existing, json);
	else await app.vault.create(path, json);
}

async function deleteProgressArtifacts(app: App, runRoot: string): Promise<void> {
	for (const name of [PLAN_FILE, PROGRESS_FILE]) {
		const f = app.vault.getAbstractFileByPath(`${runRoot}/${name}`);
		if (f) { try { await app.fileManager.trashFile(f); } catch { /* best-effort */ } }
	}
}

const FAILURES_FILE = "_import-failures.json";

/** Record the failed documents of a run so they can be retried without re-reading
 *  the whole account. Removes the file when there are no failures. */
async function writeFailures(app: App, runRoot: string, failures: Array<{ id: string; title: string; reason: string }>): Promise<void> {
	const path = `${runRoot}/${FAILURES_FILE}`;
	if (failures.length) {
		await writeVaultJson(app, path, { version: 1, failures });
	} else {
		const f = app.vault.getAbstractFileByPath(path);
		if (f) { try { await app.fileManager.trashFile(f); } catch { /* best-effort */ } }
	}
}

/** The failed documents recorded for a run, or [] if none/unreadable. */
export async function readFailures(app: App, rootFolder: string, runFolder: string): Promise<Array<{ id: string; title: string; reason: string }>> {
	const data = await loadJson<{ failures?: Array<{ id: string; title: string; reason: string }> }>(app, `${rootFolder}/${runFolder}/${FAILURES_FILE}`);
	return data?.failures ?? [];
}

/** An interrupted import found on disk: its run folder plus how far it got. */
export interface ResumableImport {
	runFolder: string;
	runRoot: string;
	done: number;
	total: number;
}

/** Inspect a run folder for an interrupted import, returning how far it got, or
 *  null if there's nothing to resume (no plan file, or already complete). */
export async function findResumable(app: App, rootFolder: string, runFolder: string): Promise<ResumableImport | null> {
	const runRoot = `${rootFolder}/${runFolder}`;
	const plan = await loadJson<ImportPlan>(app, `${runRoot}/${PLAN_FILE}`);
	if (!plan) return null;
	// A plan describes the folder it was written for. One found under another
	// name was copied or planted (a restored backup), not left by a crash here
	// (L27).
	if (plan.runFolder !== runFolder) return null;
	const progress = await loadJson<ImportProgressFile>(app, `${runRoot}/${PROGRESS_FILE}`);
	// Still being written by another device: not ours to resume (L26).
	if (progress?.device && progress.device !== deviceId(app) && progress.heartbeat
		&& Date.now() - Date.parse(progress.heartbeat) < HEARTBEAT_FRESH_MS) return null;
	// A crash mid-write can leave valid-but-truncated JSON (`{}`); reading
	// `.done.length` off that threw on every startup for that folder.
	const done = Array.isArray(progress?.done) ? progress.done.length : 0;
	const total = Array.isArray(plan.docs) ? plan.docs.length : 0;
	if (!total) return null;
	if (done >= total) return null;                 // finished; nothing to resume
	return { runFolder, runRoot, done, total };
}

/** Import the ENTIRE Dynalist account: list files, recreate the folder tree, and
 *  read+write every document, throttled to the API's rate limit. Read-only
 *  against Dynalist. Cancellable, and resumable after a crash. */
export async function importEntireAccount(
	app: App,
	rootFolder: string,
	token: string,
	onProgress: (p: ImportProgress) => void,
	opts?: ImportOptions,
): Promise<DynalistImportSummary> {
	const list = await call<DlFileListResponse>("file/list", { token });
	const files = list.files ?? [];
	const rootId = list.root_file_id ?? files.find((f) => f.type === "folder")?.id ?? "";
	const planned = planDocuments(files, rootId);
	// When shared docs are excluded, keep only owned ones (permission 4). A
	// missing permission is treated as owned, so nothing is dropped on the safe
	// side if the field is ever absent.
	const includeShared = opts?.importShared ?? true;
	const docs = includeShared ? planned.docs : planned.docs.filter((d) => (d.permission ?? 4) === 4);

	const runFolder = uniqueRunFolder(app, rootFolder);
	const runRoot = `${rootFolder}/${runFolder}`;
	const plan: ImportPlan = {
		version: 1, rootFolder, runFolder,
		importedAt: new Date().toISOString(),
		keepSource: opts?.keepSource ?? true,
		skippedShared: planned.docs.length - docs.length,
		folders: planned.folders,
		docs,
	};
	if (!app.vault.getFolderByPath(runRoot)) await app.vault.createFolder(runRoot);
	await writeVaultJson(app, `${runRoot}/${PLAN_FILE}`, plan);
	if (plan.keepSource) {
		const sourceDir = `${runRoot}/_source`;
		if (!app.vault.getFolderByPath(sourceDir)) await app.vault.createFolder(sourceDir);
		await writeVaultJson(app, `${sourceDir}/file-list.json`, list);
	}

	return runImport(app, token, plan, { version: 1, done: [], documents: 0, items: 0, failures: [], warnings: [] }, onProgress, opts);
}

/** Continue an import interrupted by a crash, from its on-disk plan + progress. */
export async function resumeImport(
	app: App,
	rootFolder: string,
	runFolder: string,
	token: string,
	onProgress: (p: ImportProgress) => void,
	opts?: ImportOptions,
): Promise<DynalistImportSummary> {
	const runRoot = `${rootFolder}/${runFolder}`;
	const raw = await loadJson<ImportPlan>(app, `${runRoot}/${PLAN_FILE}`);
	if (!raw) throw new Error("This import can't be resumed — its plan file is missing.");
	const plan = trustedPlan(raw, rootFolder, runFolder);
	const loaded = await loadJson<Partial<ImportProgressFile>>(app, `${runRoot}/${PROGRESS_FILE}`);
	// Tolerate a truncated progress file field by field rather than trusting
	// its shape — the plan is what matters; progress is only "what's done".
	const progress: ImportProgressFile = {
		version: 1,
		done: Array.isArray(loaded?.done) ? loaded.done : [],
		documents: typeof loaded?.documents === "number" ? loaded.documents : 0,
		items: typeof loaded?.items === "number" ? loaded.items : 0,
		failures: Array.isArray(loaded?.failures) ? loaded.failures : [],
		warnings: Array.isArray(loaded?.warnings) ? loaded.warnings : [],
	};
	return runImport(app, token, plan, progress, onProgress, opts);
}

/** A plan read back from disk is input, not configuration: the file can be
 *  hand-edited, planted by a restored backup, or synced from elsewhere. Every
 *  path it influences is rebuilt from what the caller already validated —
 *  the run's own location, never the plan's `rootFolder`/`runFolder` — and
 *  each document's folder segments go through the same sanitizer a fresh
 *  import uses. A plan with `"rootFolder": ".."` and a doc folder of
 *  `["..","..","Library","LaunchAgents"]` wrote outside the vault on
 *  resume (M53). Documents whose id is not a plain Dynalist id are dropped:
 *  the id becomes a file name under `_source`. */
function trustedPlan(raw: ImportPlan, rootFolder: string, runFolder: string): ImportPlan {
	const docs: PlannedDoc[] = [];
	for (const d of Array.isArray(raw.docs) ? raw.docs : []) {
		if (!d || typeof d.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(d.id)) continue;
		const folder = Array.isArray(d.folder) ? d.folder.map((seg) => sanitizeFolder(String(seg))) : [];
		docs.push({ ...d, title: typeof d.title === "string" ? d.title : "Untitled", folder });
	}
	return {
		...raw,
		version: 1,
		rootFolder,
		runFolder,
		keepSource: !!raw.keepSource,
		docs,
	};
}

async function loadJson<T>(app: App, path: string): Promise<T | null> {
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) return null;
	try { return JSON.parse(await app.vault.read(f)) as T; } catch { return null; }
}

/** The shared loop for both fresh and resumed imports. Skips documents already
 *  in `progress.done`, persists progress after each one, and cleans up its
 *  bookkeeping files on a clean finish or a cancel (only a crash leaves them,
 *  which is exactly what makes the run resumable). */
async function runImport(
	app: App,
	token: string,
	plan: ImportPlan,
	progress: ImportProgressFile,
	onProgress: (p: ImportProgress) => void,
	opts?: ImportOptions,
): Promise<DynalistImportSummary> {
	const runRoot = `${plan.rootFolder}/${plan.runFolder}`;
	const docs = plan.docs;
	const doneSet = new Set(progress.done);
	const sourceDir = `${runRoot}/_source`;
	let cancelled = false;

	// Documents already in the run folder, by Dynalist id. A resume that finds
	// one for a document NOT marked done is looking at the half-written victim
	// of the crash: re-importing beside it would make "Title 2". It is moved to
	// the Obsidian trash (recoverable) and written again from scratch.
	const partials = new Map<string, DocRef>();
	{
		// Always listed (a fresh run's folder is empty, so this is cheap): a crash
		// during the very FIRST document leaves nothing in progress.done, and that
		// is precisely the resume that would otherwise duplicate it.
		try {
			for (const d of await listDocs(app, runRoot, { includeArchived: true })) {
				if (d.manifest.dlFileId) partials.set(d.manifest.dlFileId, d);
			}
		} catch (e) {
			console.warn("Trynalist: could not list the run folder before resuming", e);
		}
	}

	// Read one document and write it out. Throws on any error (a timeout throws
	// DynalistTimeoutError, which the caller treats specially).
	const processDoc = async (doc: PlannedDoc, timeoutMs: number): Promise<void> => {
		if (!isSafeId(doc.id)) throw new Error(`Dynalist returned an unusable document id (${JSON.stringify(doc.id)}).`);
		const partial = partials.get(doc.id);
		if (partial) {
			partials.delete(doc.id);
			await app.fileManager.trashFile(partial.folder);
			progress.warnings.push(`${doc.title}: a partly written copy from the interrupted run was moved to the Obsidian trash and the document was imported again.`);
		}
		const read = await readWithRetry(token, doc.id, timeoutMs);
		if (plan.keepSource) await writeVaultJson(app, `${sourceDir}/${doc.id}.json`, read);
		const result = convertDynalistNodes(read.nodes ?? [], doc.title || read.title || "Untitled");
		const target = doc.folder.length ? `${runRoot}/${doc.folder.join("/")}` : runRoot;
		const label = permissionLabel(doc.permission);
		const stampManifest = (m: DocRef["manifest"]): void => {
			m.dlFileId = doc.id;
			m.source = "dynalist";
			if (typeof doc.permission === "number") m.dlPermission = doc.permission;
			m.dlPermissionLabel = label;
			m.dlImportedAt = plan.importedAt;
			if (typeof read.version === "number") m.dlVersion = read.version;
		};
		const { doc: written, items } = await writeImport(app, target, result, doc.title, {
			source: "dynalist", dlPermission: doc.permission, dlPermissionLabel: label,
		}, async (created) => {
			// Stamp the id BEFORE the items go in, so a crash mid-write leaves a
			// document the resume above can recognise and replace.
			stampManifest(created.manifest);
			await app.vault.modify(created.file, JSON.stringify(created.manifest, null, 2));
		});
		stampManifest(written.manifest);
		await app.vault.modify(written.file, JSON.stringify(written.manifest, null, 2));
		progress.documents++;
		progress.items += items;
		for (const w of result.warnings) progress.warnings.push(`${doc.title}: ${w}`);
	};

	const markDone = async (doc: PlannedDoc): Promise<void> => {
		doneSet.add(doc.id);
		progress.done = [...doneSet];
		// Persist BEFORE the throttle sleep, so a crash during the wait still
		// records this document as done.
		progress.device = deviceId(app);
		progress.heartbeat = new Date().toISOString();
		await writeVaultJson(app, `${runRoot}/${PROGRESS_FILE}`, progress);
	};

	// First pass: quick timeout. A document that times out is NOT failed — it is
	// set aside (not marked done, so a crash-resume would retry it too) and
	// revisited at the end, where it no longer holds up the fast ones.
	const deferred: PlannedDoc[] = [];
	for (let i = 0; i < docs.length; i++) {
		const started = Date.now();   // pace from the START of this document (L87)
		const doc = docs[i];
		if (doneSet.has(doc.id)) continue;
		if (opts?.isCancelled?.()) { cancelled = true; break; }
		onProgress({ done: i, total: docs.length, title: doc.title });
		try {
			await processDoc(doc, REQUEST_TIMEOUT_MS);
			await markDone(doc);
		} catch (e) {
			if (e instanceof DynalistTimeoutError) {
				deferred.push(doc);            // revisit later; leave un-done
			} else {
				progress.failures.push({ id: doc.id, title: doc.title, reason: e instanceof Error ? e.message : String(e) });
				await markDone(doc);
			}
		}
		if (i < docs.length - 1) await sleep(Math.max(0, DOC_READ_INTERVAL_MS - (Date.now() - started)));
	}

	// Second pass: the long documents, with a generous budget now that they only
	// hold up each other. A timeout HERE is a genuine failure.
	if (!cancelled && deferred.length) {
		for (let i = 0; i < deferred.length; i++) {
			const started = Date.now();   // pace from the START of this document (L87)
			const doc = deferred[i];
			if (opts?.isCancelled?.()) { cancelled = true; break; }
			onProgress({ done: i, total: deferred.length, title: `revisiting: ${doc.title}` });
			try {
				await processDoc(doc, REVISIT_TIMEOUT_MS);
			} catch (e) {
				const reason = e instanceof DynalistTimeoutError
					? `still too slow after ${REVISIT_TIMEOUT_MS / 1000}s`
					: (e instanceof Error ? e.message : String(e));
				progress.failures.push({ id: doc.id, title: doc.title, reason });
			}
			await markDone(doc);
			if (i < deferred.length - 1) await sleep(Math.max(0, DOC_READ_INTERVAL_MS - (Date.now() - started)));
		}
	}

	// A cancel before the revisit pass leaves the deferred (slow) documents
	// neither done nor failed. Record them as failures so "Retry failed
	// documents" can pick them up — otherwise they appeared nowhere at all.
	if (cancelled) {
		for (const doc of deferred) {
			if (progress.failures.some((f) => f.id === doc.id)) continue;
			progress.failures.push({ id: doc.id, title: doc.title, reason: "not attempted — the import was cancelled before this slow document was revisited" });
		}
	}

	// Reached the end OR cancelled under our own control — either way the run is
	// intentionally over, so drop its bookkeeping. Only an abrupt quit (no code
	// runs) leaves the files behind, which is exactly what makes THAT resumable.
	await deleteProgressArtifacts(app, runRoot);
	await writeFailures(app, runRoot, progress.failures);
	onProgress({ done: docs.length, total: docs.length, title: "" });
	return {
		documents: progress.documents,
		items: progress.items,
		folders: plan.folders,
		runFolder: plan.runFolder,
		skippedShared: plan.skippedShared,
		cancelled,
		failures: progress.failures,
		warnings: progress.warnings,
	};
}

export interface UpdateImportSummary {
	runFolder: string;
	/** Documents processed this run (matched + new), for an X-of-Y fraction. */
	docsTotal: number;
	/** Matched documents visited (whether or not anything changed). */
	docsUpdated: number;
	docsAdded: number;
	/** Titles of the documents newly added this run. */
	newDocTitles: string[];
	docsRemovedMarked: number;
	itemsUpdated: number;
	itemsBackfilled: number;
	itemsAdded: number;
	itemsRemovedMarked: number;
	/** Items changed both here and in Dynalist: the local version was kept. */
	itemsConflicted: number;
	/** First few conflicted item texts, for the report. */
	conflictTexts: string[];
	/** Items deleted, merged or moved away locally that Dynalist still has:
	 *  not brought back. */
	itemsKeptDeleted: number;
	/** Documents skipped because Dynalist says they have not changed. */
	docsUnchanged: number;
	/** Folders of documents this run wrote, so exactly those open views reload. */
	touchedFolders: string[];
	cancelled: boolean;
	/** True when the run targeted a chosen subset (onlyDocIds); the report then
	 *  lists every selected document, unchanged ones included. */
	selective: boolean;
	/** Per-document breakdown. For a full run only changed docs; for a selective
	 *  run every selected document, so the report can show each one's status. */
	docResults: Array<{ title: string; updated: number; backfilled: number; added: number; removedMarked: number }>;
	failures: Array<{ id: string; title: string; reason: string }>;
}

/** Re-run an import in place: re-fetch the whole account and fold changes into
 *  an EXISTING run folder — updating changed items, adding new ones, and marking
 *  (not deleting) items gone from Dynalist. Trynalist ids are preserved so links
 *  and mirrors survive. New documents are added; documents gone from Dynalist
 *  have their manifest marked removed. */
export async function updateExistingImport(
	app: App,
	rootFolder: string,
	runFolder: string,
	token: string,
	onProgress: (p: ImportProgress) => void,
	opts?: ImportOptions,
): Promise<UpdateImportSummary> {
	const runRoot = `${rootFolder}/${runFolder}`;
	const stamp = new Date().toISOString();
	const list = await call<DlFileListResponse>("file/list", { token });
	const files = list.files ?? [];
	const rootId = list.root_file_id ?? files.find((f) => f.type === "folder")?.id ?? "";
	const planned = planDocuments(files, rootId);
	const includeShared = opts?.importShared ?? true;
	let docs = includeShared ? planned.docs : planned.docs.filter((d) => (d.permission ?? 4) === 4);
	if (opts?.onlyDocIds) {
		const wanted = new Set(opts.onlyDocIds);
		docs = docs.filter((d) => wanted.has(d.id));
	}
	const keepSource = opts?.keepSource ?? true;
	const sourceDir = `${runRoot}/_source`;
	if (keepSource) {
		if (!app.vault.getFolderByPath(sourceDir)) await app.vault.createFolder(sourceDir);
		await writeVaultJson(app, `${sourceDir}/file-list.json`, list);
	}

	// Existing documents keyed by the Dynalist file id they carry — searched
	// across the WHOLE root, not just this run: a document the user moved out
	// of the run folder (into "Projects", say) was re-imported as a duplicate
	// and stopped tracking Dynalist for good (M14/M15). Copies inside this run
	// take precedence when the same file id exists twice.
	const everywhere = await listDocs(app, rootFolder, { includeArchived: true });
	const inRun = await listDocs(app, runRoot, { includeArchived: true });
	const byFileId = new Map<string, DocRef>();
	for (const d of everywhere) if (d.manifest.dlFileId) byFileId.set(d.manifest.dlFileId, d);
	for (const d of inRun) if (d.manifest.dlFileId) byFileId.set(d.manifest.dlFileId, d);

	// Where each Dynalist item id lives now (document folders and Trynalist's
	// trash), from the metadata cache — so an update can tell an item the user
	// moved or deleted from one that is new in Dynalist (M10).
	const dlHome = new Map<string, Set<string>>();
	const noteHome = (folder: TFolder | null): void => {
		if (!folder) return;
		for (const c of folder.children) {
			if (c instanceof TFolder) { noteHome(c); continue; }
			if (!(c instanceof TFile) || c.extension !== "md") continue;
			const id: unknown = app.metadataCache.getFileCache(c)?.frontmatter?.dlId;
			if (typeof id !== "string" || !id) continue;
			const homes = dlHome.get(id) ?? new Set<string>();
			homes.add(c.parent?.path ?? "");
			dlHome.set(id, homes);
		}
	};
	noteHome(app.vault.getFolderByPath(rootFolder));

	// One cheap call says which documents changed since their stored version;
	// the rest are skipped — no read, no snapshot rewrite, no 2 s wait. Any
	// failure here just means "read everything", as before (M16).
	let versions: Record<string, number> | null = null;
	if (!opts?.onlyDocIds) {
		try {
			versions = {};
			for (let i = 0; i < docs.length; i += 100) {
				const r = await call<{ _code: string; _msg?: string; versions?: Record<string, number> }>(
					"doc/check_for_updates", { token, file_ids: docs.slice(i, i + 100).map((d) => d.id) },
				);
				Object.assign(versions, r.versions ?? {});
			}
		} catch {
			versions = null;
		}
	}

	const summary: UpdateImportSummary = {
		runFolder, docsTotal: 0, docsUpdated: 0, docsAdded: 0, newDocTitles: [], docsRemovedMarked: 0,
		itemsUpdated: 0, itemsBackfilled: 0, itemsAdded: 0, itemsRemovedMarked: 0,
		itemsConflicted: 0, conflictTexts: [], itemsKeptDeleted: 0, docsUnchanged: 0, touchedFolders: [],
		cancelled: false, selective: !!opts?.onlyDocIds, docResults: [], failures: [],
	};
	summary.docsTotal = docs.length;
	const seenFileIds = new Set<string>();
	const deferred: PlannedDoc[] = [];

	/** Returns whether Dynalist was actually read (the pacing only applies then). */
	const handle = async (doc: PlannedDoc, timeoutMs: number): Promise<boolean> => {
		if (!isSafeId(doc.id)) throw new Error(`Dynalist returned an unusable document id (${JSON.stringify(doc.id)}).`);
		const match = byFileId.get(doc.id);
		const known = versions?.[doc.id];
		if (match && typeof known === "number" && match.manifest.dlVersion === known && !match.manifest.dlRemoved) {
			summary.docsUnchanged++;
			return false;
		}
		const read = await readWithRetry(token, doc.id, timeoutMs);
		// The previous snapshot is the BASE of the three-way compare; read it
		// before this run's replaces it.
		const snapshotPath = `${sourceDir}/${doc.id}.json`;
		const previous = match ? await loadJson<DlDocReadResponse>(app, snapshotPath) : null;
		const label = permissionLabel(doc.permission);
		const prov = { source: "dynalist", dlPermission: doc.permission, dlPermissionLabel: label };
		if (match) {
			const home = match.folder.path;
			const counts = await applyDocUpdate(app, match, read.nodes ?? [], prov, stamp, {
				base: previous?.nodes ?? undefined,
				lastSync: match.manifest.dlImportedAt,
				isElsewhere: (id) => [...(dlHome.get(id) ?? [])].some((f) => f !== home),
			});
			if (keepSource) await writeVaultJson(app, snapshotPath, read);
			summary.itemsUpdated += counts.updated;
			summary.itemsBackfilled += counts.backfilled;
			summary.itemsAdded += counts.added;
			summary.itemsRemovedMarked += counts.removedMarked;
			summary.itemsConflicted += counts.conflicts;
			summary.itemsKeptDeleted += counts.keptDeleted;
			for (const t of counts.conflictTexts) if (summary.conflictTexts.length < 20) summary.conflictTexts.push(`${match.manifest.title}: ${t}`);
			summary.touchedFolders.push(home);
			if (counts.updated || counts.backfilled || counts.added || counts.removedMarked || summary.selective) {
				summary.docResults.push({ title: match.manifest.title, updated: counts.updated, backfilled: counts.backfilled, added: counts.added, removedMarked: counts.removedMarked });
			}
			match.manifest.dlImportedAt = stamp;
			if (typeof read.version === "number") match.manifest.dlVersion = read.version;
			// It's back (or never left): an earlier "gone from Dynalist" mark on
			// the DOCUMENT is cleared here, just as the item-level marks are.
			delete match.manifest.dlRemoved;
			await app.vault.modify(match.file, JSON.stringify(match.manifest, null, 2));
			summary.docsUpdated++;
		} else {
			// New document since the last import — add it fresh into the run.
			if (keepSource) await writeVaultJson(app, snapshotPath, read);
			const result = convertDynalistNodes(read.nodes ?? [], doc.title || read.title || "Untitled");
			const target = doc.folder.length ? `${runRoot}/${doc.folder.join("/")}` : runRoot;
			const stampManifest = (m: DocRef["manifest"]): void => {
				m.dlFileId = doc.id;
				m.source = "dynalist";
				if (typeof doc.permission === "number") m.dlPermission = doc.permission;
				m.dlPermissionLabel = label;
				m.dlImportedAt = stamp;
				if (typeof read.version === "number") m.dlVersion = read.version;
			};
			const { doc: written, items } = await writeImport(app, target, result, doc.title, prov, async (created) => {
				stampManifest(created.manifest);
				await app.vault.modify(created.file, JSON.stringify(created.manifest, null, 2));
			});
			stampManifest(written.manifest);
			await app.vault.modify(written.file, JSON.stringify(written.manifest, null, 2));
			summary.docsAdded++;
			summary.newDocTitles.push(doc.title);
			summary.itemsAdded += items;
			summary.docResults.push({ title: doc.title, updated: 0, backfilled: 0, added: items, removedMarked: 0 });
			summary.touchedFolders.push(written.folder.path);
		}
		return true;
	};

	for (let i = 0; i < docs.length; i++) {
		const started = Date.now();   // pace from the START of this document (L87)
		const doc = docs[i];
		if (opts?.isCancelled?.()) { summary.cancelled = true; break; }
		onProgress({ done: i, total: docs.length, title: doc.title });
		seenFileIds.add(doc.id);
		let didRead = true;
		try {
			didRead = await handle(doc, REQUEST_TIMEOUT_MS);
		} catch (e) {
			if (e instanceof DynalistTimeoutError) deferred.push(doc);
			else summary.failures.push({ id: doc.id, title: doc.title, reason: e instanceof Error ? e.message : String(e) });
		}
		if (didRead && i < docs.length - 1) await sleep(Math.max(0, DOC_READ_INTERVAL_MS - (Date.now() - started)));
	}
	if (!summary.cancelled && deferred.length) {
		for (let i = 0; i < deferred.length; i++) {
			const started = Date.now();   // pace from the START of this document (L87)
			const doc = deferred[i];
			if (opts?.isCancelled?.()) { summary.cancelled = true; break; }
			onProgress({ done: i, total: deferred.length, title: `revisiting: ${doc.title}` });
			try {
				await handle(doc, REVISIT_TIMEOUT_MS);
			} catch (e) {
				const reason = e instanceof DynalistTimeoutError ? `still too slow after ${REVISIT_TIMEOUT_MS / 1000}s` : (e instanceof Error ? e.message : String(e));
				summary.failures.push({ id: doc.id, title: doc.title, reason });
			}
			if (i < deferred.length - 1) await sleep(Math.max(0, DOC_READ_INTERVAL_MS - (Date.now() - started)));
		}
	}

	// Documents that used to be imported but are gone from Dynalist now — mark
	// the manifest, don't delete. Only a FULL run can say a document is gone: a
	// selective run (chosen documents, or a retry of failures) never listed the
	// rest, so it must not mark them. Likewise a document that was imported as
	// shared and is now simply excluded by the "import shared" setting is not
	// gone from Dynalist — it's filtered out here.
	if (!summary.cancelled && !summary.selective) {
		for (const [fid, d] of byFileId) {
			if (seenFileIds.has(fid)) continue;
			if (d.manifest.dlRemoved) continue;
			if (!includeShared && (d.manifest.dlPermission ?? 4) !== 4) continue;
			d.manifest.dlRemoved = stamp;
			await app.vault.modify(d.file, JSON.stringify(d.manifest, null, 2));
			summary.docsRemovedMarked++;
		}
	}
	await writeFailures(app, runRoot, summary.failures);
	onProgress({ done: docs.length, total: docs.length, title: "" });
	return summary;
}

/** doc/read, retrying once on an explicit rate-limit code with a longer wait —
 *  the steady interval should prevent this, but a burst at the start can trip
 *  it. */
async function readWithRetry(token: string, fileId: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DlDocReadResponse> {
	try {
		return await call<DlDocReadResponse>("doc/read", { token, file_id: fileId }, timeoutMs);
	} catch (e) {
		if (e instanceof DynalistError && e.code === "TooManyRequests") {
			await sleep(5000);
			return await call<DlDocReadResponse>("doc/read", { token, file_id: fileId }, timeoutMs);
		}
		throw e;
	}
}

/** The generous budget for the revisit pass over documents that timed out on the
 *  first, quick pass — they're known to be large and worth waiting for, and by
 *  now they no longer block the fast ones (those are already imported). */
const REVISIT_TIMEOUT_MS = 180000;

/** A one-line preflight so the token can be checked before a full run — reused
 *  by the settings "Test" button. Returns the number of files (docs + folders). */
/** A document in the account, for a selection UI: its id, title, and folder
 *  path. One file/list call, no doc reads — cheap even when rate-limited. */
export interface AccountDoc {
	id: string;
	title: string;
	folder: string[];
	permission?: number;
}

export async function listAccountDocuments(token: string, importShared = true): Promise<AccountDoc[]> {
	const list = await call<DlFileListResponse>("file/list", { token });
	const files = list.files ?? [];
	const rootId = list.root_file_id ?? files.find((f) => f.type === "folder")?.id ?? "";
	const planned = planDocuments(files, rootId);
	const docs = importShared ? planned.docs : planned.docs.filter((d) => (d.permission ?? 4) === 4);
	return docs.map((d) => ({ id: d.id, title: d.title, folder: d.folder, permission: d.permission }));
}

export async function testToken(token: string): Promise<number> {
	const list = await call<DlFileListResponse>("file/list", { token });
	return (list.files ?? []).length;
}

// Re-exported so main.ts imports one module for the whole feature.
export type { ImportNode };

import type { App } from "obsidian";

/** Token storage backed by Obsidian's own keychain API (`app.secretStorage`,
 *  since 1.11.4). The secret lives in the OS keychain, NOT in this plugin's
 *  data.json — so the token never sits in plaintext in the vault, which is the
 *  whole point of "keychain support".
 *
 *  NON-DESTRUCTIVE. Everything here is scoped to our own secret id
 *  ("dynalist-api-token"): getSecret / setSecret / listSecrets only. We never
 *  overwrite or remove a secret that belongs to anything else — setSecret on our
 *  id can only ever change our own value, and the keychain-import scan below only
 *  READS other ids, never writes them.
 *
 *  Legacy: an earlier build stored the token as an Electron-safeStorage blob in
 *  settings; `legacyDecrypt` reads that once so loadSettings can migrate it into
 *  the keychain, after which the old field is cleared. */

/** Obsidian secret ids must match /^[a-z0-9-]{1,64}$/. */
export const TOKEN_SECRET_ID = "dynalist-api-token";

interface SecretStorage {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void | Promise<void>;
	listSecrets?(): string[];
}

function store(app: App): SecretStorage | null {
	return (app as App & { secretStorage?: SecretStorage }).secretStorage ?? null;
}

/** Whether Obsidian's keychain API is present (desktop 1.11.4+). */
export function keychainAvailable(app: App): boolean {
	return !!store(app);
}

/** The saved Dynalist token, or "" when none is stored. */
export function getToken(app: App): string {
	const ss = store(app);
	if (!ss) return "";
	try {
		return ss.getSecret(TOKEN_SECRET_ID) ?? "";
	} catch {
		return "";
	}
}

/** Save (or clear, when empty) the Dynalist token in the keychain. */
export async function setToken(app: App, token: string): Promise<boolean> {
	const ss = store(app);
	if (!ss) return false;
	try {
		await ss.setSecret(TOKEN_SECRET_ID, token.trim());
		return true;
	} catch {
		return false;
	}
}

/** Secret ids Obsidian knows about whose id mentions "dynalist" — so a token
 *  another tool (or an earlier id of ours) put in the keychain can be found and
 *  adopted. READ-ONLY: this only lists and reads, never writes those ids. Empty
 *  array when listing isn't supported or nothing matches. */
export function findDynalistSecretIds(app: App): string[] {
	const ss = store(app);
	if (!ss || typeof ss.listSecrets !== "function") return [];
	try {
		return ss.listSecrets().filter((id) => id.toLowerCase().includes("dynalist"));
	} catch {
		return [];
	}
}

/** Read a token from any keychain secret whose id mentions "dynalist" (our own
 *  id first). Returns the value and the id it came from, or null. */
export function importFromKeychain(app: App): { id: string; token: string } | null {
	const ss = store(app);
	if (!ss) return null;
	// Prefer our canonical id, then any other dynalist-ish id.
	const ids = [TOKEN_SECRET_ID, ...findDynalistSecretIds(app).filter((id) => id !== TOKEN_SECRET_ID)];
	for (const id of ids) {
		try {
			const v = ss.getSecret(id);
			if (v && v.trim()) return { id, token: v.trim() };
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/** Decrypt an old Electron-safeStorage blob from a previous build, for one-time
 *  migration into the keychain. Returns null if it can't be read. */
export function legacyDecrypt(b64: string): string | null {
	if (!b64) return null;
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		if (typeof req !== "function") return null;
		const electron = req("electron") as { remote?: { safeStorage?: { decryptString(b: Buffer): string } }; safeStorage?: { decryptString(b: Buffer): string } } | null;
		const ss = electron?.safeStorage ?? electron?.remote?.safeStorage;
		if (!ss) return null;
		return ss.decryptString(Buffer.from(b64, "base64"));
	} catch {
		return null;
	}
}

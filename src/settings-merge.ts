/** Three-way merge of the plugin's settings (data.json), for when another
 *  device changed the file since this one last read or wrote it.
 *
 *  base   = what this device last read from / wrote to disk
 *  local  = this device's in-memory settings now
 *  remote = what is on disk now
 *
 *  The result starts from remote and overlays only what THIS device changed
 *  since base. Plain objects (per-document settings keyed by path) and the
 *  two keyed lists (templates by name, bookmarks by id) merge entry by
 *  entry, so an entry added on each device survives and one deleted here
 *  stays deleted. Anything else changed on both sides: this device wins,
 *  which matches what saving used to do for everything. */

type Json = unknown;

/** JSON with object keys sorted, so equality does not depend on key order. */
export function stableStringify(v: Json): string {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	if (v && typeof v === "object") {
		const o = v as Record<string, Json>;
		return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

const same = (a: Json, b: Json): boolean => stableStringify(a) === stableStringify(b);
const isPlainObject = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** Lists merged per entry, by the field that identifies an entry. */
const KEYED_LISTS: Record<string, string> = { templates: "name", bookmarks: "id" };

function mergeObject(base: Record<string, Json>, local: Record<string, Json>, remote: Record<string, Json>): Record<string, Json> {
	const out: Record<string, Json> = { ...remote };
	for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
		const inLocal = Object.prototype.hasOwnProperty.call(local, k);
		const inBase = Object.prototype.hasOwnProperty.call(base, k);
		if (!inLocal && inBase) { delete out[k]; continue; }      // removed here
		if (inLocal && (!inBase || !same(local[k], base[k]))) out[k] = local[k];   // added / changed here
	}
	return out;
}

function mergeKeyedList(field: string, base: Json[], local: Json[], remote: Json[]): Json[] {
	const keyOf = (e: Json): string | null => (isPlainObject(e) && typeof e[field] === "string" ? e[field] as string : null);
	const index = (list: Json[]): Map<string, Json> => {
		const m = new Map<string, Json>();
		for (const e of list) { const k = keyOf(e); if (k !== null) m.set(k, e); }
		return m;
	};
	const b = index(base), l = index(local);
	const out: Json[] = [];
	const seen = new Set<string>();
	for (const e of remote) {
		const k = keyOf(e);
		if (k === null) { out.push(e); continue; }
		seen.add(k);
		if (b.has(k) && !l.has(k)) continue;                                 // deleted here
		out.push(l.has(k) && (!b.has(k) || !same(l.get(k), b.get(k))) ? l.get(k) : e);   // edited here wins
	}
	for (const e of local) {                                                 // added here
		const k = keyOf(e);
		if (k === null || seen.has(k) || b.has(k)) continue;
		out.push(e);
	}
	return out;
}

export function mergeSettings(
	base: Record<string, Json>, local: Record<string, Json>, remote: Record<string, Json>,
): Record<string, Json> {
	const out: Record<string, Json> = { ...remote };
	for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) {
		const bv = base[k], lv = local[k], rv = remote[k];
		if (same(lv, bv)) continue;                         // untouched here: remote stands
		if (same(rv, bv) || rv === undefined) { out[k] = lv; continue; }   // only changed here
		// Changed on both sides.
		if (KEYED_LISTS[k] && Array.isArray(lv) && Array.isArray(rv)) {
			out[k] = mergeKeyedList(KEYED_LISTS[k], Array.isArray(bv) ? bv : [], lv, rv);
		} else if (isPlainObject(lv) && isPlainObject(rv)) {
			out[k] = mergeObject(isPlainObject(bv) ? bv : {}, lv, rv);
		} else {
			out[k] = lv;
		}
	}
	return out;
}

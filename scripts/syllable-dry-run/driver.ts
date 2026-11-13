/**
 * PROP-8 rollout step 3, the dry run (TS half). See run.sh for how to invoke it.
 *
 * For every stored piece document in a directory, two serializations side by side:
 *   A = origin/main's model: load -> save        (today's production client)
 *   B = this branch's model: load -> heal -> save (dual-write, tier persisted)
 * GATE: B's legacy fields (the nine wire fields and the '0.00'/'1.00' consonant
 * articulations) equal A's byte-for-byte on every row-0 trajectory of every piece.
 * Trajectories are matched by position (track, phrase, index), so a uniqueId the
 * loader had to invent (random on each side) does not matter.
 *
 * Reported, not gated: A vs the raw stored bytes per field (today's own load ->
 * save normalization), counts of '' and null phonetic fields, non-vocal tracks
 * carrying phonetic fields, invariant violations in B, and B with the flag off
 * (what the web app does until the flag is on) vs A.
 *
 * Input: *.json files, each one document or an array of documents, or *.jsonl
 * (one document per line, e.g. mongoexport). Never point it at production: run
 * it on a dump.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { checkInvariants, splitViolations, VOCAL_INSTRUMENTS, WIRE_FIELDS } from '../../shared/syllables';

type Side = { loadSave(doc: any, mode: string): { out: any; violations: [string, string][] | null } };

const LEGACY_KEYS = [...WIRE_FIELDS, 'art0', 'art1'] as const;
const PHONETIC = ['vowel', 'startConsonant', 'endConsonant'] as const;

function args() {
  const a = process.argv.slice(2);
  const opt: { [k: string]: string } = {};
  const pos: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i];
    else pos.push(a[i]);
  }
  if (!opt.a || !opt.b || pos.length !== 1) {
    console.error('usage: driver.cjs --a a.cjs --b b.cjs [--report out.json] [--max-examples N] <dir>');
    process.exit(2);
  }
  return { ...opt, dir: pos[0] };
}

function* documents(dir: string): Generator<{ file: string; doc: any }> {
  const files = readdirSync(dir).filter(f => /\.(json|jsonl)$/.test(f) && statSync(path.join(dir, f)).isFile()).sort();
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    if (f.endsWith('.jsonl')) {
      let n = 0;
      for (const line of text.split('\n')) if (line.trim()) yield { file: `${f}:${++n}`, doc: JSON.parse(line) };
      continue;
    }
    const parsed = JSON.parse(text);
    // contract fixtures wrap the piece (pieceJson / cases[].pieceJson)
    if (parsed && parsed.pieceJson) yield { file: f, doc: parsed.pieceJson };
    else if (parsed && Array.isArray(parsed.cases)) {
      for (const c of parsed.cases) if (c.pieceJson) yield { file: `${f}#${c.name}`, doc: c.pieceJson };
    } else if (Array.isArray(parsed)) {
      let n = 0;
      for (const d of parsed) yield { file: `${f}[${n++}]`, doc: d };
    } else if (parsed && (Array.isArray(parsed.phraseGrid) || Array.isArray(parsed.phrases))) {
      yield { file: f, doc: parsed };
    } else {
      // never drop a file silently: an unreadable shape is reported as a failure
      yield { file: f, doc: parsed, unrecognized: true } as any;
    }
  }
}

/** The track grid of a stored document; the oldest documents have only `phrases` (track 0). */
function gridOf(doc: any): any[][] {
  if (Array.isArray(doc?.phraseGrid)) return doc.phraseGrid;
  if (Array.isArray(doc?.phrases)) return [doc.phrases];
  return [];
}

/** The legacy fields of every row-0 trajectory, by position, as emitted (bytes). */
function legacyByPosition(json: any): Map<string, { [k: string]: string | undefined }> {
  const out = new Map();
  gridOf(json).forEach((track: any[], k: number) => (track || []).forEach((ph: any, pi: number) => {
    ((ph?.trajectoryGrid || [])[0] || []).forEach((t: any, ti: number) => {
      const r: { [k: string]: string | undefined } = {};
      for (const f of WIRE_FIELDS) {
        // null == absent (SYL-1): a null and a missing field are the same reading
        r[f] = t[f] === undefined || t[f] === null ? undefined : JSON.stringify(t[f]);
      }
      const arts = t.articulations || {};
      for (const [key, name] of [['0.00', 'art0'], ['1.00', 'art1']]) {
        const a = arts[key];
        r[name] = a && a.name === 'consonant' ? JSON.stringify(a) : undefined;
      }
      out.set(`track ${k} phrase ${pi} traj ${ti}`, r);
    });
  }));
  return out;
}

function compare(x: any, y: any) {
  const a = legacyByPosition(x);
  const b = legacyByPosition(y);
  const diffs: { where: string; field: string; a?: string; b?: string }[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const where of keys) {
    const ra = a.get(where);
    const rb = b.get(where);
    if (!ra || !rb) {
      diffs.push({ where, field: '(trajectory)', a: ra ? 'present' : 'absent', b: rb ? 'present' : 'absent' });
      continue;
    }
    for (const f of LEGACY_KEYS) if (ra[f] !== rb[f]) diffs.push({ where, field: f, a: ra[f], b: rb[f] });
  }
  return diffs;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const inc = (m: { [k: string]: number }, k: string, n = 1) => { m[k] = (m[k] || 0) + n; };

function main() {
  const opt = args();
  const A: Side = require(path.resolve(opt.a));
  const B: Side = require(path.resolve(opt.b));
  const maxEx = Number(opt['max-examples'] ?? 20);

  const totals = {
    pieces: 0, trajectories: 0,
    gateFailPieces: 0, gateFailPiecesWithStoredTier: 0, gateDiffs: 0, gateDiffsByField: {} as { [k: string]: number },
    aFailed: 0, bFailed: 0, unrecognized: 0,
    aVsRawDiffsByField: {} as { [k: string]: number }, aVsRawPieces: 0,
    flagOffVsADiffs: 0, flagOffVsAPieces: 0, flagOffSyllableKeys: 0,
    emptyString: {} as { [k: string]: number }, nulls: {} as { [k: string]: number },
    nonVocalPhoneticTracks: 0, nonVocalPhoneticPieces: 0,
    violationsByCode: {} as { [k: string]: number }, piecesWithErrors: 0,
    storedTrajsWithoutUid: 0, piecesWithStoredTrajsWithoutUid: 0,
  };
  const examples: any = { gate: [], aVsRaw: [], flagOff: [], failures: [], nonVocal: [], violations: [] };
  const push = (k: string, x: any) => { if (examples[k].length < maxEx) examples[k].push(x); };

  for (const item of documents(opt.dir)) {
    const { file, doc } = item;
    totals.pieces++;
    if ((item as any).unrecognized) {
      totals.unrecognized++;
      push('failures', { id: file, side: 'input', error: 'not a piece document (no phraseGrid or phrases array)' });
      continue;
    }
    const id = `${file} (${String(doc._id?.$oid ?? doc._id ?? "-")})`;

    // raw-input statistics
    gridOf(doc).forEach((track: any[], k: number) => {
      let phonetic = false;
      (track || []).forEach((ph: any) => ((ph?.trajectoryGrid || [])[0] || []).forEach((t: any) => {
        for (const f of PHONETIC) {
          if (t[f] === '') inc(totals.emptyString, f);
          if (t[f] === null) inc(totals.nulls, f);
          if (t[f] !== undefined && t[f] !== null) phonetic = true;
        }
      }));
      const instr = (doc.instrumentation || [])[k];
      if (phonetic && instr !== undefined && !VOCAL_INSTRUMENTS.includes(instr)) {
        totals.nonVocalPhoneticTracks++;
        push('nonVocal', { id, track: k, instrumentation: instr });
      }
    });
    if (gridOf(doc).some((track: any[], k: number) => {
      const instr = (doc.instrumentation || [])[k];
      return instr !== undefined && !VOCAL_INSTRUMENTS.includes(instr) && (track || []).some((ph: any) =>
        ((ph?.trajectoryGrid || [])[0] || []).some((t: any) => PHONETIC.some(f => t[f] !== undefined && t[f] !== null)));
    })) totals.nonVocalPhoneticPieces++;

    let a: any, b: any, bOff: any;
    try { a = A.loadSave(clone(doc), 'A').out; } catch (e) {
      totals.aFailed++; push('failures', { id, side: 'A', error: String(e) });
    }
    try { b = B.loadSave(clone(doc), 'B'); } catch (e) {
      totals.bFailed++; push('failures', { id, side: 'B', error: String(e) });
    }
    try { bOff = B.loadSave(clone(doc), 'B-flag-off').out; } catch (e) {
      push('failures', { id, side: 'B-flag-off', error: String(e) });
    }
    totals.trajectories += legacyByPosition(doc).size;

    if (a) {
      const raw = compare(doc, a);
      if (raw.length) totals.aVsRawPieces++;
      raw.forEach(d => inc(totals.aVsRawDiffsByField, d.field));
      if (raw.length) push('aVsRaw', { id, diffs: raw.slice(0, 5) });
    }
    if (a && b) {
      const gate = compare(a, b.out);
      if (gate.length) {
        totals.gateFailPieces++;
        // A piece that already carries a stored tier (written by a 0.3.0 client)
        // is projected from it by design, so stale legacy fields there differ
        // from A on purpose. Legacy-only pieces must show none.
        const tiered = gridOf(doc).some((tr: any[]) => (tr || []).some((ph: any) => ph && Array.isArray(ph.syllables)));
        if (tiered) totals.gateFailPiecesWithStoredTier++;
        totals.gateDiffs += gate.length;
        gate.forEach(d => inc(totals.gateDiffsByField, d.field));
        push('gate', { id, diffs: gate.slice(0, 10) });
      }
    }
    if (a && bOff) {
      const off = compare(a, bOff);
      if (off.length) { totals.flagOffVsAPieces++; totals.flagOffVsADiffs += off.length; push('flagOff', { id, diffs: off.slice(0, 5) }); }
      const keyed = (bOff.phraseGrid || []).flat().filter((ph: any) => ph && 'syllables' in ph).length;
      const stored = gridOf(doc).flat().filter((ph: any) => ph && 'syllables' in ph).length;
      // the flag is "system present": without it, a save must not create the tier
      if (!doc.system && keyed > stored) totals.flagOffSyllableKeys += keyed - stored;
    }
    if (b) {
      // As the contract does: invariants of B's saved piece, i.e. after the loader
      // assigned ids. Stored trajectories that lacked one are counted separately.
      const loadUidMissing = (b.violations ?? []).filter(v => v[0] === 'traj-uid-missing').length;
      totals.storedTrajsWithoutUid += loadUidMissing;
      if (loadUidMissing) totals.piecesWithStoredTrajsWithoutUid++;
      let found: [string, string][] = [];
      try { found = checkInvariants(b.out); } catch (e) { push('failures', { id, side: 'B-invariants', error: String(e) }); }
      const [errors] = splitViolations(found);
      if (errors.length) totals.piecesWithErrors++;
      found.forEach(([code]) => inc(totals.violationsByCode, code));
      if (found.length) push('violations', { id, violations: found.slice(0, 10) });
    }
  }

  if (totals.pieces === 0) {
    console.error(`no piece documents found in ${opt.dir}`);
    process.exit(2);
  }
  const gatePass = totals.gateFailPieces === 0 && totals.bFailed === 0 && totals.aFailed === 0
    && totals.unrecognized === 0
    && totals.flagOffSyllableKeys === 0;
  const report = { gatePass, totals, examples };
  if (opt.report) writeFileSync(opt.report, JSON.stringify(report, null, 2));

  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(40)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  console.log(`PROP-8 dry run (TS): ${totals.pieces} pieces, ${totals.trajectories} row-0 trajectories`);
  console.log('GATE (B legacy fields == A, byte-for-byte)');
  line('pieces with diffs', totals.gateFailPieces);
  line('  of which arrived with a stored tier', totals.gateFailPiecesWithStoredTier);
  line('  of which legacy-only', totals.gateFailPieces - totals.gateFailPiecesWithStoredTier);
  line('diffs', totals.gateDiffs);
  line('diffs by field', totals.gateDiffsByField);
  line('A failed to load/save', totals.aFailed);
  line('B failed to load/save', totals.bFailed);
  line('files that are not piece documents', totals.unrecognized);
  line('flag off: phrases that gained syllables', totals.flagOffSyllableKeys);
  console.log('REPORTED (not gated)');
  line('A vs raw: pieces changed by load->save', totals.aVsRawPieces);
  line('A vs raw: diffs by field', totals.aVsRawDiffsByField);
  line("'' phonetic fields", totals.emptyString);
  line('null phonetic fields', totals.nulls);
  line('non-vocal tracks with phonetic fields', totals.nonVocalPhoneticTracks);
  line('B flag off vs A: pieces with diffs', totals.flagOffVsAPieces);
  line('B invariant violations by code', totals.violationsByCode);
  line('B pieces with invariant errors', totals.piecesWithErrors);
  line('stored row-0 trajs without uniqueId', `${totals.storedTrajsWithoutUid} in ${totals.piecesWithStoredTrajsWithoutUid} pieces (ids assigned on load)`);
  console.log(gatePass ? 'GATE PASS' : 'GATE FAIL');
  if (opt.report) console.log(`report: ${path.resolve(opt.report)}`);
  process.exit(gatePass ? 0 : 1);
}

main();

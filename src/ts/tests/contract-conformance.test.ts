/**
 * Conformance tests against the idtap-contract golden fixtures.
 *
 * Loads the language-neutral fixtures from the sibling `idtap-contract` repo and
 * asserts the TypeScript model reproduces the expected values. TS is the
 * reference implementation for the frequency chain, so these should pass; they
 * guard against future TS regressions and are the mirror of the Python suite.
 *
 * Fixtures: sibling `../idtap-contract/fixtures` (override IDTAP_CONTRACT_DIR).
 */
import { expect, describe, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pitch, Raga, Trajectory, Phrase, Piece } from '../model';
import {
  PACKS, legacySafe, legacyOfTraj, splitViolations, checkInvariants, deriveIpa,
  derivedTone, stripSyllables, trackFlat, uidOf, CONTRACT_VERSION as SHARED_CONTRACT_VERSION,
} from '@shared/syllables';

const CONTRACT = process.env.IDTAP_CONTRACT_DIR
  || path.resolve(process.cwd(), '..', 'idtap-contract');

// The contract version this model was built against. contract.json `version` must
// match it exactly (idtap-contract README "Versioning"): a minor bump changes wire
// semantics and needs the matching heal here before the assertion is moved.
const CONTRACT_VERSION = '0.3.0';

// The fixtures live in the (private) sibling idtap-contract repo. When it isn't
// present — e.g. a plain `pnpm test` in CI without the contract checkout — degrade
// gracefully to zero fixtures so this file doesn't error out the whole suite. A
// dedicated conformance job sets REQUIRE_CONTRACT=1 to hard-fail if they're missing
// (see the guard at the bottom).
const HAVE_CONTRACT = (() => {
  try { readdirSync(path.join(CONTRACT, 'fixtures')); return true; } catch { return false; }
})();

function fixtures(entity: string): { name: string; fx: any }[] {
  if (!HAVE_CONTRACT) return [];
  const dir = path.join(CONTRACT, 'fixtures', entity);
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => ({ name: f, fx: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

const rel = (a: number, b: number, r: number) =>
  Math.abs(a - b) <= r * Math.max(Math.abs(a), Math.abs(b), 1e-12);

function flat(arr: any[]): number[] {
  return arr.flatMap(e => (Array.isArray(e) ? e : [e]));
}

describe('pitch conformance', () => {
  for (const { name, fx } of fixtures('pitch')) {
    it(name, () => {
      const ctx = fx.context ?? {};
      const p = Pitch.fromJSON(fx.pitchJson, ctx.ratios, ctx.fundamental);
      const r = fx.tolerance?.rel ?? 1e-9;
      expect(rel(p.frequency, fx.expected.frequency, r)).toBe(true);
      expect(rel(p.logFreq, fx.expected.logFreq, r)).toBe(true);
      expect(p.numberedPitch).toBe(fx.expected.numberedPitch);
      expect(p.chroma).toBe(fx.expected.chroma);
      expect(p.sargamLetter).toBe(fx.expected.sargamLetter);
    });
  }
});

describe('raga conformance', () => {
  for (const { name, fx } of fixtures('raga')) {
    it(name, () => {
      const raga = Raga.fromJSON(fx.ragaJson);
      const r = fx.tolerance?.rel ?? 1e-9;
      const got = flat(raga.stratifiedRatios as any);
      const want = flat(fx.expected.stratifiedRatios);
      expect(got.length).toBe(want.length);
      got.forEach((g, i) => expect(rel(g, want[i], r)).toBe(true));
      expect(raga.fundamental).toBe(fx.expected.fundamental);
    });
  }
});

describe('trajectory conformance', () => {
  for (const { name, fx } of fixtures('trajectory')) {
    it(name, () => {
      const ctx = fx.context ?? {};
      const t = Trajectory.fromJSON(fx.trajectoryJson, ctx.ratios, ctx.fundamental);
      const r = fx.tolerance?.rel ?? 1e-9;
      const got = t.pitches.map(p => p.frequency);
      expect(got.length).toBe(fx.expected.pitchFrequencies.length);
      got.forEach((g, i) => expect(rel(g, fx.expected.pitchFrequencies[i], r)).toBe(true));
      expect(t.id).toBe(fx.expected.id);
      // PROP-6 vibrato blocks (contract 0.2.0), each asserted only when present.
      // expected.attach / expected.v1Equivalent are informational and not checked.
      if (fx.expected.vibObj !== undefined) {
        const keys = ['rate', 'extentStart', 'extentEnd', 'vertOffset', 'phase'] as const;
        expect(Object.keys(t.vibObj).sort()).toEqual([...keys].sort());
        keys.forEach(k => expect(rel(t.vibObj[k], fx.expected.vibObj[k], r)).toBe(true));
      }
      if (fx.expected.curveX !== undefined) {
        expect(fx.expected.curveFrequencies.length).toBe(fx.expected.curveX.length);
        fx.expected.curveX.forEach((x: number, i: number) => {
          expect(rel(t.compute(x), fx.expected.curveFrequencies[i], r)).toBe(true);
        });
      }
      if (fx.expected.vibObjInCanonical !== undefined) {
        const canonical = JSON.parse(JSON.stringify(t.toJSON()));
        expect('vibObj' in canonical).toBe(fx.expected.vibObjInCanonical);
      }
    });
  }
});

describe('phrase conformance', () => {
  for (const { name, fx } of fixtures('phrase')) {
    it(name, () => {
      const ctx = fx.context ?? {};
      const ph = Phrase.fromJSON(fx.phraseJson, ctx.ratios, ctx.fundamental);
      const r = fx.tolerance?.rel ?? 1e-9;
      const got = ph.trajectoryGrid.flatMap(row => row.flatMap(t => t.pitches.map(p => p.frequency)));
      expect(got.length).toBe(fx.expected.pitchFrequencies.length);
      got.forEach((g, i) => expect(rel(g, fx.expected.pitchFrequencies[i], r)).toBe(true));
    });
  }
});

describe('piece conformance', () => {
  for (const { name, fx } of fixtures('piece')) {
    it(name, () => {
      const piece = Piece.fromJSON(fx.pieceJson);
      const r = fx.tolerance?.rel ?? 1e-9;
      // Melodic pitches only: exclude id-12 (Silent) trajectories. TS synthesizes
      // a silent second string via ensureStringSynchronization (Python doesn't —
      // see STRING-SYNC divergence); silent trajs carry no melodic frequency.
      const got = piece.phraseGrid.flatMap(phrases =>
        phrases.flatMap(ph => ph.trajectoryGrid.flatMap(row =>
          row.filter(t => t.id !== 12).flatMap(t => t.pitches.map(p => p.frequency)))));
      expect(got.length).toBe(fx.expected.allPitchFrequencies.length);
      got.forEach((g, i) => expect(rel(g, fx.expected.allPitchFrequencies[i], r)).toBe(true));
    });
  }
});

// ---------------------------------------------------------------- PROP-7/8/9 (0.3.0)
// conformance/README.md "Syllable tier, system, packs". Every case runs the real
// model: Piece.fromJSON (heal on load) and Piece.toJSON (re-home + dual-write).

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Serialize as a 0.3.0 save does; `all` persists the tier on every phrase. */
function save(piece: Piece, all = false): any {
  if (all) piece.persistSyllables = 'all';
  return JSON.parse(JSON.stringify(piece));
}

/** {uid: legacy fields} over row 0 of a serialized piece. */
function legacyByUid(json: any) {
  const out: { [uid: string]: any } = {};
  for (const tr of json.phraseGrid) for (const [, , t] of trackFlat(tr)) out[uidOf(t)] = legacyOfTraj(t);
  return out;
}

const syllableGrid = (json: any) => json.phraseGrid.map((tr: any[]) => tr.map(ph => ph.syllables));
const loadViolations = (piece: Piece) => splitViolations(piece.syllableViolations);

function expectGuardAndViolations(json: any, violations: [string[], string[]], exp: any) {
  expect(legacySafe(json)).toEqual([exp.legacySafe, exp.legacySafeReasons]);
  expect(violations).toEqual([exp.violations, exp.warnings ?? []]);
}

describe('syllable conformance (PROP-8)', () => {
  for (const { name, fx } of fixtures('syllable')) {
    const exp = fx.expected;
    if (fx.kind === 'heal') {
      it(`${name} (heal)`, () => {
        const piece = Piece.fromJSON(clone(fx.pieceJson));
        // The guard reads the stored legacy fields: evaluate it on the piece as
        // stored, carrying the tier the loader built (healed, not yet projected).
        const loaded = clone(fx.pieceJson);
        const tier = piece.syllablesByPhrase();
        loaded.phraseGrid.forEach((tr: any[], k: number) => tr.forEach((ph, pi) => {
          ph.syllables = clone(tier[k][pi]);
        }));
        const out = save(piece, true);
        expect(syllableGrid(out)).toEqual(exp.syllables);
        const after = legacyByUid(out);
        if (exp.legacyRoundTrip) {
          // Over the input's trajectories: today's loader also appends a trailing
          // silence where a track is shorter than the piece (A does the same).
          const want = legacyByUid(fx.pieceJson);
          expect(Object.fromEntries(Object.keys(want).map(u => [u, after[u]]))).toEqual(want);
        }
        for (const [uid, want] of Object.entries(exp.legacyAfterProjection ?? {})) {
          expect(after[uid]).toEqual(want);
        }
        expectGuardAndViolations(loaded, loadViolations(piece), exp);
        // ...and once a 0.3.0 client has saved it (dual-write), the stored legacy
        // fields are the projection: a Hindi piece without non-legacy fields is safe.
        if (exp.legacySafeReasons.every((r: string) => r === 'boundary')) {
          expect(legacySafe(out)).toEqual([true, []]);
        }
      });
    } else if (fx.kind === 'project') {
      it(`${name} (project)`, () => {
        const piece = Piece.fromJSON(clone(fx.pieceJson));
        const out = save(piece);
        expect(legacyByUid(out)).toEqual(exp.legacy);
        const syls = out.phraseGrid.flatMap((tr: any[]) => tr.flatMap(ph => ph.syllables));
        expect(syls.map((s: any) => deriveIpa(s, piece.pack!))).toEqual(exp.derivedIpa);
        if (exp.nineTone !== undefined) {
          expect(syls.map((s: any) => derivedTone(s, piece.pack!))).toEqual(exp.nineTone);
        }
        expectGuardAndViolations(out, loadViolations(piece), exp);
      });
    } else if (fx.kind === 'rehome') {
      it(`${name} (rehome)`, () => {
        // The edit as the editor makes it: the trajectories are regrouped into
        // new phrases in memory; the tier (the piece's pool) is untouched.
        const before = Piece.fromJSON(clone(fx.pieceJson));
        const beforeOut = save(before);
        const after = Piece.fromJSON(stripSyllables(clone(fx.pieceAfterEdit)));
        after.syllablePool = before.syllablePool;
        after.storedSyllablePhraseUids = new Set(before.storedSyllablePhraseUids);
        after.storedSyllableTrajUids = new Set(before.storedSyllableTrajUids);
        const { dropped } = after.syncSyllables();
        const out = save(after);
        expect(syllableGrid(out)).toEqual(exp.syllables);
        expect(dropped).toEqual(exp.dropped);
        if (exp.legacyUnchanged) expect(legacyByUid(out)).toEqual(legacyByUid(beforeOut));
        expectGuardAndViolations(out, splitViolations(checkInvariants(out)), exp);
      });
    } else if (fx.kind === 'invariants') {
      for (const c of fx.cases) {
        it(`${name}: ${c.name}`, () => {
          const piece = Piece.fromJSON(clone(c.pieceJson));
          expect(loadViolations(piece)).toEqual([c.expected.violations, c.expected.warnings ?? []]);
        });
      }
    } else if (fx.kind === 'guard') {
      for (const c of fx.cases) {
        it(`${name}: ${c.name}`, () => {
          expect(legacySafe(c.pieceJson)).toEqual([c.expected.legacySafe, c.expected.legacySafeReasons]);
        });
      }
    } else {
      it(`${name}: unknown kind ${fx.kind}`, () => { expect.fail(`unknown kind ${fx.kind}`); });
    }
  }
});

describe('system conformance (PROP-7)', () => {
  for (const { name, fx } of fixtures('system')) {
    it(name, () => {
      const exp = fx.expected;
      const piece = Piece.fromJSON(clone(fx.pieceJson));
      expect(piece.resolvedSystem).toEqual(exp.resolved);
      expect(piece.pack?.id).toBe(exp.pack);
      expect(piece.syllableTierEnabled).toBe(exp.syllableUi);
      expect(loadViolations(piece)).toEqual([exp.violations, exp.warnings ?? []]);
      const out = save(piece);
      // unknown ids and components are kept verbatim
      if ('system' in fx.pieceJson) expect(out.system).toEqual(fx.pieceJson.system);
      else expect('system' in out).toBe(false);
      if (exp.derivedIpa !== undefined) {
        const syls = piece.syllablesByPhrase()[0][0];
        expect(syls.map(s => deriveIpa(s, piece.pack!))).toEqual(exp.derivedIpa);
      }
    });
  }
});

describe('phoneme packs (PROP-9)', () => {
  it.runIf(HAVE_CONTRACT)('bundled packs equal the contract packs', () => {
    const dir = path.join(CONTRACT, 'packs');
    const ids = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    expect(Object.keys(PACKS).sort()).toEqual(ids.sort());
    for (const id of ids) {
      expect(PACKS[id]).toEqual(JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8')));
    }
  });
  it('the header version and the conformance version agree', () => {
    expect(SHARED_CONTRACT_VERSION).toBe(CONTRACT_VERSION);
  });
});

// When CI sets REQUIRE_CONTRACT=1, the idtap-contract fixtures MUST be present — fail
// loudly if the checkout is missing rather than silently skipping every case above.
describe('contract fixtures availability', () => {
  it.runIf(process.env.REQUIRE_CONTRACT === '1')(
    'idtap-contract fixtures are present (REQUIRE_CONTRACT=1)',
    () => { expect(HAVE_CONTRACT).toBe(true); },
  );
});

// Exact-match version assertion (README "Versioning"): runs whenever the checkout
// is present, so a contract bump without the matching model change fails here.
describe('contract version', () => {
  it.runIf(HAVE_CONTRACT)(`contract.json version equals CONTRACT_VERSION (${CONTRACT_VERSION})`, () => {
    const contract = JSON.parse(readFileSync(path.join(CONTRACT, 'contract.json'), 'utf8'));
    expect(contract.version).toBe(CONTRACT_VERSION);
  });
});

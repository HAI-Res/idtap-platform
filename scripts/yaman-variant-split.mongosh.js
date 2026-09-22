// Split the DB "Yaman" rule set into Yaman (7 pitches, shuddha Ma only) and a
// variant "Yaman_both_mas" (8 pitches, both Mas), and move every Yaman
// transcription saved with 8 ratios onto the variant.
//
// Background (2026-09-22): on 2025-10-02 the DB Yaman rules were edited to add
// komal ma (8 pitches). Pieces saved before that carry 7 ratios and none of
// them embed a ruleSet, so the editor's load-time DB fetch misaligned them and
// the audio player crashed. See idtap-contract DIVERGENCES.md RAGA-4.
//
// Usage on the production box (read-only dry run first — it is the default):
//   mongosh --quiet --host 127.0.0.1 scripts/yaman-variant-split.mongosh.js
//   APPLY=1 UPDATED_BY=<jon's users._id> mongosh --quiet --host 127.0.0.1 \
//       scripts/yaman-variant-split.mongosh.js
//
// APPLY mode first writes an undo file (/tmp/yaman-split-undo-<ts>.json) with
// the untouched ragas doc and every transcription it is about to rename.
// Idempotent: re-running after APPLY changes nothing.

const APPLY = process.env.APPLY === '1';
const UPDATED_BY = process.env.UPDATED_BY || null;
const BASE = 'Yaman';
const VARIANT = 'Yaman_both_mas';

const yaman7 = {
  sa: true,
  re: { lowered: false, raised: true },
  ga: { lowered: false, raised: true },
  ma: { lowered: false, raised: true },
  pa: true,
  dha: { lowered: false, raised: true },
  ni: { lowered: false, raised: true },
};
const yaman8 = Object.assign({}, yaman7, { ma: { lowered: true, raised: true } });

const swara = db.getSiblingDB('swara');
const numPitches = rules => Object.values(rules).reduce((a, v) =>
  a + (typeof v === 'boolean' ? (v ? 1 : 0) : (v.lowered ? 1 : 0) + (v.raised ? 1 : 0)), 0);

const users = {};
swara.users.find({}, { name: 1, email: 1 }).forEach(u => { users[String(u._id)] = u.name || u.email; });

// --- current state -------------------------------------------------------
const base = swara.ragas.findOne({ name: BASE });
const variant = swara.ragas.findOne({ name: VARIANT });
print(`ragas.${BASE}: ${base ? numPitches(base.rules) + ' pitches, updated ' + base.updatedDate : 'MISSING'}`);
print(`ragas.${VARIANT}: ${variant ? numPitches(variant.rules) + ' pitches, updated ' + variant.updatedDate : 'absent'}`);

const yamanPieces = swara.transcriptions.find(
  { 'raga.name': BASE },
  { title: 1, userID: 1, dateCreated: 1, 'raga.ratios': 1, 'raga.ruleSet': 1 },
).sort({ dateCreated: 1 }).toArray();

const toMove = [], toKeep = [], odd = [];
yamanPieces.forEach(t => {
  const n = t.raga.ratios ? t.raga.ratios.length : null;
  const row = { _id: String(t._id), title: t.title, by: users[String(t.userID)] || String(t.userID),
    created: t.dateCreated, ratios: n, hasRuleSet: t.raga.ruleSet != null };
  if (n === 8) toMove.push(row); else if (n === 7) toKeep.push(row); else odd.push(row);
});
print(`\n${BASE} transcriptions: ${yamanPieces.length}`);
print(`  keep as ${BASE} (7 ratios): ${toKeep.length}`);
toKeep.forEach(r => print('    ' + JSON.stringify(r)));
print(`  move to ${VARIANT} (8 ratios): ${toMove.length}`);
toMove.forEach(r => print('    ' + JSON.stringify(r)));
if (odd.length) {
  print(`  UNEXPECTED ratio counts (left untouched — look at these): ${odd.length}`);
  odd.forEach(r => print('    ' + JSON.stringify(r)));
}
const embedded = yamanPieces.filter(t => t.raga.ruleSet != null);
if (embedded.length) print(`  note: ${embedded.length} piece(s) already embed a ruleSet; the rename does not touch it`);

if (!APPLY) {
  print('\nDRY RUN — nothing written. Re-run with APPLY=1 UPDATED_BY=<uid> to apply.');
} else {
  // --- undo file -----------------------------------------------------------
  const fs = require('fs');
  const undoPath = `/tmp/yaman-split-undo-${Date.now()}.json`;
  fs.writeFileSync(undoPath, JSON.stringify({
    ragas: { base, variant },
    transcriptions: swara.transcriptions.find(
      { _id: { $in: toMove.map(r => new ObjectId(r._id)) } }, { raga: 1, title: 1 }).toArray(),
  }, null, 2));
  print(`\nundo snapshot: ${undoPath}`);

  const now = new Date();
  // 1. variant: carries the 8-pitch rules that were on Yaman since 2025-10-02
  const v = swara.ragas.updateOne({ name: VARIANT }, {
    $set: { rules: yaman8, updatedDate: now, updatedBy: UPDATED_BY,
      note: `split from ${BASE} on ${now.toISOString()}: the 8-pitch (both Ma) rules ` +
            `${BASE} carried from ${base ? base.updatedDate : '?'}; see idtap-contract RAGA-4` },
  }, { upsert: true });
  print(`ragas.${VARIANT}: matched ${v.matchedCount}, upserted ${v.upsertedCount ? 1 : 0}`);
  // 2. base back to 7 pitches (matches every code default and the 7-ratio pieces)
  const b = swara.ragas.updateOne({ name: BASE }, {
    $set: { rules: yaman7, updatedDate: now, updatedBy: UPDATED_BY },
  }, { upsert: true });
  print(`ragas.${BASE}: matched ${b.matchedCount}, modified ${b.modifiedCount}`);
  // 3. 8-ratio pieces → variant
  const t = swara.transcriptions.updateMany(
    { _id: { $in: toMove.map(r => new ObjectId(r._id)) } },
    { $set: { 'raga.name': VARIANT } },
  );
  print(`transcriptions renamed to ${VARIANT}: ${t.modifiedCount}/${toMove.length}`);
}

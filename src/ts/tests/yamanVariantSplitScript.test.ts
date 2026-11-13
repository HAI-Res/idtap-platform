import { expect, test, describe } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

// Runs scripts/yaman-variant-split.mongosh.js against an in-memory stand-in
// for mongosh's `db`, to pin the review fix: APPLY reruns are no-ops and
// APPLY without UPDATED_BY refuses. What the script migrates is unchanged.

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(
  join(__dirname, '..', '..', '..', 'scripts', 'yaman-variant-split.mongosh.js'), 'utf8');

const yaman7 = {
  sa: true,
  re: { lowered: false, raised: true },
  ga: { lowered: false, raised: true },
  ma: { lowered: false, raised: true },
  pa: true,
  dha: { lowered: false, raised: true },
  ni: { lowered: false, raised: true },
};
const yaman8 = { ...yaman7, ma: { lowered: true, raised: true } };

class Quit extends Error {}

const makeDb = () => {
  const ragas: any[] = [{ name: 'Yaman', rules: yaman8, updatedDate: 'd0', updatedBy: 'u0' }];
  const transcriptions: any[] = [
    { _id: 'a', title: 'seven', userID: 'u', dateCreated: 1, raga: { name: 'Yaman', ratios: Array(7).fill(1) } },
    { _id: 'b', title: 'eight', userID: 'u', dateCreated: 2, raga: { name: 'Yaman', ratios: Array(8).fill(1) } },
  ];
  const writes: string[] = [];
  const cursor = (rows: any[]) => ({
    sort: () => cursor(rows), toArray: () => rows, forEach: (f: any) => rows.forEach(f),
  });
  const swara = {
    users: { find: () => cursor([]) },
    ragas: {
      findOne: (q: any) => ragas.find(r => r.name === q.name) ?? null,
      updateOne: (q: any, u: any) => {
        writes.push(`ragas:${q.name}`);
        let doc = ragas.find(r => r.name === q.name);
        if (!doc) { doc = { name: q.name }; ragas.push(doc); }
        Object.assign(doc, u.$set);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      },
    },
    transcriptions: {
      find: (q: any) => cursor(transcriptions.filter(t =>
        q['raga.name'] ? t.raga.name === q['raga.name'] : q._id.$in.map(String).includes(t._id))),
      updateMany: (q: any, u: any) => {
        writes.push('transcriptions');
        const hit = transcriptions.filter(t => q._id.$in.map(String).includes(t._id));
        hit.forEach(t => { t.raga.name = u.$set['raga.name']; });
        return { modifiedCount: hit.length };
      },
    },
  };
  return { db: { getSiblingDB: () => swara }, ragas, transcriptions, writes };
};

const run = (state: ReturnType<typeof makeDb>, env: Record<string, string>) => {
  const out: string[] = [];
  const undoFiles: string[] = [];
  const ctx = {
    db: state.db,
    process: { env },
    print: (...a: unknown[]) => out.push(a.join(' ')),
    quit: () => { throw new Quit(); },
    ObjectId: class { constructor(public id: string) {} toString() { return this.id; } },
    require: () => ({ writeFileSync: (p: string) => undoFiles.push(p) }),
    Date,
    JSON,
  };
  try {
    vm.runInNewContext(script, ctx);
  } catch (e) {
    if (!(e instanceof Quit)) throw e;
  }
  return { out: out.join('\n'), undoFiles };
};

describe('yaman-variant-split.mongosh.js', () => {
  test('APPLY without UPDATED_BY refuses and writes nothing', () => {
    const st = makeDb();
    const { out, undoFiles } = run(st, { APPLY: '1' });
    expect(out).toMatch(/requires UPDATED_BY/);
    expect(st.writes).toEqual([]);
    expect(undoFiles).toEqual([]);
  });

  test('dry run writes nothing', () => {
    const st = makeDb();
    run(st, {});
    expect(st.writes).toEqual([]);
  });

  test('APPLY migrates once; a rerun is a no-op', () => {
    const st = makeDb();
    const first = run(st, { APPLY: '1', UPDATED_BY: 'jon' });
    expect(st.writes).toEqual(['ragas:Yaman_both_mas', 'ragas:Yaman', 'transcriptions']);
    expect(first.undoFiles).toHaveLength(1);
    const variant = st.ragas.find(r => r.name === 'Yaman_both_mas');
    const stamp = { ...variant };
    expect(st.transcriptions.map(t => t.raga.name)).toEqual(['Yaman', 'Yaman_both_mas']);

    st.writes.length = 0;
    const second = run(st, { APPLY: '1', UPDATED_BY: 'someone-else' });
    expect(second.out).toMatch(/already applied/);
    expect(st.writes).toEqual([]);
    expect(second.undoFiles).toEqual([]);
    expect(st.ragas.find(r => r.name === 'Yaman_both_mas')).toEqual(stamp);
  });
});

// Regression tests for two bugs that together made the transcription list grey out
// rows the user could plainly see and edit (and report "Editable: No" for every row):
//
//   1. FileManager's permission callbacks read $store.state.userID directly, which is
//      still undefined until NavBar's session lookup resolves, instead of the userID
//      FilterableTable passes them (resolved in created() from the store or cookie).
//   2. FilterableTable snapshotted `viewable` once in mounted(), then re-sorted `items`
//      in place, and indexed the stale array with the *display* row index — so the grey
//      flags stayed in the pre-sort order and landed on unrelated rows.

import { describe, it, expect } from 'vitest';
import FilterableTable from '@/comps/FilterableTable.vue';
import FileManager from '@/comps/files/FileManager.vue';
import { SortState } from '@shared/enums';

type Row = {
  _id: string,
  title: string,
  viewedAt: number,
  userID: string,
  explicitPermissions: { edit: string[], view: string[], publicView: boolean },
};

const ME = 'me';

const rows = (): Row[] => [
  // public, viewed long ago
  { _id: 'a', title: 'Alpha', viewedAt: 1, userID: 'someone', 
    explicitPermissions: { edit: [], view: [], publicView: true } },
  // mine + private, viewed most recently
  { _id: 'b', title: 'Beta', viewedAt: 4, userID: ME, 
    explicitPermissions: { edit: [], view: [], publicView: false } },
  // public
  { _id: 'c', title: 'Cappa', viewedAt: 2, userID: 'someone', 
    explicitPermissions: { edit: [], view: [], publicView: true } },
  // mine + private
  { _id: 'd', title: 'Delta', viewedAt: 3, userID: ME, 
    explicitPermissions: { edit: [], view: [], publicView: false } },
];

// Mirrors FileManager's callbacks: identity comes from the argument, not a store.
const canView = (item: Row, userID: string) => {
  const ep = item.explicitPermissions;
  return ep.publicView || item.userID === userID ||
    ep.edit.includes(userID) || ep.view.includes(userID);
};
const canEdit = (item: Row, userID: string) => {
  const ep = item.explicitPermissions;
  return item.userID === userID || ep.edit.includes(userID);
};

const labels = [
  {
    label: 'Title', minWidth: 100, prioritization: 0, growable: true,
    initSortState: SortState.down,
    getDisplay: (item: Row) => item.title,
    sortFunction: (a: Row, b: Row) => a.title.localeCompare(b.title),
  },
  {
    label: 'Viewed', minWidth: 100, prioritization: 1, growable: false,
    initSortState: SortState.down,
    getDisplay: (item: Row) => String(item.viewedAt),
    sortFunction: (a: Row, b: Row) => b.viewedAt - a.viewedAt,
  },
];

// A stand-in for the component instance: real data shape + the component's own
// methods/computeds bound to it, so the sort/filter/mapping code under test is the
// code that actually ships.
const makeInstance = (items: Row[], userID: string) => {
  const opts = FilterableTable as any;
  const inst: any = {
    ...opts.data(),
    labels,
    items,
    userID,
    canView,
    canEdit,
    heightOffset: 0,
    navHeight: 40,
    $emit: () => {},
  };
  Object.entries(opts.methods).forEach(([name, fn]) => {
    inst[name] = (fn as Function).bind(inst);
  });
  Object.defineProperty(inst, 'viewable', {
    get: () => opts.computed.viewable.call(inst),
  });
  inst.sortStates = labels.map(l => l.initSortState);
  return inst;
};

describe('FilterableTable row permissions', () => {
  it('keeps grey-out flags aligned with rows after the list is re-sorted', () => {
    const inst = makeInstance(rows(), ME);
    // what mounted() does: sort by the first column, then re-sort by another one
    inst.toggleSort(0, true);
    inst.toggleSort(1, true);

    // The display is now in "Viewed" order, not title order.
    expect(inst.filteredData.map((r: string[]) => r[0]))
      .toEqual(['Beta', 'Delta', 'Cappa', 'Alpha']);

    // Every rendered row must resolve to its own item's permission.
    inst.filteredData.forEach((_row: string[], rIdx: number) => {
      const item = inst.rowItem(rIdx);
      expect(inst.rowViewable(rIdx)).toBe(canView(item, ME));
    });
  });

  it('resolves rows through itemIdxMapping when a search filters the list', () => {
    const inst = makeInstance(rows(), 'nobody');
    inst.toggleSort(0, true);
    inst.searchQuery = 'a';
    inst.handleSearch();

    inst.filteredData.forEach((_row: string[], rIdx: number) => {
      const item = inst.rowItem(rIdx);
      expect(inst.rowViewable(rIdx)).toBe(canView(item, 'nobody'));
    });
    // A logged-out-ish id still sees the public ones and only those.
    const shown = inst.filteredData.map((_r: string[], i: number) => inst.rowViewable(i));
    expect(shown.filter(Boolean).length).toBe(2);
  });

  it('re-derives viewability from the current item order rather than a snapshot', () => {
    // 'nobody' owns nothing, so only the two public rows are viewable and the flag
    // array genuinely changes shape when the rows are re-ordered.
    const inst = makeInstance(rows(), 'nobody');
    inst.toggleSort(0, true);
    expect(inst.viewable).toEqual([true, false, true, false]);
    inst.toggleSort(1, true);
    expect(inst.viewable).toEqual([false, false, true, true]);
    expect(inst.viewable).toEqual(inst.items.map((i: Row) => canView(i, 'nobody')));
  });
});

describe('FileManager permission callbacks', () => {
  const methods = (FileManager as any).methods;
  const priv: any = {
    _id: 'b', userID: ME,
    explicitPermissions: { edit: [], view: [], publicView: false },
  };

  it('uses the resolved userID when the vuex store has not populated yet', () => {
    const ctx = { userID: ME, $store: { state: { userID: undefined } } };
    expect(methods.permissionToView.call(ctx, priv)).toBe(true);
    expect(methods.permissionToEdit.call(ctx, priv)).toBe(true);
  });

  it('prefers the userID passed in by the table', () => {
    const ctx = { userID: undefined, $store: { state: { userID: undefined } } };
    expect(methods.permissionToView.call(ctx, priv, ME)).toBe(true);
    expect(methods.permissionToEdit.call(ctx, priv, ME)).toBe(true);
    expect(methods.permissionToView.call(ctx, priv, 'other')).toBe(false);
    expect(methods.permissionToEdit.call(ctx, priv, 'other')).toBe(false);
  });
});

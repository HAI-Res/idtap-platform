<template>
  <aside class='picker' aria-label='Sound picker' @keydown.stop>
    <!-- 1. header -->
    <header class='pkHead'>
      <template v-if='lyric.sel.t === "none"'>
        <p>Select a note, then shift-click the last note of the syllable.</p>
      </template>
      <template v-else-if='lyric.sel.t === "run"'>
        <p class='title'>{{ lyric.splitFrom ? 'Second syllable' : 'New syllable' }} · notes {{ runInfo.a }}–{{ runInfo.b }}</p>
        <p class='muted'>{{ runInfo.n }} trajectories · {{ runInfo.dur }} s · your first pick creates one syllable over all of them<span v-if='runInfo.replaces'> · replaces {{ runInfo.replaces }} syllables</span></p>
        <p v-if='lyric.splitFrom' class='muted'>Pick or type it. Esc keeps {{ label(lyric.splitFrom) }} whole.</p>
      </template>
      <template v-else>
        <p class='title'>Syllable {{ sylInfo.i }} of {{ sylInfo.n }} · notes {{ sylInfo.k }}–{{ sylInfo.e }}</p>
        <p v-if='sylInfo.held' class='muted'>Held on to note {{ sylInfo.held }} (hatched) until the next syllable starts.</p>
        <button class='next' @click='lyric.nextSyllable()'>Next syllable ▸</button>
      </template>
    </header>

    <!-- 2. preview -->
    <div class='preview' aria-live='polite'>
      <template v-if='hasParts'>
        <span v-if='preview.script' :class='scriptClass' class='pvScript'>{{ preview.script }}</span>
        <span class='pvRoman'>{{ preview.roman }}<sup v-if='preview.tone'>{{ preview.tone }}</sup><sup v-if='preview.nine'>·{{ preview.nine }}</sup></span>
        <span v-if='preview.ipa' class='muted'>[{{ preview.ipa }}]</span>
      </template>
      <span v-else class='muted'>Nothing picked yet.</span>
    </div>

    <!-- 3. typing -->
    <div class='typing'>
      <input
        ref='typeBox'
        class='typeBox'
        :value='lyric.text'
        :placeholder='placeholder'
        :aria-label='`Type the syllable (${packName})`'
        spellcheck='false' autocomplete='off'
        @input='onInput'
        @keydown='onTypeKey'
        />
      <input
        v-if='packId === "jyutping"'
        class='charBox han'
        :value='currentOrtho'
        placeholder='字'
        aria-label='Character'
        :disabled='lyric.sel.t !== "syllable"'
        @input='lyric.setCharacter(($event.target as HTMLInputElement).value)'
        @keydown.stop
        />
      <p v-if='lyric.textError' class='error'>{{ lyric.textError }}</p>
    </div>

    <!-- confirmation (no undo, so operations that remove a syllable ask) -->
    <div v-if='lyric.confirm' class='confirm' role='alertdialog' aria-live='assertive'>
      <p>{{ lyric.confirm.message }}</p>
      <button @click='lyric.confirmYes()'>{{ lyric.confirm.confirmLabel }}</button>
      <button @click='lyric.confirmNo()'>Cancel</button>
    </div>

    <!-- 4. slot strip -->
    <div class='slots' role='tablist'>
      <button
        v-for='s in lyric.slots' :key='s'
        role='tab'
        :aria-pressed='lyric.openSlot === s'
        :class='{ open: lyric.openSlot === s }'
        @click='lyric.openSlot = s; lyric.version++'
        >
        <span class='slotName'>{{ SLOT_NAME[s] }}</span>
        <span :class='{ needed: lyric.needed(s) }'>{{ slotValue(s) }}</span>
      </button>
    </div>

    <label v-if='packId === "kurmanji" && (lyric.openSlot === "onset" || lyric.openSlot === "coda")' class='cluster'>
      <input type='checkbox' :checked='lyric.cluster' @change='lyric.cluster = ($event.target as HTMLInputElement).checked; lyric.version++' />
      build a cluster: each click adds a letter (now {{ clusterNow }})
    </label>
    <p v-if='packId === "hindi-urdu" && (lyric.openSlot === "onset" || lyric.openSlot === "coda")' class='muted small'>One consonant only.</p>

    <!-- 5. the open slot's list -->
    <div class='list' ref='list'>
      <section v-for='(g, gi) in groups' :key='gi'>
        <h4 v-if='g.name'>{{ g.name }}</h4>
        <button
          v-for='o in g.options' :key='String(o.key)'
          class='opt'
          :data-key='o.key ?? ""'
          :aria-pressed='isOn(o.key)'
          :disabled='!!disabled(o.key)'
          @click='lyric.pick(lyric.openSlot, o.key)'
          >
          <span class='oScript' :class='scriptClass'>
            <template v-if='o.glyph'><svg width='22' height='16' aria-hidden='true'><polyline :points='o.glyph' fill='none' stroke='currentColor' stroke-width='1.6' /></svg></template>
            {{ o.script }}<small v-if='o.sub' class='sub'>{{ o.sub }}</small>
          </span>
          <span class='oRoman'>{{ o.roman }}<small v-if='o.ipa' class='muted'> [{{ o.ipa }}]</small><small v-if='o.chao' class='muted'>&nbsp;{{ o.chao }}</small></span>
          <span class='oHint'>
            <span v-if='o.nine' class='muted'>{{ o.nine }} · </span>
            {{ o.hint }}<span v-if='o.example' class='muted'> e.g. {{ o.example }}</span>
            <span v-if='o.unverified' class='unverified'> unverified</span>
            <span v-if='disabled(o.key)' class='muted'> ({{ disabled(o.key) }})</span>
          </span>
        </button>
      </section>
    </div>

    <div class='tail'>
    <!-- syllable bar (§8.6) -->
    <div v-if='lyric.sel.t === "syllable"' class='sylBar'>
      <p class='muted small'>Starts on note {{ sylInfo.k }} (<code>{{ sylInfo.uid }}</code>, phrase {{ sylInfo.phrase }}) · spans {{ sylInfo.notes }} notes · {{ sylInfo.dur }} s<span v-if='sylInfo.crosses'> · runs over a phrase line</span></p>
      <div class='bar'>
        <button @click='lyric.moveStart(-1)' title='Shift+←'>◂ note</button>
        <button @click='lyric.moveStart(1)' title='Shift+→'>note ▸</button>
        <button @click='lyric.moveMarker(-1)' title='Alt+Shift+←'>◂ ¼</button>
        <button @click='lyric.moveMarker(1)' title='Alt+Shift+→'>¼ ▸</button>
        <button v-if='lyric.marker' @click='lyric.splitNoteHere()' title='Enter'>Split note here</button>
        <button @click='lyric.slash()' title='/'>Split (/)</button>
        <button @click='lyric.merge()' title='Backspace'>Merge into previous (⌫)</button>
      </div>
      <label class='small'><input type='checkbox' :checked='!!(lyric.sel as any).syl.wordStart' @change='lyric.setWordStart(($event.target as HTMLInputElement).checked)' /> begins a word</label>
      <p class='muted small'>lyric vowel <code>{{ (lyric.sel as any).syl.lyric?.vowel ?? '∅' }}</code> · {{ (lyric.sel as any).syl.lyric?.source }}</p>
    </div>

    <!-- status line -->
    <p class='status' :class='{ error: lyric.statusIsError }' aria-live='polite'>{{ lyric.status }}</p>

    <!-- 6. warnings (§9) -->
    <section class='checks' v-if='checks.length'>
      <h4>Checks <span class='muted small'>warnings; they never block a save</span></h4>
      <button v-for='(c, i) in checks' :key='i' class='check' @click='lyric.clickCheck(c)'>
        <code>{{ c.code }}</code> {{ c.text }}
      </button>
    </section>

    <!-- 7. source note -->
    <p class='source muted small'>Script, romanization and IPA: {{ packId }} pack. Hints: unverified drafts.</p>
    </div>
  </aside>
</template>

<script lang='ts'>
import { defineComponent, PropType, computed, ref, watch } from 'vue';
import { Piece } from '@/ts/model';
import { LyricController, Slot } from './lyricController';
import { optionsFor, cycleBeforeCaret } from './pickerOptions';
import { deriveIpa, derivedTone, Syllable } from '@shared/syllables';
import { romanizationOf, devanagariOf } from '@shared/syllableText';

const SLOT_NAME: { [s in Slot]: string } = { onset: 'Onset', nucleus: 'Vowel', coda: 'Ending', tone: 'Tone' };

export default defineComponent({
  name: 'SyllablePicker',
  props: {
    lyric: { type: Object as PropType<LyricController>, required: true },
  },
  emits: ['blurToPlot'],
  setup(props, { emit }) {
    const version = computed(() => props.lyric.version);
    const pack = computed(() => { void version.value; return props.lyric.pack; });
    const packId = computed(() => pack.value?.id ?? '');
    const packName = computed(() => ({ 'hindi-urdu': 'ISO 15919 or Devanagari', jyutping: 'Jyutping with a tone digit', kurmanji: 'Kurmanji Latin' } as any)[packId.value] ?? packId.value);
    const placeholder = computed(() => ({ 'hindi-urdu': 'bā or बा', jyutping: 'si1', kurmanji: 'her' } as any)[packId.value] ?? '');
    const scriptClass = computed(() => ({ 'hindi-urdu': 'deva', jyutping: 'han' } as any)[packId.value] ?? 'lat');
    const label = (s?: Syllable) => Piece.syllableLabel(s);

    const parts = computed(() => { void version.value; return props.lyric.currentParts(); });
    const hasParts = computed(() => Object.values(parts.value).some(v => v !== undefined && !(Array.isArray(v) && !v.length)));
    const checked = computed(() => typeof parts.value.coda === 'string' && (pack.value?.toneSystems?.nine?.checkedCodas ?? []).includes(parts.value.coda));
    const groups = computed(() => { void version.value; return pack.value ? optionsFor(pack.value, props.lyric.openSlot, checked.value) : []; });
    const currentOrtho = computed(() => { void version.value; return props.lyric.sel.t === 'syllable' ? (props.lyric.sel.syl.orthography ?? '') : ''; });

    const preview = computed(() => {
      void version.value;
      const P = pack.value; const p = parts.value as any;
      if (!P) return { roman: '' };
      const roman = romanizationOf(P, p) ?? '';
      const sylLike = { anchor: { traj: '' }, lyric: { vowel: p.nucleus ?? null, source: 'human' }, ...p };
      const script = P.id === 'hindi-urdu' ? (currentOrtho.value || devanagariOf(p))
        : P.id === 'jyutping' ? currentOrtho.value : '';
      const nine = P.id === 'jyutping' && p.tone ? derivedTone(sylLike, P) : undefined;
      return {
        script, roman: P.id === 'jyutping' ? roman.replace(/[1-6]$/, '') : roman,
        tone: P.id === 'jyutping' ? p.tone : undefined, nine: nine && nine !== p.tone ? nine : undefined,
        ipa: deriveIpa(sylLike as any, P) ?? undefined,
      };
    });

    const slotValue = (s: Slot) => {
      const v = (parts.value as any)[s];
      if (props.lyric.needed(s)) return 'needed';
      if (v === undefined || (Array.isArray(v) && !v.length)) return '—';
      return Array.isArray(v) ? v.join('+') : v;
    };
    const clusterNow = computed(() => { const v = (parts.value as any)[props.lyric.openSlot]; return Array.isArray(v) ? v.join('+') : (v ?? '—'); });
    const isOn = (key: string | null) => {
      const v = (parts.value as any)[props.lyric.openSlot];
      if (key === null) return v === undefined;
      return Array.isArray(v) ? v.includes(key) : v === key;
    };
    const disabled = (key: string | null) => props.lyric.disabledReason(props.lyric.openSlot, key, parts.value);

    const runInfo = computed(() => {
      void version.value;
      const r = props.lyric.runRange();
      if (!r) return { a: 0, b: 0, n: 0, dur: '0.00', replaces: 0 };
      const f = props.lyric.flat();
      const dur = f.slice(r[0], r[1] + 1).reduce((a, x) => a + x.traj.durTot, 0);
      const replaces = props.lyric.piece.syllablesStartingInRun(props.lyric.track(), f[r[0]].traj.uniqueId!, f[r[1]].traj.uniqueId!).length;
      return { a: r[0] + 1, b: r[1] + 1, n: r[1] - r[0] + 1, dur: dur.toFixed(2), replaces };
    });
    const sylInfo = computed(() => {
      void version.value;
      const L = props.lyric;
      if (L.sel.t !== 'syllable') return {} as any;
      const syl = L.sel.syl;
      const spans = L.spans().filter(x => !x.frozen);
      const i = spans.findIndex(x => x.syllable === syl);
      const sp = spans[i];
      const f = L.flat();
      const k = f.findIndex(x => x.traj.uniqueId === syl.anchor.traj);
      const e = sp ? f.findIndex(x => x.traj.uniqueId === sp.trajs[sp.trajs.length - 1].uniqueId) : k;
      const runOn = sp ? L.runOnStart(sp) : null;
      const heldK = runOn === null ? 0 : f.findIndex(x => Math.abs(x.start - runOn) < 1e-9);
      return {
        i: i + 1, n: spans.length, k: k + 1, e: e + 1, uid: syl.anchor.traj,
        phrase: (f[k]?.phraseIdx ?? 0) + 1, notes: sp?.trajs.length ?? 0,
        dur: sp ? (sp.end - sp.start).toFixed(2) : '0.00',
        crosses: sp ? new Set(sp.trajs.map(t => f.find(x => x.traj === t)?.phraseIdx)).size > 1 : false,
        held: runOn === null ? 0 : heldK, // L, the last note it was created over (1-based = heldK)
      };
    });
    const checks = computed(() => { void version.value; return props.lyric.checks(); });

    // typing
    const typeBox = ref<HTMLInputElement | null>(null);
    const onInput = (e: Event) => {
      if ((e as InputEvent).isComposing) return;
      props.lyric.input((e.target as HTMLInputElement).value);
    };
    const onTypeKey = (e: KeyboardEvent) => {
      e.stopPropagation(); // box keys never reach the canvas handler
      if (e.isComposing || e.keyCode === 229) return;
      const box = e.target as HTMLInputElement;
      if (e.key === 'Enter') { e.preventDefault(); props.lyric.commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); box.blur(); emit('blurToPlot'); }
      else if (e.key === '`') {
        e.preventDefault();
        const c = cycleBeforeCaret(packId.value, box.value, box.selectionStart ?? box.value.length);
        if (c) { box.value = c.text; box.setSelectionRange(c.caret, c.caret); props.lyric.input(c.text); }
      }
    };
    // mirror the text without moving the caret of the focused box
    watch(() => props.lyric.text, t => {
      const b = typeBox.value;
      if (b && b.value !== t && document.activeElement !== b) b.value = t;
    });

    return {
      SLOT_NAME, version, packId, packName, placeholder, scriptClass, label, parts, hasParts, groups, preview,
      slotValue, clusterNow, isOn, disabled, runInfo, sylInfo, checks, currentOrtho, typeBox, onInput, onTypeKey,
    };
  },
});
</script>

<style scoped>
* { transition: none !important; animation: none !important; }
.picker {
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden !important;
  box-sizing: border-box;
  padding: 8px 10px 8px 10px;
  color: #f1efe8;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  scroll-behavior: auto;
}
.pkHead p { margin: 2px 0; }
.title { font-weight: 600; }
.muted { color: #b8b3a6; }
.small { font-size: 11.5px; }
.error { color: #ff9b8f; }
.needed { color: #ff9b8f; }
.unverified { color: #e3b341; font-size: 11px; }
.preview { margin: 6px 0; min-height: 26px; display: flex; gap: 8px; align-items: baseline; }
.pvScript { font-size: 22px; }
.pvRoman { font-size: 18px; font-family: 'Charis SIL', 'Doulos SIL', 'Gentium Plus', 'Noto Serif', 'DejaVu Serif', 'Arial Unicode MS', 'Times New Roman', serif; }
.typing { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.typeBox { flex: 1; min-width: 120px; font-size: 15px; padding: 3px 5px; }
.charBox { width: 48px; font-size: 18px; text-align: center; }
.slots { display: flex; gap: 2px; margin: 6px 0; }
.slots button {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  background: #2b322d; color: #f1efe8; border: 1px solid #555; padding: 3px 2px; cursor: pointer;
}
.slots button.open { box-shadow: inset 0 -3px 0 #7fb0ea; background: #3a433c; }
.slotName { font-size: 10.5px; color: #b8b3a6; }
.cluster { display: block; margin: 4px 0; font-size: 12px; }
.list h4 { margin: 8px 0 2px 0; font-size: 11.5px; color: #b8b3a6; font-weight: 600; }
.opt {
  display: grid; grid-template-columns: 40px 54px 1fr; gap: 6px; align-items: center;
  width: 100%; min-height: 44px; text-align: left; padding: 3px 4px;
  background: #222823; color: #f1efe8; border: 1px solid #3c443e; margin: 1px 0; cursor: pointer;
}
.opt[aria-pressed='true'] { background: #2f4f73; border-color: #7fb0ea; }
.opt:disabled { color: #7d786d; cursor: default; }
.oScript { font-size: 18px; display: flex; flex-direction: column; align-items: center; line-height: 1.1; }
.sub { font-size: 10.5px; color: #b8b3a6; }
.oRoman { font-family: 'Charis SIL', 'Doulos SIL', 'Gentium Plus', 'Noto Serif', 'DejaVu Serif', 'Arial Unicode MS', 'Times New Roman', serif; font-size: 14px; }
.oHint { font-size: 12px; line-height: 1.3; }
.confirm { background: #3d3424; border: 1px solid #e3b341; padding: 6px; margin: 6px 0; }
.confirm p { margin: 0 0 6px 0; }
.confirm button { margin-right: 6px; }
.sylBar { border-top: 1px solid #444; margin-top: 8px; padding-top: 6px; }
.bar { display: flex; flex-wrap: wrap; gap: 3px; margin: 4px 0; }
.bar button { font-size: 11.5px; padding: 2px 5px; }
.next { margin-top: 4px; }
.status { margin: 8px 0 4px 0; min-height: 1.2em; }
.checks h4 { margin: 8px 0 2px 0; font-size: 12px; }
.check { display: block; width: 100%; text-align: left; background: none; border: none; color: #f1efe8; padding: 2px 0; cursor: pointer; font-size: 12px; }
.check code { color: #e3b341; }
.source { margin-top: 10px; }
.han { font-family: 'Noto Sans HK', 'PingFang HK', 'Hiragino Sans', sans-serif; }
.deva { font-family: 'Noto Sans Devanagari', 'Kohinoor Devanagari', 'Devanagari Sangam MN', sans-serif; }
.lat { font-family: 'Charis SIL', 'Doulos SIL', 'Gentium Plus', 'Noto Serif', 'DejaVu Serif', 'Arial Unicode MS', 'Times New Roman', serif; }
/* header, preview, typing and slots stay put; the option list scrolls on its
   own; the syllable bar, status and checks sit below it (spec §5.1 order) */
.pkHead, .preview, .typing, .confirm, .slots, .cluster { flex: 0 0 auto; }
.list { flex: 1 1 auto; min-height: 120px; overflow-y: auto; scroll-behavior: auto; }
.tail { flex: 0 1 auto; max-height: 38%; overflow-y: auto; scroll-behavior: auto; }
</style>

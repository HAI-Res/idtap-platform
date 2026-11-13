<template>
  <!--
    SPEC-provisional §7: one band per vocal track; the editing track first, full
    height, clickable in lyric mode; others compact and muted. A sticky grid row
    inside the plot's scroll container (like the x axis), drawn with the plot's
    own x scale, so it can never shear against the notes while scrolling.
  -->
  <svg
    class='lyricLane'
    :width='width'
    :height='height'
    role='group'
    aria-label='Sung syllables'
    :key='version'
    >
    <defs>
      <pattern id='lyricHatch' width='7' height='7' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'>
        <rect width='7' height='7' :fill='C.bandA' />
        <line x1='0' y1='0' x2='0' y2='7' :stroke='C.hatch' stroke-width='2' />
      </pattern>
      <clipPath v-for='(s, i) in clips' :key='"c" + i' :id='s.id'>
        <rect :x='s.x' :y='s.y' :width='s.w' :height='s.h' />
      </clipPath>
    </defs>
    <rect x='0' y='0' :width='width' :height='height' :fill='C.bg' />
    <g v-for='band in bands' :key='band.track' :transform='`translate(0, ${band.y})`'>
      <line x1='0' :x2='width' y1='0' y2='0' :stroke='C.line' />
      <text v-if='!band.editing' x='4' :y='band.h - 4' font-size='9' :fill='C.muted' class='trackLabel' opacity='0.8'>{{ band.label }}</text>
      <!-- the selected run -->
      <template v-if='band.editing && runRect'>
        <rect :x='runRect.x' y='1' :width='runRect.w' :height='band.h - 2' :fill='C.sel' />
        <text :x='runRect.x + 3' :y='band.h - 5' font-size='11' :fill='C.muted'>new</text>
      </template>
      <g v-for='(sp, i) in band.spans' :key='i'>
        <rect
          :x='sp.x' y='1' :width='sp.w' :height='band.h - 2'
          :fill='sp.frozen ? C.frozen : sp.selected ? C.sel : (i % 2 ? C.bandB : C.bandA)'
          :class='{ clickable: band.editing && clickable && !sp.frozen }'
          @click='band.editing && clickable && !sp.frozen && $emit("selectSyllable", sp.syl)'
          >
          <title>{{ sp.title }}</title>
        </rect>
        <rect
          v-if='sp.hatchX !== null'
          :x='sp.hatchX' y='1' :width='Math.max(1, sp.x + sp.w - sp.hatchX)' :height='band.h - 2'
          fill='url(#lyricHatch)'
          pointer-events='none'
          >
          <title>held until the next syllable starts</title>
        </rect>
        <text v-if='sp.frozen' :x='sp.x + 3' y='10' font-size='9' :fill='C.muted' pointer-events='none'>frozen</text>
        <g :clip-path='`url(#${sp.clipId})`' pointer-events='none'>
          <template v-if='band.editing && band.kind === "han"'>
            <text :x='sp.x + 3' y='21' font-size='20' class='han' :fill='C.text'>{{ sp.ortho }}</text>
            <polyline v-if='sp.glyph' :points='sp.glyph' :transform='`translate(${sp.x + 5 + 20 * (sp.ortho ? sp.ortho.length : 0)}, 6)`'
              fill='none' :stroke='C.text' stroke-width='1.5' />
            <text :x='sp.x + 3' y='44' font-size='14' class='lat' :fill='C.text'>{{ sp.roman }}<tspan v-if='sp.tone' baseline-shift='super' font-size='10'>{{ sp.tone }}</tspan><tspan v-if='sp.nine' baseline-shift='super' font-size='10'>·{{ sp.nine }}</tspan></text>
          </template>
          <template v-else-if='band.editing'>
            <text v-if='band.devaRow && sp.ortho' :x='sp.x + 3' y='17' font-size='15' class='deva' :fill='C.text'>{{ sp.ortho }}</text>
            <text :x='sp.x + 3' :y='band.devaRow ? 38 : 22' font-size='16' class='lat' :fill='C.text'>{{ sp.roman }}</text>
          </template>
          <text v-else :x='sp.x + 3' y='13' font-size='11' class='lat' :fill='C.muted'>{{ sp.compact }}</text>
        </g>
        <!-- the selected syllable's start: a 2 px line and a 10×14 handle (not draggable) -->
        <template v-if='sp.selected'>
          <line :x1='sp.x' :x2='sp.x' y1='0' :y2='band.h' :stroke='C.selLine' stroke-width='2' />
          <rect :x='sp.x - 5' y='-1' width='10' height='14' :fill='C.selLine' />
        </template>
      </g>
      <!-- split marker -->
      <template v-if='band.editing && markerX !== null'>
        <line :x1='markerX' :x2='markerX' y1='0' :y2='band.h' :stroke='C.error' stroke-dasharray='4 3' stroke-width='2' />
        <text :x='markerX + 3' y='10' font-size='10' :fill='C.error'>split here</text>
      </template>
    </g>
  </svg>
</template>

<script lang='ts'>
import { defineComponent, PropType, computed } from 'vue';
import { Piece } from '@/ts/model';
import { LyricController } from '@/comps/editor/lyric/lyricController';
import { vocalTrack } from '@shared/syllables';

/** Lane colours: light, readable over the editor's palette; no motion anywhere. */
const C = {
  bg: '#fbfaf6', line: '#b9b3a6', text: '#1d1b16', muted: '#6b665b',
  bandA: '#efe9da', bandB: '#e3dcc8', sel: '#c9dcf2', selLine: '#2463a8',
  hatch: '#b9ad8e', frozen: '#d6d6d6', error: '#b3261e',
};

/** Lane band heights (spec §7.1). */
export function laneHeights(piece: Piece, editingTrack: number): { track: number; h: number }[] {
  if (!piece.syllableTierEnabled) return [];
  const ph = piece.resolvedSystem.phonology;
  const tracks = piece.phraseGrid.map((_, k) => k).filter(k => vocalTrack(piece, k));
  tracks.sort((a, b) => (a === editingTrack ? -1 : b === editingTrack ? 1 : a - b));
  return tracks.map(k => {
    if (k !== editingTrack) return { track: k, h: 18 };
    if (ph === 'jyutping') return { track: k, h: 56 };
    const deva = ph === 'hindi-urdu' && piece.syllableSpans(k).some(s => !!s.syllable.orthography);
    return { track: k, h: deva ? 50 : 34 };
  });
}

export default defineComponent({
  name: 'LyricLane',
  props: {
    piece: { type: Object as PropType<Piece>, required: true },
    lyric: { type: Object as PropType<LyricController>, required: true },
    xScale: { type: Function as PropType<(t: number) => number>, required: true },
    width: { type: Number, required: true },
    editingTrack: { type: Number, required: true },
    /** lyric mode is on: the editing band is clickable */
    clickable: { type: Boolean, default: false },
    /** bump to redraw */
    version: { type: Number, default: 0 },
  },
  emits: ['selectSyllable'],
  setup(props) {
    const heights = computed(() => { void props.version; void props.lyric.version; return laneHeights(props.piece, props.editingTrack); });
    const height = computed(() => heights.value.reduce((a, b) => a + b.h, 0));
    const selected = computed(() => { void props.lyric.version; return props.lyric.sel.t === 'syllable' ? props.lyric.sel.syl : null; });

    const chao = (tone?: string) => {
      const P = props.piece.pack;
      const t = tone && P?.tones ? (P.tones as any)[tone] : undefined;
      if (!t?.chao) return undefined;
      const d = String(t.chao).split('').map(Number);
      const y = (l: number) => 16 - (l - 1) * 3.5;
      return d.map((l, i) => `${(i * 16) / Math.max(1, d.length - 1)},${y(l)}`).join(' ');
    };

    const clips: { id: string; x: number; y: number; w: number; h: number }[] = [];
    const bands = computed(() => {
      void props.version; void props.lyric.version;
      clips.length = 0;
      const ph = props.piece.resolvedSystem.phonology;
      let y = 0;
      return heights.value.map(({ track, h }) => {
        const editing = track === props.editingTrack;
        const spans = props.piece.syllableSpans(track).map((sp, i) => {
          const x = props.xScale(sp.start);
          const w = Math.max(2, props.xScale(sp.end) - x);
          const r = props.lyric.displayRomanization(sp.syllable);
          const runOn = editing ? props.lyric.runOnStart(sp) : null;
          const clipId = `lyc-${track}-${i}`;
          clips.push({ id: clipId, x: x + 1, y: 1, w: Math.max(0, w - 2), h: h - 2 }); // band-local
          const ortho = sp.syllable.orthography;
          const roman = r.body + (r.tone ?? '');
          return {
            syl: sp.syllable, x, w, frozen: sp.frozen,
            selected: editing && selected.value === sp.syllable,
            hatchX: runOn === null ? null : props.xScale(runOn),
            roman: r.body, tone: r.tone, nine: r.nine,
            ortho: ph === 'kurmanji' ? undefined : ortho,
            glyph: ph === 'jyutping' ? chao(sp.syllable.tone) : undefined,
            compact: roman,
            clipId,
            title: [ortho && ph !== 'kurmanji' ? ortho : '', roman, r.nine ? `(tone ${r.nine})` : ''].filter(Boolean).join(' '),
          };
        });
        const band = {
          track, h, y, editing, spans,
          kind: ph === 'jyutping' ? 'han' : 'lat',
          devaRow: editing && h === 50,
          label: (props.piece.trackTitles?.[track] || props.piece.instrumentation[track]) + (editing ? '' : ' (view)'),
        };
        y += h;
        return band;
      });
    });

    const runRect = computed(() => {
      void props.lyric.version;
      const r = props.lyric.runRange();
      if (!r) return null;
      const f = props.lyric.flat();
      const a = f[r[0]], b = f[r[1]];
      const x = props.xScale(a.start);
      return { x, w: Math.max(2, props.xScale(b.start + b.traj.durTot) - x) };
    });
    const markerX = computed(() => {
      void props.lyric.version;
      const m = props.lyric.marker;
      if (!m) return null;
      const x = props.lyric.flat().find(y => y.traj.uniqueId === m.trajUid);
      return x ? props.xScale(x.start + m.frac * x.traj.durTot) : null;
    });

    return { C, bands, clips, height, runRect, markerX };
  },
});
</script>

<style scoped>
* { transition: none !important; animation: none !important; }
.lyricLane { display: block; user-select: none; }
.clickable { cursor: pointer; }
.han { font-family: 'Noto Sans HK', 'PingFang HK', 'Hiragino Sans', sans-serif; }
.deva { font-family: 'Noto Sans Devanagari', 'Kohinoor Devanagari', 'Devanagari Sangam MN', sans-serif; }
.lat { font-family: 'Charis SIL', 'Gentium Plus', 'Times New Roman', serif; }
.trackLabel { font-family: system-ui, sans-serif; }
</style>

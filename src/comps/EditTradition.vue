<template>
  <div class='modal' @keydown.stop @click.self='cancel'>
    <div class='editTradition' role='dialog' aria-modal='true' aria-labelledby='editTraditionTitle'>
      <h2 id='editTraditionTitle'>Sung text tradition</h2>
      <p v-if='loading' class='muted'>Loading…</p>
      <template v-else>
        <fieldset :disabled='saving || !editable'>
          <label v-for='opt in OPTIONS' :key='opt.phonology' class='option'>
            <input
              type='radio'
              name='tradition'
              :value='opt.phonology'
              v-model='choice'
              />
            <span>
              <b>{{ opt.label }}</b>
              <span class='muted'>{{ opt.description }}</span>
            </span>
          </label>
        </fieldset>
        <p v-if='refusal' class='warning'>{{ refusal }}</p>
        <p v-else-if='unsavedChanges && changing' class='warning'>
          You have unsaved changes. Save the piece before changing its tradition.
        </p>
        <p v-else class='muted'>
          This sets how sung text is entered on vocal tracks. It can't be removed later.
        </p>
        <p v-if='nonHindustani(choice)' class='muted'>
          The raga row is labelled “Tuning (raga)” for this tradition: pitch is still
          described with a raga for now; other pitch systems come later.
        </p>
        <p v-if='error' class='error'>{{ error }}</p>
      </template>
      <div class='buttonRow'>
        <span v-if='saving' class='muted'>Saving…</span>
        <button @click='cancel' :disabled='saving'>Cancel</button>
        <button @click='save' :disabled='!canSave'>Save</button>
      </div>
    </div>
  </div>
</template>

<script lang='ts'>
import { defineComponent, ref, computed, onMounted } from 'vue';
import { getTranscriptionSystemOptions, updateTranscriptionSystem } from '@/js/serverCalls';

/** The `system` each option writes (SPEC-provisional §3; same table as server/systemRoutes.ts). */
const OPTIONS = [
  { phonology: 'hindi-urdu', label: 'Hindustani', description: ' Devanagari / ISO 15919 (hindi-urdu)',
    system: { phonology: 'hindi-urdu', display: ['sargam', 'Deva'] } },
  { phonology: 'jyutping', label: 'Cantonese', description: ' characters + Jyutping (jyutping)',
    system: { phonology: 'jyutping', display: ['jyutping', 'Hant'] } },
  { phonology: 'kurmanji', label: 'Kurmanji', description: ' Latin (kurmanji)',
    system: { phonology: 'kurmanji', display: ['kurmanji-latin'] } },
];

export default defineComponent({
  name: 'EditTradition',
  props: {
    pieceId: { type: String, required: true },
    unsavedChanges: { type: Boolean, default: false },
  },
  emits: ['close', 'updated'],
  setup(props, { emit }) {
    const loading = ref(true);
    const saving = ref(false);
    const error = ref<string | undefined>(undefined);
    const current = ref<string | null>(null);
    const choice = ref<string>('hindi-urdu');
    const editable = ref(false);
    const options = ref<{ [k: string]: { ok: boolean, reason?: string } }>({});

    const changing = computed(() => choice.value !== current.value);
    const refusal = computed(() => {
      const o = options.value[choice.value];
      return changing.value && o && !o.ok ? o.reason : undefined;
    });
    const canSave = computed(() => !loading.value && !saving.value && editable.value
      && !refusal.value && !(props.unsavedChanges && changing.value));
    const nonHindustani = (ph: string) => ph !== 'hindi-urdu';

    onMounted(async () => {
      const r = await getTranscriptionSystemOptions(props.pieceId);
      loading.value = false;
      if ('error' in r) { error.value = r.error; return; }
      current.value = r.system?.phonology ?? null;
      choice.value = current.value ?? 'hindi-urdu';
      editable.value = r.editable;
      options.value = r.options;
      if (!r.editable) error.value = 'You can view this piece but not edit it.';
    });

    const cancel = () => { if (!saving.value) emit('close'); };
    const save = async () => {
      if (!canSave.value) return;
      // re-choosing the current tradition changes nothing
      if (!changing.value) { emit('close'); return; }
      const opt = OPTIONS.find(o => o.phonology === choice.value)!;
      saving.value = true;
      error.value = undefined;
      const r = await updateTranscriptionSystem(props.pieceId, opt.system);
      saving.value = false;
      if ('error' in r) { error.value = r.error; return; }
      emit('updated', r.system);
      emit('close');
    };

    return { OPTIONS, loading, saving, error, choice, editable, changing, refusal, canSave, nonHindustani, cancel, save };
  },
});
</script>

<style scoped>
* { transition: none !important; animation: none !important; }
.modal {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  height: 100vh;
  width: 100vw;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
}
.editTradition {
  width: 440px;
  margin-top: 18vh;
  padding: 16px 20px;
  background-color: lightgrey;
  border: 1px solid black;
  color: black;
}
h2 { margin: 0 0 10px 0; font-size: 18px; }
fieldset { border: none; padding: 0; margin: 0; }
.option { display: flex; gap: 8px; align-items: baseline; margin: 6px 0; cursor: pointer; }
.muted { color: #333; }
.warning { color: #7a4b00; }
.error { color: #a00; }
.buttonRow { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 12px; }
</style>

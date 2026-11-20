<template>
  <div class='modal' @click.self='close'>
    <div class='modal-content'>
      <h3>Transcribe with a model</h3>
      <p class='sub'>{{ recordingTitle }}</p>
      <template v-if='!job'>
        <div class='modalRow'>
          <label for='tm-model'>Model</label>
          <select id='tm-model' v-model='model'>
            <option value='rg_world_tx'>Trajectory model (Hindustani)</option>
            <option value='student'>Student (any tradition)</option>
          </select>
        </div>
        <div class='modalRow'>
          <label for='tm-voice'>Voice</label>
          <select id='tm-voice' v-model='voice'>
            <option value='M'>Vocal (M)</option>
            <option value='F'>Vocal (F)</option>
          </select>
        </div>
        <div class='modalRow'>
          <label for='tm-tonic'>Sa (Hz)</label>
          <input id='tm-tonic' type='number' min='50' max='1000' step='0.1' v-model.number='tonic'
            :placeholder='model === "student" ? "required" : "estimated when empty"' />
        </div>
        <div class='modalRow'>
          <label for='tm-sep'>
            <input id='tm-sep' type='checkbox' v-model='accompanied' />
            The recording has accompaniment (separate the voice first)
          </label>
        </div>
        <p class='note'>
          The result is a new private transcription in your files. The trajectory model writes Hindi vowels;
          the student writes trajectories and syllable starts without text.
        </p>
        <div class='modalRow'>
          <button @click='start' :disabled='starting || !canStart'>Transcribe</button>
          <button @click='close'>Cancel</button>
        </div>
      </template>
      <template v-else>
        <div class='modalRow'><strong>{{ statusLine }}</strong></div>
        <progress v-if='progress' :value='progress.done' :max='progress.total'></progress>
        <div class='modalRow'>
          <button v-if='job.status === "done"' @click='open'>Open the transcription</button>
          <button v-if='active' @click='cancelJob'>Cancel the run</button>
          <button @click='close'>{{ active ? 'Close (it keeps running)' : 'Close' }}</button>
        </div>
      </template>
      <p class='error' v-if='error'>{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  startTranscription, getTranscriptionJob, getTranscriptionJobs, cancelTranscription,
} from '@/js/serverCalls';
import type { TranscribeJob } from '@/js/serverCalls';
import { transcribeStatusLine } from '@/js/transcribeStatus';

const props = defineProps<{
  recId: string,
  recordingTitle: string,
  saEstimate?: number,
  navHeight: number,
}>();
const emit = defineEmits<{ (e: 'close'): void }>();
const router = useRouter();

const model = ref<'rg_world_tx' | 'student'>('rg_world_tx');
const voice = ref<'M' | 'F'>('M');
const tonic = ref<number | undefined>(props.saEstimate || undefined);
const accompanied = ref(true);
const starting = ref(false);
const error = ref('');
const job = ref<TranscribeJob | null>(null);
let timer: number | undefined;

const canStart = computed(() => model.value !== 'student' || (!!tonic.value && tonic.value > 0));
const active = computed(() => job.value?.status === 'queued' || job.value?.status === 'running');
const progress = computed(() => {
  const last = job.value?.events?.[job.value.events.length - 1];
  return job.value?.status === 'running' && last?.event === 'progress' && last.total
    ? { done: Number(last.done), total: Number(last.total) } : null;
});
const statusLine = computed(() => (job.value ? transcribeStatusLine(job.value) : ''));

const poll = async (id: string) => {
  try {
    job.value = await getTranscriptionJob(id);
  } catch (e) {
    error.value = String((e as Error).message || e);
  }
  if (active.value) timer = window.setTimeout(() => poll(id), 2000);
};

const start = async () => {
  starting.value = true;
  error.value = '';
  try {
    const params: Record<string, unknown> = {
      recordingId: props.recId, model: model.value, voice: voice.value, separate: accompanied.value,
      title: props.recordingTitle,
    };
    if (tonic.value) params.tonic = tonic.value;
    const { jobId } = await startTranscription(params);
    await poll(jobId);
  } catch (e) {
    error.value = String((e as Error).message || e);
  } finally {
    starting.value = false;
  }
};

const cancelJob = async () => {
  if (!job.value) return;
  try { await cancelTranscription(job.value._id); await poll(job.value._id); }
  catch (e) { error.value = String((e as Error).message || e); }
};

const open = () => {
  if (job.value?.pieceId) router.push({ name: 'EditorComponent', query: { id: job.value.pieceId } });
};
const close = () => emit('close');

// A run started earlier on this recording and still going: show it instead of the form.
onMounted(async () => {
  try {
    const { jobs } = await getTranscriptionJobs();
    const mine = jobs.find(j => j.recordingId === props.recId && (j.status === 'queued' || j.status === 'running'));
    if (mine) await poll(mine._id);
  } catch { /* the form still works */ }
});
onBeforeUnmount(() => { if (timer) window.clearTimeout(timer); });
</script>

<style scoped>
.modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 3;
  margin-top: v-bind(navHeight + 'px');
}
.modal-content {
  background-color: lightgrey;
  color: black;
  padding: 20px;
  border-radius: 4px;
  width: 520px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
h3 { margin: 0; }
.sub { margin: 0 0 6px 0; }
.modalRow {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.modalRow > label:first-child { width: 80px; text-align: right; }
.modalRow > label[for='tm-sep'] { width: auto; text-align: left; }
.note { font-size: 13px; margin: 4px 0; }
.error { color: darkred; margin: 4px 0 0 0; }
progress { width: 100%; }
</style>

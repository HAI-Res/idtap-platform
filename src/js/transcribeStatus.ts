// The one-line status of a model transcription job, from its status and last event.

export type TranscribeEvent = { event: string, phase?: string, done?: number, total?: number, [k: string]: unknown };
export type TranscribeJobLike = {
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
  events?: TranscribeEvent[],
  error?: { code?: string, message?: string },
};

const PHASES: Record<string, string> = {
  denoise: 'Cleaning the recording…',
  separate: 'Separating the voice…',
  load: 'Reading the recording…',
  hum: 'Checking for hum…',
  tonic: 'Finding Sa…',
  cut: 'Cutting phrases…',
  decode: 'Transcribing…',
};

export function transcribeStatusLine(job: TranscribeJobLike): string {
  switch (job.status) {
    case 'queued': return 'Waiting for a worker…';
    case 'done': return 'Done.';
    case 'cancelled': return 'Cancelled.';
    case 'failed': return `Failed: ${job.error?.message || job.error?.code || 'no reason given'}`;
    default: break;
  }
  const events = job.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === 'progress' && e.total) {
      return Number(e.done) < Number(e.total) ? `Transcribing: part ${Number(e.done) + 1} of ${e.total}…` : 'Writing the transcription…';
    }
    if (e.event === 'phase' && e.phase && PHASES[e.phase]) return PHASES[e.phase];
  }
  return 'Starting…';
}

import { describe, test, expect } from 'vitest';
import { transcribeStatusLine } from '@/js/transcribeStatus';

describe('transcribeStatusLine', () => {
  test('status words', () => {
    expect(transcribeStatusLine({ status: 'queued' })).toBe('Waiting for a worker…');
    expect(transcribeStatusLine({ status: 'done' })).toBe('Done.');
    expect(transcribeStatusLine({ status: 'cancelled' })).toBe('Cancelled.');
    expect(transcribeStatusLine({ status: 'failed', error: { code: 'audio', message: 'no singing found' } })).toBe('Failed: no singing found');
    expect(transcribeStatusLine({ status: 'failed' })).toBe('Failed: no reason given');
  });
  test('a running job shows its latest phase or progress', () => {
    const run = (events: any[]) => transcribeStatusLine({ status: 'running', events });
    expect(run([])).toBe('Starting…');
    expect(run([{ event: 'start' }, { event: 'phase', phase: 'denoise' }])).toBe('Cleaning the recording…');
    expect(run([{ event: 'phase', phase: 'separate' }, { event: 'separated', seconds: 20 }])).toBe('Separating the voice…');
    expect(run([{ event: 'phase', phase: 'decode' }, { event: 'progress', done: 2, total: 8 }])).toBe('Transcribing: part 3 of 8…');
    expect(run([{ event: 'progress', done: 8, total: 8 }])).toBe('Writing the transcription…');
    expect(run([{ event: 'phase', phase: 'unknown-phase' }])).toBe('Starting…');
  });
});

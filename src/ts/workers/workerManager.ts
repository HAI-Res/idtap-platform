import Worker from '@/ts/workers/spectrogramWorker.ts?worker';

let worker: Worker | undefined;
// const workerURL = new URL('@/ts/workers/spectrogramWorker.ts', import.meta.url);
export const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker();
  }
  return worker;
}

/**
 * Start downloading a recording's spectrogram data before the spectrogram
 * controls have mounted. The worker caches the in-flight fetch per audioID, so
 * the later 'initial' message reuses it instead of fetching again.
 */
export const prefetchSpectrogramData = (audioID: string): void => {
  getWorker().postMessage({ msg: 'prefetch', payload: { audioID } });
};

export const resetWorker = (): void => {
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
}

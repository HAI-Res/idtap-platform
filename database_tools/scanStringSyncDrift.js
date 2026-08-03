// Scan all transcriptions for string-sync duration drift: phrases whose
// per-string trajectory durations disagree with the phrase durTot, or whose
// stored phrase durTots disagree with the piece durTot. Read-only.
//
// This is the corruption class behind the spectrogram/audio misalignment on
// 6824de49abc4705438ce918b (a phrase division that never split string 2):
// any secondary string longer than its phrase stretches the whole client-side
// timeline relative to the audio.
//
// Run on the production box:
//   mongosh mongodb://127.0.0.1:27017/swara database_tools/scanStringSyncDrift.js

const TOL = 0.001; // 1 ms

let affectedPieces = 0;
let scanned = 0;

db.transcriptions.find({}, {
  title: 1, name: 1, instrumentation: 1, durTot: 1, phraseGrid: 1,
}).forEach(doc => {
  scanned += 1;
  const issues = [];
  const grid = doc.phraseGrid || [];
  let mainTotal = 0;

  grid.forEach((phrases, trackIdx) => {
    let trackMainTotal = 0;
    (phrases || []).forEach((ph, pIdx) => {
      const strings = ph.trajectoryGrid || [];
      const sums = strings.map(s =>
        (s || []).reduce((a, t) => a + (t.durTot || 0), 0));
      trackMainTotal += ph.durTot || 0;

      sums.forEach((s, si) => {
        if (!strings[si] || strings[si].length === 0) return;
        const diff = s - (ph.durTot || 0);
        if (Math.abs(diff) > TOL) {
          issues.push(
            `  track ${trackIdx} phrase ${pIdx} string ${si}: ` +
            `trajs span ${s.toFixed(4)}s vs phrase durTot ` +
            `${(ph.durTot || 0).toFixed(4)}s (${diff > 0 ? '+' : ''}${diff.toFixed(4)}s)`
          );
        }
      });
    });
    if (trackIdx === 0) mainTotal = trackMainTotal;
  });

  if (Math.abs(mainTotal - (doc.durTot || 0)) > TOL && grid.length > 0) {
    issues.push(
      `  phrase durTots sum to ${mainTotal.toFixed(4)}s vs piece durTot ` +
      `${(doc.durTot || 0).toFixed(4)}s`
    );
  }

  if (issues.length > 0) {
    affectedPieces += 1;
    print(`\n${doc._id} | ${doc.title} | ${doc.name} | ${(doc.instrumentation || []).join(', ')}`);
    issues.forEach(line => print(line));
  }
});

print(`\nscanned ${scanned} transcriptions; ${affectedPieces} with drift > ${TOL * 1000} ms`);

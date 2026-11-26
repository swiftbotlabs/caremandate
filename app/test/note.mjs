// Visit notes for the end-to-end scripts.
//   node test/note.mjs key <visitNo> <oddVisitNo>   -> the fixture key for that visit (normal/normal2/normal3, or "anomalous" for the odd one)
//   node test/note.mjs <key> <unixTime>             -> that fixture note, re-timed to a visit starting at unixTime (Korea time)
import { NOTES, noteFor } from './review-fixtures.mjs';
const [a, b, c] = process.argv.slice(2);
if (a === 'key') { const i = Number(b); console.log(i === Number(c || 0) ? 'anomalous' : ['normal', 'normal2', 'normal3'][(i - 1) % 3]); }
else if (NOTES[a] && /^\d+$/.test(b || '')) console.log(noteFor(a, Number(b)));
else { console.error('usage: note.mjs key <n> <odd> | note.mjs <key> <unixTime>'); process.exit(2); }

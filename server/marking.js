// Auto-marking for objective question kinds. Written answers are NEVER marked
// incorrect automatically — they always wait for teacher review.
//
// Answer shapes (stored per pupil assignment as { [questionId]: value }):
//   choice    -> { [itemIndex]: chosenOption }
//   choicePic -> { [itemIndex]: chosenWord }
//   match     -> { [pairIndex]: chosenWord }
//   arrange   -> "joined word tiles" (string)
//   written   -> "free text" (string)

const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[.!?]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function isObjective(kind) {
  return kind === 'choice' || kind === 'choicePic' || kind === 'match' || kind === 'arrange';
}

// Scoreable units in a snapshot: match=1 per pair, choice/choicePic=1 per item,
// arrange=1, written=1 (reviewed by teacher, not auto-scored).
export function countQuestions(snapshot) {
  let n = 0;
  for (const q of snapshot.questions) {
    if (q.kind === 'choice' || q.kind === 'choicePic') n += q.items.length;
    else if (q.kind === 'match') n += q.pairs.length;
    else n += 1;
  }
  return n;
}

function objectiveUnits(snapshot) {
  let n = 0;
  for (const q of snapshot.questions) {
    if (q.kind === 'choice' || q.kind === 'choicePic') n += q.items.length;
    else if (q.kind === 'match') n += q.pairs.length;
    else if (q.kind === 'arrange') n += 1;
  }
  return n;
}

// Marks a snapshot against an answer object. Returns:
//   score      0..1 over objective units, or null when there are none
//   detail     flat list of per-unit results for the teacher "View work" view
//   needsReview true when any written answer has text
//   written    written answers with prompts
export function markSnapshot(snapshot, answers = {}) {
  const detail = [];
  const written = [];
  let correct = 0;
  let units = 0;

  for (const q of snapshot.questions) {
    const a = answers[q.id];

    if (q.kind === 'choice' || q.kind === 'choicePic') {
      q.items.forEach((item, i) => {
        const chosen = a?.[i] ?? null;
        const ok = chosen !== null && norm(chosen) === norm(item.answer);
        units++; if (ok) correct++;
        detail.push({
          qid: q.id, kind: q.kind, objective: true,
          prompt: item.text || q.prompt,
          picture: q.kind === 'choicePic' ? item.picture : null,
          chosen, expected: item.answer, correct: ok,
        });
      });
    } else if (q.kind === 'match') {
      q.pairs.forEach((pair, i) => {
        const chosen = a?.[i] ?? null;
        const ok = chosen !== null && norm(chosen) === norm(pair.answer);
        units++; if (ok) correct++;
        detail.push({
          qid: q.id, kind: q.kind, objective: true,
          prompt: q.prompt, picture: pair.picture,
          chosen, expected: pair.answer, correct: ok,
        });
      });
    } else if (q.kind === 'arrange') {
      const ok = a != null && norm(a) === norm(q.answer);
      units++; if (ok) correct++;
      detail.push({
        qid: q.id, kind: q.kind, objective: true,
        prompt: q.prompt, picture: null,
        chosen: a ?? null, expected: q.answer, correct: ok,
      });
    } else if (q.kind === 'written') {
      const text = (a ?? '').toString().trim();
      if (text) written.push({ qid: q.id, prompt: q.prompt, answer: text, example: q.example || null });
      detail.push({
        qid: q.id, kind: q.kind, objective: false,
        prompt: q.prompt, picture: null,
        chosen: text, expected: q.example || null, correct: null,
      });
    }
  }

  return {
    score: units ? correct / units : null,
    detail, written,
    needsReview: written.length > 0,
  };
}

// Aggregated honest misses across submitted homework — used for the
// "recurring errors" panel, grounded in actual answers only.
export function recurringErrors(details) {
  return details
    .filter((d) => d.objective && d.correct === false)
    .map((d) => ({
      question: d.prompt,
      theirAnswer: d.chosen,
      correctAnswer: d.expected,
      kind: d.kind,
    }));
}

// Strips correct answers from a snapshot before sending it to a pupil, so
// answers are never readable in the browser's network tab.
export function sanitizeSnapshotForPupil(snapshot) {
  const clean = JSON.parse(JSON.stringify(snapshot));
  const stripQ = (q) => {
    delete q.answer; delete q.hint;
    if (q.items) q.items = q.items.map(({ text, picture, options }) => ({ text, picture, options }));
    if (q.pairs) q.pairs = q.pairs.map(({ picture }) => ({ picture }));
    return q;
  };
  clean.questions = clean.questions.map(stripQ);
  return clean;
}

// Server-side validation for teacher-edited template content. Keeps the
// auto-marker's assumptions true: answers exist and sit inside the options.
export function validateTemplateContent(content) {
  if (!content || typeof content !== 'object' || !Array.isArray(content.questions)) {
    return 'Content must include questions';
  }
  if (content.questions.length === 0) return 'Add at least one question';
  const kinds = ['choice', 'choicePic', 'match', 'arrange', 'written'];
  for (const q of content.questions) {
    if (!kinds.includes(q.kind)) return 'Unknown question kind';
    if (!q.id) return 'Every question needs an id';
    if (q.kind === 'choice' || q.kind === 'choicePic') {
      if (!Array.isArray(q.items) || q.items.length === 0) return 'Every choice question needs at least one item';
      for (const item of q.items) {
        if (!Array.isArray(item.options) || item.options.filter((o) => String(o).trim() !== '').length < 2) {
          return 'Every item needs at least 2 options';
        }
        if (!item.options.map((o) => String(o).trim()).includes(String(item.answer ?? '').trim())) {
          return 'The correct answer must be one of the options';
        }
      }
    } else if (q.kind === 'match') {
      if (!Array.isArray(q.pairs) || q.pairs.length === 0) return 'Every match question needs at least one pair';
      for (const p of q.pairs) {
        if (!String(p.picture ?? '').trim() || !String(p.answer ?? '').trim()) {
          return 'Every match pair needs a picture and a word';
        }
      }
    } else if (q.kind === 'arrange') {
      if (!Array.isArray(q.tiles) || q.tiles.length === 0 || !String(q.answer ?? '').trim()) {
        return 'Arrange questions need a sentence';
      }
    } else if (q.kind === 'written') {
      if (!String(q.prompt ?? '').trim()) return 'Written questions need a prompt';
    }
  }
  return null;
}

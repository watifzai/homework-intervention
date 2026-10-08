// Homework generator — pure functions (no DOM, no fetch) shared by the
// teacher Studio's AI assistant and the test suite.
//
// Turns a flat teacher spec into the structured template content the rest of
// the platform already understands (same shapes as server/seed.js), so the
// result is immediately editable and passes server validation. The AI
// assistant collects the raw material; this module assembles the questions,
// options, distractors and answer keys — deterministically, offline.

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const stripPunct = (s) => String(s ?? '').replace(/[.!?]+$/g, '').trim();
const lastWord = (sentence) => {
  const w = stripPunct(sentence).split(' ').filter(Boolean);
  return w[w.length - 1] || '';
};
const blankLastWord = (sentence) => String(sentence ?? '').replace(/\b[\w'-]+(?=[.!?]*$)/, '___');

// Build a wrong-but-plausible sentence from a model sentence's words.
const scrambleSentence = (sentence) => {
  const words = stripPunct(sentence).split(' ').filter(Boolean);
  if (words.length < 2) return sentence;
  return [...words.slice(1), words[0]].join(' ') + '.';
};

// A plausible misspelling: swap two adjacent letters (or drop the last letter
// for very short words). Used as a distractor in "choose the correct spelling".
const misspell = (word) => {
  if (word.length <= 3) return word.slice(0, -1) || word;
  const i = Math.max(0, word.length - 3);
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
};

const LEVEL_LABELS = { words: 'Weak', sentences: 'Intermediate', paragraphs: 'Advanced' };

function cleanWords(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((w) => ({
      word: String(w?.word ?? '').trim(),
      picture: String(w?.picture ?? '').trim() || '❓',
      meaning: String(w?.meaning ?? '').trim(),
    }))
    .filter((w) => w.word !== '');
}

function wordsContent(words) {
  const options = (answer, pool, n) => shuffle([answer, ...shuffle(pool.filter((x) => x !== answer)).slice(0, n)]);
  const wordPool = words.map((w) => w.word);
  const hasMeanings = words.every((w) => w.meaning !== '');
  const hasPictures = words.every((w) => w.picture !== '' && w.picture !== '❓');

  const questions = [];

  // 1. Spelling — works with words alone, ideal for intervention.
  questions.push({
    id: 'w1', kind: 'choice', prompt: 'Choose the correct spelling.',
    items: words.map((w) => ({
      text: `How do you spell "${w.word}"?`,
      answer: w.word,
      options: shuffle([w.word, misspell(w.word), misspell(misspell(w.word) || w.word)]),
    })),
  });

  // 2. Unscramble the letters — works with words alone.
  for (let i = 0; i < Math.min(2, words.length); i++) {
    const w = words[i].word;
    if (w.length < 2) continue;
    questions.push({
      id: 'w' + (2 + i) + 'a', kind: 'arrange',
      prompt: 'Arrange the letters to spell the word.',
      tiles: shuffle(w.split('')), answer: w,
      hint: `It starts with "${w[0]}".`,
    });
  }

  // 3. Picture → word, only when real pictures were supplied.
  if (hasPictures) {
    questions.push({
      id: 'w3', kind: 'choicePic', prompt: 'Choose the correct word for the picture.',
      items: words.slice(0, 3).map((w) => ({
        picture: w.picture, answer: w.word, options: options(w.word, wordPool, 3),
      })),
    });
  }

  // 4. Word meaning, only when meanings were supplied.
  if (hasMeanings) {
    const meaningPool = words.map((w) => w.meaning);
    questions.push({
      id: 'w4', kind: 'choice', prompt: 'Choose the word that fits the meaning.',
      items: words.map((w) => ({
        text: `"${w.word}" means…`, answer: w.meaning, options: options(w.meaning, meaningPool, 2),
      })),
    });
  }

  return {
    targetWords: words.map((w) => ({ ...w })),
    questions,
  };
}

function sentencesContent(sentences, topic, words) {
  const s = sentences.map((x) => String(x ?? '').trim()).filter(Boolean);
  const distractors = words.map((w) => w.word);
  const completionOptions = (answer) => shuffle([
    answer,
    ...shuffle(distractors.filter((word) => word.toLowerCase() !== answer.toLowerCase())).slice(0, 3),
  ]);
  return {
    modelSentences: s.slice(),
    questions: [
      {
        id: 's1', kind: 'choice', prompt: 'Which sentence is correct?',
        items: [{
          text: 'Choose the correct sentence.',
          answer: s[0],
          options: shuffle([s[0], scrambleSentence(s[0]), scrambleSentence(s[1] || s[0])]),
        }],
      },
      { id: 's2', kind: 'arrange', prompt: 'Arrange the words to make a sentence.', tiles: shuffle(stripPunct(s[1] || s[0]).split(' ').filter(Boolean)), answer: stripPunct(s[1] || s[0]), hint: 'The person doing the action comes first.' },
      { id: 's3', kind: 'arrange', prompt: 'Arrange the words to make a sentence.', tiles: shuffle(stripPunct(s[2] || s[0]).split(' ').filter(Boolean)), answer: stripPunct(s[2] || s[0]), hint: 'Start with the first word of the sentence.' },
      {
        id: 's4', kind: 'choice', prompt: 'Complete the sentence.',
        items: [{
          text: blankLastWord(s[2] || s[0]),
          answer: lastWord(s[2] || s[0]),
          options: completionOptions(lastWord(s[2] || s[0])),
        }],
      },
      {
        id: 's5', kind: 'choice', prompt: 'Complete the sentence.',
        items: [{
          text: blankLastWord(s[3] || s[1] || s[0]),
          answer: lastWord(s[3] || s[1] || s[0]),
          options: completionOptions(lastWord(s[3] || s[1] || s[0])),
        }],
      },
      {
        id: 's6', kind: 'written',
        prompt: `Write your own sentence about ${topic}. Try to use one of these words: ${words.slice(0, 3).map((w) => w.word).join(', ')}.`,
      },
    ],
  };
}

function paragraphsContent({ paragraph, comprehension, writtenPrompt }, topic, words, sentences) {
  const reading = paragraph || sentences.slice(0, 3).join(' ') + ` ${topic} is a good topic to read about.`;

  let comprehensionQs = comprehension;
  if (!comprehensionQs || comprehensionQs.length === 0) {
    // Fall back to "which sentence is correct" items from the model sentences —
    // always valid, no meanings required.
    const base = sentences[0] || `I like ${words[0]?.word || topic}.`;
    comprehensionQs = [
      { q: 'Which sentence is correct?', a: base, wrongs: [scrambleSentence(base), scrambleSentence(sentences[1] || base)] },
      { q: 'Which sentence is correct?', a: sentences[1] || base, wrongs: [scrambleSentence(base), scrambleSentence(sentences[2] || base)] },
      { q: 'Which sentence is correct?', a: sentences[2] || base, wrongs: [scrambleSentence(sentences[1] || base), scrambleSentence(base)] },
    ];
  }

  const qs = comprehensionQs.slice(0, 3).map((c, i) => ({
    id: 'p' + (i + 1),
    kind: 'choice',
    prompt: 'Comprehension question ' + (i + 1),
    items: [{
      text: String(c.q ?? '').trim(),
      answer: String(c.a ?? '').trim(),
      options: shuffle([
        String(c.a ?? '').trim(),
        ...(Array.isArray(c.wrongs) ? c.wrongs : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2),
      ]),
    }],
  }));

  qs.push({
    id: 'p4', kind: 'written',
    prompt: writtenPrompt || `Write one or two sentences about ${topic}.`,
    example: `Example: I like ${topic.toLowerCase()} because it is fun.`,
  });
  return { reading, questions: qs };
}

const ACTIVITY = {
  words: 'Match & choose words',
  sentences: 'Build & complete sentences',
  paragraphs: 'Read & respond',
};
const MINUTES = { words: 10, sentences: 15, paragraphs: 20 };

// Main entry point. Returns { title, activityType, minutes, content } or
// { error } when the spec cannot produce valid homework.
export function generateHomework(spec = {}) {
  const topic = String(spec.topic ?? '').trim();
  const level = ['words', 'sentences', 'paragraphs'].includes(spec.level) ? spec.level : 'words';
  const words = cleanWords(spec.words);

  if (!topic) return { error: 'Topic is required' };
  if (words.length < 1) return { error: 'Provide at least one word for the topic' };

  let content;
  if (level === 'words') {
    content = wordsContent(words);
  } else if (level === 'sentences') {
    const provided = (spec.sentences || []).map((x) => String(x).trim()).filter(Boolean);
    content = sentencesContent(provided.length ? provided : words.map((w) => `I like ${w.word}.`), topic, words);
  } else {
    const provided = (spec.sentences || []).map((x) => String(x).trim()).filter(Boolean);
    const auto = provided.length ? provided : words.map((w) => `I like ${w.word}.`);
    content = paragraphsContent(
      {
        paragraph: String(spec.paragraph ?? '').trim(),
        comprehension: spec.comprehension,
        writtenPrompt: String(spec.writtenPrompt ?? '').trim(),
      },
      topic, words, auto,
    );
  }

  return {
    title: `${topic}: ${LEVEL_LABELS[level]}`,
    activityType: ACTIVITY[level],
    minutes: MINUTES[level],
    content,
  };
}

// ---------------------------------------------------------------------------
// Offline "AI" request parser — turns a teacher's free-text description into a
// homework spec the generator understands. Heuristic and deliberately
// conservative: it extracts a topic, vocabulary words and (when present)
// model sentences. Everything it produces is editable in the Studio's manual
// editor, so an imperfect guess is cheap to correct.
// ---------------------------------------------------------------------------

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'about',
  'is', 'are', 'was', 'were', 'be', 'been', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'there', 'here', 'make', 'create', 'build', 'write', 'homework', 'topic', 'word', 'words',
  'vocabulary', 'sentence', 'sentences', 'paragraph', 'reading', 'question', 'questions',
  'comprehension', 'please', 'some', 'each', 'one', 'two', 'three', 'four', 'five', 'using',
  'use', 'like', 'has', 'have', 'from', 'by', 'as', 'not', 'can', 'will', 'would', 'could',
  'should', 'them', 'then', 'than', 'me', 'us', 'him', 'her', 'what', 'which', 'who', 'when',
  'where', 'why', 'how', 'all', 'any', 'many', 'more', 'most', 'other', 'same', 'very', 'just',
]);

const toTitle = (w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;

export function parseHomeworkRequest(text = '', level = 'words', fallbackTopic = '') {
  const raw = String(text ?? '').trim();
  const out = {
    topic: fallbackTopic, level, words: [], sentences: [], paragraph: '', writtenPrompt: '',
  };

  const quoted = [...raw.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => (m[1] || m[2]).trim()).filter(Boolean);

  // Topic override: "about X" (stops at connectors / punctuation).
  const about = raw.match(/about\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][A-Za-z\s]{0,40}?)(?= with\b| for\b| and\b| using\b|\.|,|;|:|\?|!|$)/i);
  if (about && about[1].trim().length <= 40) {
    out.topic = about[1].trim().split(/\s+/).map(toTitle).join(' ');
  }

  // Explicit word list: "words: shell, wave, sand".
  const wl = raw.match(/(?:words?|vocabulary)\s*[:=]\s*([A-Za-z0-9,\s]+?)(?=[.;:!?]|$)/i);
  const explicitWords = wl ? wl[1].split(/[,;]/).map((x) => x.trim()).filter((x) => /^[A-Za-z][A-Za-z\-']{0,19}$/.test(x)) : [];

  // Quoted single words are strong signals.
  const quotedWords = quoted.filter((q) => /^[A-Za-z][A-Za-z\-']{1,20}$/.test(q));

  // Quoted phrases that look like sentences are model sentences.
  const quotedSentences = quoted.filter((q) => /[A-Za-z].*[.!?]$/.test(q) && q.split(/\s+/).length >= 2);

  // Fallback candidate nouns from the free text.
  const topicLower = String(out.topic).toLowerCase();
  const tokens = raw
    .replace(/[^A-Za-z\-'\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z\-']/g, ''))
    .filter((w) => w.length >= 3 && w.length <= 14 && !STOP.has(w) && !topicLower.includes(w));

  const words = [...new Set([...explicitWords, ...quotedWords, ...tokens])]
    .slice(0, 8)
    .map((w) => ({ word: toTitle(w), picture: '', meaning: '' }));

  out.words = words;

  // Sentences from quoted phrases, or full sentences found in the text.
  const foundSentences = raw.match(/[A-Z][^.!?]*[.!?]/g)?.map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 2) || [];
  out.sentences = [...new Set([...quotedSentences, ...foundSentences])].slice(0, 4);

  return out;
}


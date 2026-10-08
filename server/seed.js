// Demo data seed — clearly labelled, kept separate from real records via
// is_demo = 1 on every row. Seeding only ever inserts demo rows; it never
// touches real class records.
//
// Question kinds:
//   'choice'    — text options, auto-marked
//   'choicePic' — emoji picture shown, pick the word, auto-marked
//   'match'     — match words to pictures (emoji), auto-marked per pair
//   'arrange'   — arrange word tiles into a sentence, auto-marked
//   'written'   — open answer, always waits for teacher review
import { run, q, one, tx } from './db.js';
import { hashPassword } from './passwords.js';
import crypto from 'node:crypto';

const code = (n) => crypto.randomBytes(8).toString('hex').slice(0, n).toUpperCase();

const sets = [
  {
    topic: 'School Objects', icon: '🎒',
    words: [
      { word: 'pen', picture: '🖊️', meaning: 'a thing you write with' },
      { word: 'book', picture: '📖', meaning: 'you read it; it has pages' },
      { word: 'bag', picture: '🎒', meaning: 'you carry it on your back' },
      { word: 'chair', picture: '🪑', meaning: 'you sit on it' },
      { word: 'desk', picture: '🗂️', meaning: 'a table for working' },
    ],
    sentences: [
      'This is my pen.', 'I read a book.', 'My bag is heavy.',
      'The chair is small.', 'The desk is clean.',
    ],
    paragraph: 'This is my classroom. There are many desks and chairs. My teacher has a big book. I keep my pens in my bag. I like to read in class.',
    comprehension: [
      { q: 'Where does the child keep the pens?', a: 'In the bag', wrongs: ['On the desk', 'Under the chair'] },
      { q: 'What does the teacher have?', a: 'A big book', wrongs: ['A small bag', 'A red pen'] },
      { q: 'What does the child like to do in class?', a: 'Read', wrongs: ['Sleep', 'Run'] },
    ],
    writtenPrompt: 'Write one or two sentences about your own classroom.',
  },
  {
    topic: 'Food', icon: '🍎',
    words: [
      { word: 'rice', picture: '🍚', meaning: 'small white grains we eat' },
      { word: 'egg', picture: '🥚', meaning: 'it comes from a hen' },
      { word: 'milk', picture: '🥛', meaning: 'a white drink' },
      { word: 'bread', picture: '🍞', meaning: 'baked food made from flour' },
      { word: 'apple', picture: '🍎', meaning: 'a sweet round fruit' },
    ],
    sentences: [
      'I eat rice every day.', 'The egg is on the plate.', 'I drink cold milk.',
      'We buy fresh bread.', 'The apple is sweet.'
    ],
    paragraph: 'I like healthy food. For breakfast, I eat bread and eggs. I drink a glass of milk. My favourite fruit is the apple. My mother cooks rice for dinner.',
    comprehension: [
      { q: 'What does the child eat for breakfast?', a: 'Bread and eggs', wrongs: ['Rice and fish', 'Apples only'] },
      { q: 'What is the favourite fruit?', a: 'The apple', wrongs: ['The banana', 'The orange'] },
      { q: 'Who cooks rice for dinner?', a: 'The mother', wrongs: ['The father', 'The child'] },
    ],
    writtenPrompt: 'Write one or two sentences about food you like.',
  },
  {
    topic: 'Animals', icon: '🐶',
    words: [
      { word: 'cat', picture: '🐱', meaning: 'a small pet that says meow' },
      { word: 'dog', picture: '🐶', meaning: 'a pet that barks' },
      { word: 'bird', picture: '🐦', meaning: 'an animal that can fly' },
      { word: 'fish', picture: '🐟', meaning: 'it swims in water' },
      { word: 'rabbit', picture: '🐰', meaning: 'a small animal with long ears' },
    ],
    sentences: [
      'The cat is sleeping.', 'My dog can run fast.', 'A bird sings in the tree.',
      'The fish swims in water.', 'The rabbit eats carrots.'
    ],
    paragraph: 'I have a small dog named Bobo. He has brown fur and big ears. Every morning, Bobo runs in the garden. He likes to chase birds and cats. At night, he sleeps near my bed.',
    comprehension: [
      { q: "What is the dog's name?", a: 'Bobo', wrongs: ['Bibi', 'Bingo'] },
      { q: 'Where does Bobo run in the morning?', a: 'In the garden', wrongs: ['In the house', 'On the road'] },
      { q: 'Where does he sleep at night?', a: 'Near the bed', wrongs: ['In the kitchen', 'Outside'] },
    ],
    writtenPrompt: 'Write one or two sentences about an animal you like.',
  },
];

const shuffled = (arr) => [...arr].sort(() => Math.random() - 0.5);

const ALL_WORDS = sets.flatMap((s) => s.words);

function templateContent(set, level, distractorWords) {
  if (level === 'words') {
    return {
      targetWords: set.words,
      questions: [
        {
          id: 'w1', kind: 'match', prompt: 'Match each picture to the correct word.',
          pairs: set.words.map(w => ({ picture: w.picture, answer: w.word })),
          wordBank: shuffled(set.words.map(w => w.word)),
        },
        {
          id: 'w2', kind: 'choicePic', prompt: 'Choose the correct word for the picture.',
          items: set.words.slice(0, 3).map(w => ({ picture: w.picture, answer: w.word, options: shuffled([w.word, ...shuffled(set.words.filter(x => x.word !== w.word).map(x => x.word)).slice(0, 3)]) })),
        },
        {
          id: 'w3', kind: 'choice', prompt: 'Choose the word that fits the meaning.',
          items: set.words.map(w => ({ text: `"${w.word}" means…`, answer: w.meaning, options: shuffled([w.meaning, ...shuffled(set.words.filter(x => x.word !== w.word).map(x => x.meaning)).slice(0, 2)]) })),
        },
      ],
    };
  }
  if (level === 'sentences') {
    const s = set.sentences;
    const wrongs = distractorWords;
    return {
      modelSentences: s, // shown as a study step: "Read simple model sentences"
      questions: [
        { id: 's1', kind: 'choice', prompt: 'Which sentence is correct?', items: [
          { text: 'Choose the correct sentence.', answer: s[0], options: shuffled([s[0], scrambleWords(s[0], wrongs), scrambleWords(s[1], wrongs)]) },
        ]},
        { id: 's2', kind: 'arrange', prompt: 'Arrange the words to make a sentence.', tiles: shuffled(s[1].replace('.', '').split(' ')), answer: s[1].replace('.', ''), hint: 'The person doing the action comes first.' },
        { id: 's3', kind: 'arrange', prompt: 'Arrange the words to make a sentence.', tiles: shuffled(s[4].replace('.', '').split(' ')), answer: s[4].replace('.', ''), hint: 'Start with "The".' },
        { id: 's4', kind: 'choice', prompt: 'Complete the sentence.', items: [
          { text: s[2].replace(/\b\w+\b$/, '___'), answer: lastWord(s[2]), options: shuffled([lastWord(s[2]), ...wrongs.slice(0, 3)]) },
        ]},
        { id: 's5', kind: 'choice', prompt: 'Complete the sentence.', items: [
          { text: s[3].replace(/\b\w+\b$/, '___'), answer: lastWord(s[3]), options: shuffled([lastWord(s[3]), ...wrongs.slice(0, 3)]) },
        ]},
        { id: 's6', kind: 'written', prompt: `Write your own sentence about ${set.topic.toLowerCase()}. Try to use one of these words: ${set.words.slice(0, 3).map((w) => w.word).join(', ')}.` },
      ],
    };
  }
  // paragraphs
  return {
    reading: set.paragraph,
    questions: [
      { id: 'p1', kind: 'choice', prompt: 'Comprehension question 1', items: [{ text: set.comprehension[0].q, answer: set.comprehension[0].a, options: shuffled([set.comprehension[0].a, ...set.comprehension[0].wrongs]) }] },
      { id: 'p2', kind: 'choice', prompt: 'Comprehension question 2', items: [{ text: set.comprehension[1].q, answer: set.comprehension[1].a, options: shuffled([set.comprehension[1].a, ...set.comprehension[1].wrongs]) }] },
      { id: 'p3', kind: 'choice', prompt: 'Comprehension question 3', items: [{ text: set.comprehension[2].q, answer: set.comprehension[2].a, options: shuffled([set.comprehension[2].a, ...set.comprehension[2].wrongs]) }] },
      { id: 'p4', kind: 'written', prompt: set.writtenPrompt, example: 'Example: I like to eat apples because they are sweet.' },
    ],
  };
}

function minutesFor(level) {
  return level === 'words' ? 10 : level === 'sentences' ? 15 : 20;
}

function lastWord(sentence) {
  const w = sentence.replace('.', '').split(' ');
  return w[w.length - 1];
}

// Build a wrong-but-plausible sentence from a model sentence's words.
function scrambleWords(sentence, wrongs) {
  const words = sentence.replace('.', '').split(' ');
  return [...words.slice(1), words[0]].join(' ') + '.';
}

export function seedDemo() {
  const already = one('SELECT COUNT(*) AS c FROM accounts WHERE is_demo = 1');
  if (already.c > 0) {
    return { seeded: false, message: 'Demo data already present.' };
  }

  tx(() => {
    const teacherId = run(
      'INSERT INTO accounts (username, pass_hash, role, display_name, is_demo) VALUES (?,?,?,?,1)',
      'teacher', hashPassword('teach123'), 'teacher', 'Ms. Demo Teacher'
    ).lastInsertRowid;

    const classDefs = [
      { name: '6 Bestari (Demo)', code: 'DEMO6B', pupils: [
        ['Aiman Hakim', '6B001'], ['Nur Aisyah', '6B002'], ['Muhammad Danish', '6B003'],
        ['Sofia Lim', '6B004'], ['Arjun Menon', '6B005'], ['Aiman Hakim', '6B006'], // identical name
        ['Chloe Wong', '6B007'],
      ]},
      { name: '6 Cekap (Demo)', code: 'DEMO6C', pupils: [
        ['Nur Aisyah', '6C001'], ['Ryan Tan', '6C002'], ['Emily Pereira', '6C003'],
      ]},
    ];
    for (const cd of classDefs) {
      const classId = run(
        'INSERT INTO classes (name, code, reg_code, teacher_id, is_demo) VALUES (?,?,?,?,1)',
        cd.name, cd.code, code(6), teacherId
      ).lastInsertRowid;
      for (const [name, no] of cd.pupils) {
        run('INSERT INTO pupils (class_id, name, student_no, is_demo) VALUES (?,?,?,1)', classId, name, no);
      }
    }

    for (const set of sets) {
      const setId = run(
        'INSERT INTO template_sets (topic, icon, is_demo) VALUES (?,?,1)', set.topic, set.icon
      ).lastInsertRowid;
      const titles = {
        words: `${set.topic}: Weak`,
        sentences: `${set.topic}: Intermediate`,
        paragraphs: `${set.topic}: Advanced`,
      };
      const types = {
        words: 'Match & choose words',
        sentences: 'Build & complete sentences',
        paragraphs: 'Read & respond',
      };
      // topic-appropriate distractor words for the "complete the sentence" items
      const distractors = shuffled(
        ALL_WORDS.filter((w) => !set.words.some((x) => x.word === w.word))
      ).slice(0, 6).map((w) => w.word);
      for (const level of ['words', 'sentences', 'paragraphs']) {
        const content = templateContent(set, level, distractors);
        run(
          'INSERT INTO templates (set_id, level, title, activity_type, estimated_minutes, content, is_demo) VALUES (?,?,?,?,?,?,1)',
          setId, level, titles[level], types[level], minutesFor(level), JSON.stringify(content)
        );
      }
    }
  });
  return { seeded: true };
}

// Recompute demo credentials for display (teacher login page).
export function demoCredentials() {
  const classes = q('SELECT name, code, reg_code FROM classes WHERE is_demo = 1 ORDER BY id');
  return {
    teacher: { username: 'teacher', password: 'teach123' },
    classes: classes.map(c => ({ name: c.name, code: c.code, regCode: c.reg_code })),
  };
}

// One-click temporary pupil access: a demo pupil account with sample homework.
// Only touches demo records, and never hijacks a name that a real pupil has
// already claimed.
export function ensureDemoPupil() {
  const already = one("SELECT p.id FROM pupils p JOIN accounts a ON a.id = p.account_id WHERE a.username = 'ryan' LIMIT 1");
  if (already) return { seeded: false };

  tx(() => {
    const pupil = one("SELECT * FROM pupils WHERE student_no = '6C002' LIMIT 1");
    if (!pupil || pupil.account_id) return; // class missing or name already claimed
    const accountId = run(
      'INSERT INTO accounts (username, pass_hash, role, display_name, is_demo) VALUES (?,?,?,?,1)',
      'ryan', hashPassword('ryan123'), 'pupil', pupil.name
    ).lastInsertRowid;
    const upd = run('UPDATE pupils SET account_id = ? WHERE id = ? AND account_id IS NULL', accountId, pupil.id);
    if (upd.changes === 0) { // lost a race — do not leave an orphan account
      run('DELETE FROM accounts WHERE id = ?', accountId);
      return;
    }
    run("UPDATE pupils SET proficiency = 'words' WHERE id = ?", pupil.id);

    const teacher = one("SELECT id FROM accounts WHERE username = 'teacher' LIMIT 1");
    const tpl = one("SELECT t.*, s.topic FROM templates t JOIN template_sets s ON s.id = t.set_id WHERE s.topic = 'School Objects' AND t.level = 'words' LIMIT 1");
    const dup = one(
      'SELECT pa.id FROM pupil_assignments pa JOIN assignments a ON a.id = pa.assignment_id WHERE pa.pupil_id = ? AND a.title = ?',
      pupil.id, 'School Objects'
    );
    if (teacher && tpl && !dup) {
      const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      const aid = run(
        'INSERT INTO assignments (class_id, teacher_id, set_id, title, due_date) VALUES (?,?,?,?,?)',
        pupil.class_id, teacher.id, tpl.set_id, 'School Objects', due
      ).lastInsertRowid;
      run('INSERT INTO pupil_assignments (assignment_id, pupil_id, level, snapshot) VALUES (?,?,?,?)',
        aid, pupil.id, 'words', tpl.content);
    }
  });
  return { seeded: true };
}

// Relabel demo template titles for existing databases (Words/Sentences/
// Paragraphs became the Weak/Intermediate/Advanced proficiency bands).
export function relabelDemoTemplates() {
  for (const [from, to] of [[': Words', ': Weak'], [': Sentences', ': Intermediate'], [': Paragraphs', ': Advanced']]) {
    run("UPDATE templates SET title = REPLACE(title, ?, ?) WHERE is_demo = 1 AND title LIKE '%' || ?", from, to, from);
  }
}

// Production cleanup for deployments that started with the old demo seed.
// The real class is preserved even if an older snapshot accidentally marked it
// as demo data. The original teacher account is retained so its login and
// ownership links remain valid; only its public identity is converted.
export function removeDemoData({ preserveClassName = '6 Mawar', teacherName = 'Ms Falisha' } = {}) {
  const result = { removedClasses: 0, removedPupils: 0, removedTemplateSets: 0, renamedTeachers: 0 };

  tx(() => {
    const preservedClasses = q(
      'SELECT id FROM classes WHERE lower(trim(name)) = lower(trim(?))',
      preserveClassName
    );
    const preservedIds = preservedClasses.map((row) => row.id);

    for (const classId of preservedIds) {
      run('UPDATE classes SET is_demo = 0 WHERE id = ?', classId);
      run('UPDATE pupils SET is_demo = 0 WHERE class_id = ?', classId);
      run(
        `UPDATE accounts SET is_demo = 0 WHERE id IN (
          SELECT account_id FROM pupils WHERE class_id = ? AND account_id IS NOT NULL
        )`,
        classId
      );
    }

    const demoClassIds = q(
      'SELECT id FROM classes WHERE is_demo = 1 AND lower(trim(name)) <> lower(trim(?))',
      preserveClassName
    ).map((row) => row.id);
    for (const classId of demoClassIds) {
      const pupilAccounts = q(
        'SELECT account_id FROM pupils WHERE class_id = ? AND account_id IS NOT NULL',
        classId
      ).map((row) => row.account_id);
      run(
        `DELETE FROM pupil_assignments
         WHERE pupil_id IN (SELECT id FROM pupils WHERE class_id = ?)
            OR assignment_id IN (SELECT id FROM assignments WHERE class_id = ?)`,
        classId, classId
      );
      run('DELETE FROM assignments WHERE class_id = ?', classId);
      result.removedPupils += Number(run('DELETE FROM pupils WHERE class_id = ?', classId).changes);
      result.removedClasses += Number(run('DELETE FROM classes WHERE id = ?', classId).changes);
      for (const accountId of pupilAccounts) run('DELETE FROM accounts WHERE id = ? AND role = ?', accountId, 'pupil');
    }

    // Remove sample homework and anything assigned from it.
    const demoSetIds = q('SELECT id FROM template_sets WHERE is_demo = 1').map((row) => row.id);
    for (const setId of demoSetIds) {
      run(
        'DELETE FROM pupil_assignments WHERE assignment_id IN (SELECT id FROM assignments WHERE set_id = ?)',
        setId
      );
      run('DELETE FROM assignments WHERE set_id = ?', setId);
      run('DELETE FROM templates WHERE set_id = ? OR is_demo = 1', setId);
      result.removedTemplateSets += Number(run('DELETE FROM template_sets WHERE id = ?', setId).changes);
    }

    const remainingDemoPupils = q('SELECT id, account_id FROM pupils WHERE is_demo = 1');
    for (const pupil of remainingDemoPupils) {
      run('DELETE FROM pupil_assignments WHERE pupil_id = ?', pupil.id);
      result.removedPupils += Number(run('DELETE FROM pupils WHERE id = ?', pupil.id).changes);
      if (pupil.account_id) run("DELETE FROM accounts WHERE id = ? AND role = 'pupil'", pupil.account_id);
    }
    run("DELETE FROM templates WHERE is_demo = 1");
    run("DELETE FROM accounts WHERE is_demo = 1 AND role = 'pupil'");
    result.renamedTeachers = Number(run(
      `UPDATE accounts SET display_name = ?, is_demo = 0
       WHERE role = 'teacher'
         AND (is_demo = 1 OR lower(trim(display_name)) IN ('ms demo', 'ms. demo teacher', 'ms demo teacher'))`,
      teacherName
    ).changes);
  });

  return result;
}

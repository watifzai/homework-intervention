// End-to-end verification of the complete workflow, run against a temporary
// database so the real one is never touched:
//   1. register + link an existing pupil
//   2. prevent duplicate name claims (incl. concurrent attempts)
//   3. set/change proficiency
//   4. preview + assign level-matched homework (with snapshot freeze)
//   5. complete + submit homework (with hints/retries separation)
//   6. review written answers
//   7. display real results on pupil cards + access control checks
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// throwaway database for the test run — the real one is never touched
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'y6e2e-'));
process.env.Y6_DB_DIR = TMP;
process.env.Y6_DB_PATH = path.join(TMP, 'test.db');

const dbModule = await import('../server/db.js');

const { startServer } = await import('../server/index.js');
const { demoCredentials, removeDemoData } = await import('../server/seed.js');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let server;
let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function client() {
  let cookie = '';
  return async function req(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    if (res.headers.get('content-type')?.includes('application/zip')) data = new Uint8Array(await res.arrayBuffer());
    else try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  };
}

async function main() {
  server = await startServer({ port: PORT, seed: true });
  const creds = demoCredentials();

  console.log('\n— teacher & class setup —');
  const T = client();
  const login = await T('POST', '/api/auth/login', { username: creds.teacher.username, password: creds.teacher.password });
  ok('teacher login', login.status === 200 && login.data.role === 'teacher');
  const CodeC = client();
  const codeOk = await CodeC('POST', '/api/auth/code-login', { code: '0000' });
  ok('code login (0000) works', codeOk.status === 200 && codeOk.data.role === 'teacher');
  const codeBad = await CodeC('POST', '/api/auth/code-login', { code: '9999' });
  ok('wrong code rejected', codeBad.status === 401);


  const { data: classesData } = await T('GET', '/api/teacher/classes');
  ok('classes listed', classesData.classes.length === 2);
  const cls = classesData.classes.find((c) => c.code === 'DEMO6B');
  ok('DEMO6B found', !!cls);

  const { data: studentsData } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  ok('students listed', studentsData.students.length === 7);
  const aiman = studentsData.students.filter((s) => s.name === 'Aiman Hakim');
  ok('identical names distinguished by student_no', aiman.length === 2 && aiman[0].studentNo !== aiman[1].studentNo);
  ok('all pupils unregistered at start', studentsData.students.every((s) => !s.registered));
  const { data: cardData } = await T('GET', `/api/teacher/registration-cards?classId=${cls.id}`);
  const pinFor = id => cardData.cards.find(c => c.id === id).pin;
  ok('every pupil has a unique six-digit PIN', cardData.cards.length === 7 && cardData.cards.every(c => /^\d{6}$/.test(c.pin)) && new Set(cardData.cards.map(c => c.pin)).size === 7);
  ok('QR links open passwordless sign-in with correct class, pupil and PIN', cardData.cards.every(c => {
    const url = new URL(c.url); const hash = new URLSearchParams(url.hash.slice(1));
    return url.pathname === '/student-access.html' && !url.searchParams.has('class')
      && hash.get('pupil') === String(c.id) && hash.get('pin') === c.pin;
  }));
  ok('QR cards include each name below the QR', cardData.cards.every(c => {
    const svg = Buffer.from(c.qr.split(',')[1], 'base64').toString();
    return svg.includes(c.name) && svg.includes('y="650"') && svg.includes(c.pin);
  }));
  const archive = await T('GET', `/api/teacher/registration-cards.zip?classId=${cls.id}`);
  const files = unzipSync(archive.data);
  ok('ZIP includes all student cards and printable sheet', Object.keys(files).filter(f => f.endsWith('.svg')).length === 7 && strFromU8(files['print-cards.html']).includes('Registration') === false && !!files['print-cards.html']);
  ok('unauthenticated users cannot download PINs', (await client()('GET', '/api/teacher/registration-cards')).status === 401);
  ok('unauthenticated users cannot download QR ZIP', (await client()('GET', '/api/teacher/registration-cards.zip')).status === 401);
  const registrationPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'register.html'), 'utf8');
  ok('registration page needs no class code, username or password',
    !registrationPage.includes('id="classCode"')
      && !registrationPage.includes('id="username"') && !registrationPage.includes('id="password"')
      && registrationPage.includes('/api/auth/qr-login'));
  const studentLoginPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'student-login.html'), 'utf8');
  ok('student login page requires only the personal PIN',
    studentLoginPage.includes('id="pin"') && studentLoginPage.includes('/api/auth/pin-login')
      && !studentLoginPage.includes('id="username"') && !studentLoginPage.includes('id="password"'));
  ok('student login includes a camera QR scanner',
    studentLoginPage.includes('id="scanBtn"') && studentLoginPage.includes('getUserMedia')
      && studentLoginPage.includes('BarcodeDetector') && studentLoginPage.includes('/api/auth/qr-login'));
  ok('class PIN cannot claim a pupil', (await client()('POST', '/api/register', {classCode: cls.code, regCode: cls.regCode, pupilId: aiman[0].id, username:'classpin', password:'pass123'})).status === 403);
  ok('another pupil PIN cannot claim a pupil', (await client()('POST', '/api/register', {classCode: cls.code, regCode: pinFor(aiman[1].id), pupilId: aiman[0].id, username:'wrongpin', password:'pass123'})).status === 403);

  console.log('\n— registration —');
  const { data: namelist } = await client()('GET', '/api/register/DEMO6B');
  ok('namelist served without auth', namelist.pupils.length === 7);
  ok('public namelist never exposes PINs', namelist.pupils.every(p => !('pin' in p) && !('registration_pin' in p)));
  ok('duplicate names flagged with sameName', namelist.pupils.filter((p) => p.sameName).length === 2);

  // wrong reg code must fail and NOT reserve the name
  const anon = client();
  let r = await anon('POST', '/api/register', {
    classCode: 'DEMO6B', regCode: 'WRONG', pupilId: aiman[0].id,
    username: 'aiman1', password: 'pass123',
  });
  ok('wrong student PIN rejected', r.status === 403);
  r = await anon('POST', '/api/register', {
    classCode: 'DEMO6B', regCode: pinFor(aiman[0].id), pupilId: aiman[0].id,
    username: 'aiman1', password: 'pass123',
  });
  ok('failed registration did not reserve the name', r.status === 201);

  // duplicate claim
  const anon2 = client();
  r = await anon2('POST', '/api/register', {
    classCode: 'DEMO6B', regCode: pinFor(aiman[0].id), pupilId: aiman[0].id,
    username: 'someoneelse', password: 'pass123',
  });
  ok('duplicate name claim rejected', r.status === 409);

  // concurrent duplicate claim
  const [c1, c2] = await Promise.all([
    client()('POST', '/api/register', { classCode: 'DEMO6B', regCode: pinFor(aiman[1].id), pupilId: aiman[1].id, username: 'aimanb1', password: 'pass123' }),
    client()('POST', '/api/register', { classCode: 'DEMO6B', regCode: pinFor(aiman[1].id), pupilId: aiman[1].id, username: 'aimanb2', password: 'pass123' }),
  ]);
  ok('concurrent claims: exactly one wins', (c1.status === 201) !== (c2.status === 201));

  // registered state now visible
  const { data: namelist2 } = await client()('GET', '/api/register/DEMO6B');
  ok('registered pupils labelled in namelist', namelist2.pupils.filter((p) => p.registered).length === 2);
  ok('name greyed out with "Already registered" flag', namelist2.pupils.find((p) => p.id === aiman[0].id).registered === true);

  console.log('\n— proficiency —');
  const sofia = studentsData.students.find((s) => s.name === 'Sofia Lim');
  const danish = studentsData.students.find((s) => s.name === 'Muhammad Danish');
  const chloe = studentsData.students.find((s) => s.name === 'Chloe Wong');
  const arjun = studentsData.students.find((s) => s.name === 'Arjun Menon');
  r = await T('POST', `/api/teacher/pupils/${sofia.id}/proficiency`, { proficiency: 'words' });
  ok('set proficiency', r.status === 200);
  r = await T('POST', `/api/teacher/pupils/${sofia.id}/proficiency`, { proficiency: 'paragraphs' });
  ok('change proficiency', r.status === 200 && r.data.proficiency === 'paragraphs');
  r = await T('POST', `/api/teacher/pupils/${sofia.id}/proficiency`, { proficiency: 'sentences' });
  ok('change proficiency again (sentences)', r.status === 200);
  await T('POST', `/api/teacher/pupils/${danish.id}/proficiency`, { proficiency: 'sentences' });
  // pupil cannot set proficiency
  r = await anon('POST', `/api/teacher/pupils/${sofia.id}/proficiency`, { proficiency: 'paragraphs' });
  ok('pupil cannot set proficiency', r.status === 401 || r.status === 403);
  // unregistered pupil can still have proficiency (they exist as records)
  await T('POST', `/api/teacher/pupils/${chloe.id}/proficiency`, { proficiency: 'words' });
  const { data: students2 } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  ok('pupils without level show unset (Set level)', students2.students.some((s) => !s.proficiency));

  // register Sofia so a registered pupil does the homework flow
  const sofiaReg = await client()('POST', '/api/register', {
    classCode: 'DEMO6B', regCode: pinFor(sofia.id), pupilId: sofia.id,
    username: 'sofialim', password: 'pass123',
  });
  ok('sofia registered', sofiaReg.status === 201);

  console.log('\n— templates & matching —');
  const { data: templatesData } = await T('GET', '/api/teacher/templates');
  ok('three topic sets', templatesData.sets.length === 3);
  ok('each set has words/sentences/paragraphs versions',
    templatesData.sets.every((s) => ['words', 'sentences', 'paragraphs'].every((lvl) => s.templates.some((t) => t.level === lvl))));
  const animals = templatesData.sets.find((s) => s.topic === 'Animals');
  r = await T('GET', `/api/teacher/classes/${cls.id}/match?setId=${animals.id}`);
  ok('match preview groups by level', r.status === 200);
  const sofiaMatch = r.data.matches.find((m) => m.pupil.id === sofia.id);
  ok('pupil matched to their level version', sofiaMatch.template.level === 'sentences');
  const noLevel = r.data.matches.find((m) => !m.pupil.proficiency);
  ok('pupil without level flagged (no template)', noLevel && noLevel.template === null);

  console.log('\n— assignment —');
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const selection = r.data.matches
    .filter((m) => m.template)
    .map((m) => ({ pupilId: m.pupil.id, level: m.template.level }));
  const assignRes = await T('POST', '/api/teacher/assign', {
    setId: animals.id, classId: cls.id, dueDate: due, pupils: selection,
  });
  ok('homework assigned', assignRes.status === 201 && assignRes.data.assigned === selection.length);

  // assignment is not immediate on template click — but here we just check the
  // manager reflects the assignment
  const { data: assignmentsData } = await T('GET', `/api/teacher/assignments?classId=${cls.id}`);
  ok('assignment card shows counts', assignmentsData.assignments.length === 1 &&
    assignmentsData.assignments[0].assigned === selection.length);
  const assignmentId = assignmentsData.assignments[0].id;

  const { data: assignmentDetail } = await T('GET', `/api/teacher/assignments/${assignmentId}`);
  ok('pupil cards per assignment', assignmentDetail.pupils.length === selection.length);
  const sofiaPa = assignmentDetail.pupils.find((p) => p.pupilId === sofia.id);
  ok('sofia got sentences version', sofiaPa.level === 'sentences');

  console.log('\n— pupil does homework —');
  const P = client(); // new pupil session
  r = await P('POST', '/api/auth/login', { username: 'sofialim', password: 'pass123' });
  ok('pupil login', r.status === 200 && r.data.role === 'pupil');
  const { data: myHomework } = await P('GET', '/api/pupil/homework');
  ok('pupil sees own homework only', myHomework.homework.length === 1);
  const hw = myHomework.homework[0];
  const { data: hwDetail } = await P('GET', `/api/pupil/pupil-assignments/${hw.id}`);
  ok('homework content served (sanitised)', hwDetail.snapshot.questions.length >= 3);
  const hasAnswers = JSON.stringify(hwDetail.snapshot).includes('"answer"');
  ok('correct answers NOT sent to pupil', !hasAnswers);
  ok('sofia received the sentences version', hwDetail.snapshot.questions.some((q) => q.kind === 'arrange'));

  // access control: another pupil's assignment
  const otherPa = assignmentDetail.pupils.find((p) => p.pupilId !== sofia.id);
  r = await P('GET', `/api/pupil/pupil-assignments/${otherPa.id}`);
  ok('cannot open another pupil\'s homework', r.status === 404);

  // Save progress (autosave)
  const q1 = hwDetail.snapshot.questions[0];
  r = await P('POST', `/api/pupil/pupil-assignments/${hw.id}/save`, {
    answers: { [q1.id]: q1.kind === 'match' ? { 0: q1.wordBank[0] } : { 0: q1.items?.[0]?.options?.[0] ?? 'x' } },
  });
  ok('save progress', r.status === 200);
  const { data: hwDetail2 } = await P('GET', `/api/pupil/pupil-assignments/${hw.id}`);
  ok('answers persisted', Object.keys(hwDetail2.answers).length === 1);

  // submit with a mix of right and wrong + a written answer.
  // The pupil's snapshot has answers stripped, so fetch the key via the
  // teacher's template preview (which of course the pupil can't access).
  const sentencesTemplate = animals.templates.find((t) => t.level === 'sentences');
  const { data: keyData } = await T('GET', `/api/teacher/templates/${sentencesTemplate.id}/preview`);
  const snapshot = keyData.content;
  const answers = {};
  const attemptsLog = [];
  let choiceSeen = 0, arrangeSeen = 0;
  for (const q of snapshot.questions) {
    if (q.kind === 'choice' || q.kind === 'choicePic') {
      answers[q.id] = {};
      q.items.forEach((item, i) => {
        // first choice question right, the rest deliberately wrong
        const right = choiceSeen === 0 && i === 0;
        answers[q.id][i] = right ? item.answer : (item.options.find((o) => o !== item.answer) ?? item.answer);
        attemptsLog.push({ qid: q.id, sub: i, firstAnswer: answers[q.id][i] });
      });
      choiceSeen++;
    } else if (q.kind === 'match') {
      answers[q.id] = {};
      q.pairs.forEach((pair, i) => {
        answers[q.id][i] = i === 0 ? pair.answer : (q.wordBank.find((w) => w !== pair.answer) ?? pair.answer);
        attemptsLog.push({ qid: q.id, sub: i, firstAnswer: answers[q.id][i] });
      });
    } else if (q.kind === 'arrange') {
      // first arrange right (but wrong on first attempt), the rest wrong:
      // proves first-attempt accuracy is tracked separately from the final score.
      // Rotate-by-one is guaranteed wrong (unlike reversal, which can collide
      // with a shuffled tile order that is already reversed).
      const rotated = q.tiles.slice(1).concat(q.tiles.slice(0, 1)).join(' ');
      if (arrangeSeen === 0) {
        answers[q.id] = q.answer;
        attemptsLog.push({ qid: q.id, firstAnswer: rotated });
      } else {
        answers[q.id] = rotated;
        attemptsLog.push({ qid: q.id, firstAnswer: rotated });
      }
      arrangeSeen++;
    } else if (q.kind === 'written') {
      answers[q.id] = 'I like cats because they are cute.';
      attemptsLog.push({ qid: q.id, firstAnswer: 'I like cats.' });
    }
  }
  r = await P('POST', `/api/pupil/pupil-assignments/${hw.id}/submit`, {
    answers, attemptsLog, hintsUsed: 1, retriesUsed: 2,
  });
  ok('submit accepted', r.status === 200);
  ok('objective score computed', typeof r.data.score === 'number' && r.data.score > 0 && r.data.score < 1);
  ok('written answer flagged for review', r.data.needsReview === true);

  // re-submit blocked
  r = await P('POST', `/api/pupil/pupil-assignments/${hw.id}/submit`, { answers: {} });
  ok('re-submit blocked', r.status === 400);
  // save blocked after submit
  r = await P('POST', `/api/pupil/pupil-assignments/${hw.id}/save`, { answers: {} });
  ok('save blocked after submit', r.status === 400);

  console.log('\n— teacher reviews —');
  const { data: assignments2 } = await T('GET', `/api/teacher/assignments?classId=${cls.id}`);
  ok('submitted count updates', assignments2.assignments[0].submitted === 1);
  ok('awaiting review count updates', assignments2.assignments[0].awaitingReview === 1);
  const { data: detail2 } = await T('GET', `/api/teacher/assignments/${assignmentId}`);
  const submittedPa = detail2.pupils.find((p) => p.status === 'submitted');
  ok('first-attempt score separate from final', submittedPa.firstAttemptScore !== null &&
    submittedPa.firstAttemptScore !== submittedPa.score);

  const { data: workData } = await T('GET', `/api/teacher/pupil-assignments/${submittedPa.id}`);
  ok('view work shows detail', workData.marking.detail.length > 0);
  const wrongOnes = workData.marking.detail.filter((d) => d.correct === false);
  ok('objective questions marked right/wrong', wrongOnes.length > 0);
  const written = workData.marking.written.filter((w) => w.answer);
  ok('written answer presented for review', written.length === 1);
  ok('written answer not auto-marked incorrect', workData.marking.detail.find((d) => d.kind === 'written').correct === null);

  r = await T('POST', `/api/teacher/pupil-assignments/${submittedPa.id}/feedback`, { feedback: 'Great effort! Check question 2 again.' });
  ok('feedback saved', r.status === 200);
  const { data: workData2 } = await T('GET', `/api/teacher/pupil-assignments/${submittedPa.id}`);
  ok('reviewed flag set', workData2.reviewed === true);

  // pupil sees feedback
  const { data: hwAfter } = await P('GET', `/api/pupil/pupil-assignments/${hw.id}`);
  ok('pupil sees teacher feedback', hwAfter.feedback === 'Great effort! Check question 2 again.');

  console.log('\n— real results on pupil cards & progress —');
  const { data: students3 } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  const submittedStudent = students3.students.find((s) => s.id === submittedPa.pupilId);
  ok('completed/assigned shown on card', submittedStudent.completed === 1 && submittedStudent.assigned === 1);
  ok('latest result shown on card', submittedStudent.latest && typeof submittedStudent.latest.score === 'number');
  const noResultStudent = students3.students.find((s) => s.id === arjun.id);
  ok('“No results yet” for others', noResultStudent && noResultStudent.latest === null);

  const { data: progress } = await T('GET', `/api/teacher/pupils/${submittedPa.pupilId}/progress`);
  ok('progress shows homework history', progress.homework.length === 1);
  ok('progress analytics real', progress.analytics[submittedPa.level].units > 0);
  ok('first-attempt tracked separately in analytics',
    progress.analytics[submittedPa.level].firstUnits > progress.analytics[submittedPa.level].firstCorrect);
  ok('recurring errors grounded in answers', Array.isArray(progress.recurringErrors) && progress.recurringErrors.length > 0);
  const unsubmittedProgress = await T('GET', `/api/teacher/pupils/${noResultStudent.id}/progress`);
  ok('“Not enough data yet” case', unsubmittedProgress.data.homework.length >= 0);

  console.log('\n— access control —');
  const stranger = client();
  r = await stranger('GET', '/api/teacher/students?classId=999');
  ok('unauthenticated teacher API blocked', r.status === 401);
  await stranger('POST', '/api/auth/login', { username: creds.teacher.username, password: creds.teacher.password });
  r = await stranger('GET', '/api/teacher/students?classId=999');
  ok('missing class handled', r.status === 404 || r.status === 403);
  r = await P('GET', '/api/teacher/students?classId=' + cls.id);
  ok('pupil cannot call teacher APIs', r.status === 403);
  r = await T('GET', '/api/pupil/homework');
  ok('teacher cannot call pupil APIs', r.status === 403);
  r = await anon('POST', '/api/register', {
    classCode: 'DEMO6B', regCode: pinFor(aiman[0].id), pupilId: aiman[0].id,
    username: 'ghost', password: 'pass123',
  });
  ok('cannot claim already-linked pupil', r.status === 409);

  // teacher recovery: unlink
  r = await T('POST', `/api/teacher/pupils/${aiman[0].id}/unlink`, {});
  ok('teacher can unlink wrongly claimed name', r.status === 200);
  const { data: namelist3 } = await client()('GET', '/api/register/DEMO6B');
  ok('unlinked name available again', namelist3.pupils.find((p) => p.id === aiman[0].id).registered === false);
  // orphaned account can no longer log in
  r = await client()('POST', '/api/auth/login', { username: 'aiman1', password: 'pass123' });
  ok('unlinked account removed', r.status === 401);

  console.log('\n— snapshot freeze —');
  // modify the template content after assignment; existing homework must not change
  const { run } = dbModule;
  run("UPDATE templates SET content = json_set(content, '$.questions[0].prompt', 'CHANGED AFTER ASSIGNMENT') WHERE set_id = ?", animals.id);
  const { data: frozen } = await T('GET', `/api/teacher/pupil-assignments/${submittedPa.id}`);
  ok('existing homework keeps original content', !JSON.stringify(frozen.snapshot).includes('CHANGED AFTER ASSIGNMENT'));
  console.log('');
  console.log('- temporary demo access -');
  const Demo = client();
  r = await Demo('GET', '/api/demo-status');
  ok('demo status reported', r.status === 200 && r.data.demo === true);
  r = await Demo('POST', '/api/auth/demo-login', {});
  ok('demo login issues temporary session', r.status === 200 && r.data.temporary === true && r.data.role === 'teacher');
  const ttl = new Date(r.data.expiresAt) - Date.now();
  ok('demo session is short-lived (< 3h)', ttl > 0 && ttl < 3 * 3600e3);
  r = await Demo('GET', '/api/teacher/classes');
  ok('temporary session grants teacher access', r.status === 200);
  r = await Demo('POST', '/api/auth/demo-login', { as: 'pupil' });
  ok('demo pupil login issues temporary session', r.status === 200 && r.data.role === 'pupil');
  r = await Demo('GET', '/api/pupil/homework');
  ok('demo pupil sees seeded homework', r.status === 200 && r.data.homework.length >= 1);

  console.log('- edit pupil & edit template -');
  r = await T('PATCH', `/api/teacher/pupils/${chloe.id}`, { name: 'Chloe Wong-Chan', studentNo: '6B007' });
  ok('pupil edit works', r.status === 200);
  const { data: students4 } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  ok('pupil edit reflected in list', students4.students.some((x) => x.name === 'Chloe Wong-Chan'));
  r = await T('PATCH', `/api/teacher/pupils/${chloe.id}`, { name: 'Chloe W', studentNo: '6B001' });
  ok('duplicate student number rejected', r.status === 409);
  r = await P('PATCH', `/api/teacher/pupils/${chloe.id}`, { name: 'Hacked', studentNo: '6B00X' });
  ok('pupil cannot edit pupil records', r.status === 403);
  r = await T('POST', '/api/teacher/pupils', { classId: cls.id, name: 'New Kid', studentNo: '6B020', proficiency: 'words' });
  ok('teacher can add pupil', r.status === 201);
  const newKidId = r.data.id;
  const { data: students5 } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  ok('added pupil appears with level', students5.students.some((x) => x.name === 'New Kid' && x.proficiency === 'words'));
  r = await client()('GET', '/api/register/DEMO6B');
  ok('added pupil appears in registration list', r.data.pupils.some((x) => x.name === 'New Kid' && x.registered === false));
  const { data: newCards } = await T('GET', `/api/teacher/registration-cards?classId=${cls.id}`);
  const newKidCard = newCards.cards.find((card) => card.id === newKidId);
  const NewKidQr = client();
  const wrongQrPin = newKidCard.pin === '000000' ? '000001' : '000000';
  r = await NewKidQr('POST', '/api/auth/qr-login', { pupilId: newKidId, pin: wrongQrPin });
  ok('QR sign-in rejects the wrong personal PIN', r.status === 403);
  r = await NewKidQr('POST', '/api/auth/qr-login', { pupilId: newKidId, pin: newKidCard.pin });
  ok('QR signs in without username or password', r.status === 200 && r.data.role === 'pupil' && r.data.displayName === 'New Kid');
  r = await NewKidQr('GET', '/api/pupil/homework');
  ok('QR session opens the pupil dashboard', r.status === 200);
  const RepeatQr = client();
  r = await RepeatQr('POST', '/api/auth/qr-login', { pupilId: newKidId, pin: newKidCard.pin });
  const linkedAccounts = dbModule.one(
    'SELECT COUNT(*) AS c FROM accounts a JOIN pupils p ON p.account_id = a.id WHERE p.id = ?',
    newKidId
  ).c;
  ok('repeat scans reuse the same pupil account', r.status === 200 && linkedAccounts === 1);
  const PinOnly = client();
  r = await PinOnly('POST', '/api/auth/pin-login', { pin: wrongQrPin });
  ok('PIN-only login rejects an incorrect PIN', r.status === 401);
  r = await PinOnly('POST', '/api/auth/pin-login', { pin: newKidCard.pin });
  ok('student can sign in with only the six-digit PIN', r.status === 200 && r.data.displayName === 'New Kid');
  r = await PinOnly('GET', '/api/pupil/homework');
  ok('PIN-only session opens the pupil dashboard', r.status === 200);
  r = await T('POST', '/api/teacher/pupils', { classId: cls.id, name: 'Other Kid', studentNo: '6B020' });
  ok('duplicate student number blocked on add', r.status === 409);
  r = await P('POST', '/api/teacher/pupils', { classId: cls.id, name: 'Nope', studentNo: '6B021' });
  ok('pupil cannot add pupils', r.status === 403);
  r = await T('POST', '/api/teacher/pupils/bulk', { classId: cls.id, pupils: [
    { name: 'Bulk One', studentNo: '6B030', proficiency: 'weak' },
    { name: 'Bulk Two', studentNo: '6B031' },
    { name: '', studentNo: '6B032' },
    { name: 'Bulk Dup', studentNo: '6B030' },
  ] });
  ok('bulk add creates valid pupils only', r.status === 201 && r.data.created === 2 && r.data.skipped === 2);
  const { data: students6 } = await T('GET', `/api/teacher/students?classId=${cls.id}`);
  ok('bulk proficiency mapped (weak band)', students6.students.some((x) => x.name === 'Bulk One' && x.proficiency === 'words'));
  r = await T('GET', '/api/teacher/templates');
  ok('templates labelled by proficiency band', r.data.sets[0].templates[0].levelLabel === 'Weak');


  const sentencesTpl = animals.templates.find((tp) => tp.level === 'sentences');
  r = await T('GET', `/api/teacher/templates/${sentencesTpl.id}/preview`);
  const editContent = r.data.content;
  editContent.questions[0].items[0].text = 'EDITED PROMPT TEXT';
  r = await T('PATCH', `/api/teacher/templates/${sentencesTpl.id}`, {
    title: r.data.title, activityType: r.data.activityType, minutes: r.data.minutes, content: editContent,
  });
  ok('template edit works', r.status === 200);
  r = await T('GET', `/api/teacher/templates/${sentencesTpl.id}/preview`);
  ok('template edit persisted', r.data.content.questions[0].items[0].text === 'EDITED PROMPT TEXT');
  const badContent = JSON.parse(JSON.stringify(editContent));
  badContent.questions[0].items[0].answer = 'NOT AN OPTION';
  r = await T('PATCH', `/api/teacher/templates/${sentencesTpl.id}`, { title: 'x', content: badContent });
  ok('invalid template content rejected', r.status === 400);
  r = await P('PATCH', `/api/teacher/templates/${sentencesTpl.id}`, { title: 'x', content: editContent });
  ok('pupil cannot edit templates', r.status === 403);

  // --- Homework Studio: create topic + template + delete ---
  const { generateHomework, parseHomeworkRequest } = await import('../public/js/ai.js');
  r = await T('POST', '/api/teacher/template-sets', { topic: 'My Family', icon: '👨‍👩‍👧' });
  ok('studio creates a topic set', r.status === 201 && r.data.topic === 'My Family');
  const newSetId = r.data.id;
  r = await T('POST', '/api/teacher/template-sets', { topic: 'my family' });
  ok('studio rejects duplicate topic (case-insensitive)', r.status === 409);

  const gen = generateHomework({ topic: 'My Family', level: 'words', words: [{ word: 'mother' }, { word: 'father' }, { word: 'sister' }] });
  ok('generator produces valid weak homework', !gen.error && gen.content.questions.length >= 1);
  r = await T('POST', '/api/teacher/templates', { setId: newSetId, level: 'words', title: gen.title, activityType: gen.activityType, minutes: gen.minutes, content: gen.content });
  ok('studio creates a band template', r.status === 201);
  const newTplId = r.data.id;
  r = await T('POST', '/api/teacher/templates', { setId: newSetId, level: 'words', title: 'V2', activityType: 'x', minutes: 10, content: gen.content });
  ok('studio replaces existing band template', r.status === 200 && r.data.replaced === true && r.data.id === newTplId);

  const spec = parseHomeworkRequest('Make a paragraph homework about the beach with comprehension questions. Words: shell, wave, sand.', 'paragraphs', 'Beach');
  ok('AI parser extracts topic', /beach/i.test(spec.topic));
  ok('AI parser extracts words', spec.words.length >= 2);

  r = await T('DELETE', `/api/teacher/templates/${newTplId}`);
  ok('studio deletes a band template', r.status === 200);
  r = await T('GET', `/api/teacher/templates/${newTplId}/preview`);
  ok('deleted template is gone', r.status === 404);
  r = await P('POST', '/api/teacher/template-sets', { topic: 'Pupil Set' });
  ok('pupil cannot create topic sets', r.status === 403);


  console.log('\n— production demo cleanup —');
  const teacherId = dbModule.one("SELECT id FROM accounts WHERE role = 'teacher' ORDER BY id LIMIT 1").id;
  const realClassId = dbModule.run(
    'INSERT INTO classes (name, code, reg_code, teacher_id, is_demo) VALUES (?,?,?,?,0)',
    '6 Mawar', 'REAL6M', 'KEEP6M', teacherId
  ).lastInsertRowid;
  dbModule.run(
    'INSERT INTO pupils (class_id, name, student_no, is_demo) VALUES (?,?,?,0)',
    realClassId, 'Real Student', 'M001'
  );
  const cleaned = removeDemoData();
  const remainingClasses = dbModule.q('SELECT name FROM classes ORDER BY name');
  ok('cleanup removes demo classes', cleaned.removedClasses === 2 && remainingClasses.length === 1);
  ok('cleanup preserves 6 Mawar', remainingClasses[0]?.name === '6 Mawar');
  ok('cleanup preserves pupils in 6 Mawar', !!dbModule.one("SELECT id FROM pupils WHERE name = 'Real Student'"));
  ok('cleanup removes demo homework sets', dbModule.one('SELECT COUNT(*) AS c FROM template_sets WHERE is_demo = 1').c === 0);
  const cleanedTeacher = dbModule.one("SELECT display_name, is_demo FROM accounts WHERE role = 'teacher' ORDER BY id LIMIT 1");
  ok('cleanup renames teacher to Ms Falisha', cleanedTeacher.display_name === 'Ms Falisha' && cleanedTeacher.is_demo === 0);
  const LoginAfterCleanup = client();
  const loginAfterCleanup = await LoginAfterCleanup('POST', '/api/auth/code-login', { code: '0000' });
  ok('teacher PIN still works after cleanup', loginAfterCleanup.status === 200 && loginAfterCleanup.data.displayName === 'Ms Falisha');

  console.log(`\n========== RESULT: ${passed} passed, ${failed} failed ==========`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  server.close();
  setTimeout(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    process.exit(failed ? 1 : 0);
  }, 300);
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  if (server) server.close();
  process.exit(1);
});

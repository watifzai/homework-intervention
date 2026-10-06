# Year 6 English Intervention Platform

A simple, practical teacher admin dashboard and pupil registration/homework workflow for a Year 6 English intervention programme.

- **Three proficiency bands**: Weak, Intermediate, Advanced — set by the teacher, labelled on every pupil card. Each band has its own homework template version, fully editable by the teacher.
- **Reusable homework templates** grouped into topic sets (School Objects, Food, Animals). Each set has a version for every level.
- **Level-matched assignments**: the teacher picks a topic set; each pupil receives the version for their teacher-set level.
- **Content snapshots**: once assigned, homework content is frozen so later template edits never change existing work.
- **Mobile-friendly registration**: pupils join using a class code and a teacher-issued registration code, then select their name from the class namelist.
- **One account per pupil** enforced in the database (including against concurrent registration attempts).

## Languages

The interface is available in **English** and **Bahasa Melayu**. Use the **EN | BM** switch in the header of any page; the choice is remembered per device (it is a UI preference only — all shared data lives in the database). Homework content stays in English by design (it is the intervention material), but in Malay mode each question shows a Malay helper line so weak readers understand the task. Common server messages (wrong code, wrong password, duplicate name, etc.) are translated too.

## Quick start

Requires **Node.js >= 22.5** (uses the built-in `node:sqlite` module — zero external dependencies).

```bash
# Start the server (seeds demo data on first run)
npm start

# Or run the end-to-end verification script
npm run verify
```

Open [http://localhost:3000](http://localhost:3000). Both login pages have a **Temporary demo access** button — one click into the demo teacher account or a demo pupil (Ryan Tan, with sample homework), no password needed; sessions expire after 2 hours (server-enforced). The buttons hide automatically when no demo account exists.

## Demo credentials

A demo teacher and two demo classes are created on first start. All demo rows carry `is_demo = 1` and are clearly labelled in the UI, separate from real class records.

- **Teacher**: log in with the access code **0000** on the teacher login page (change it via the `TEACHER_CODE` environment variable)
- **Demo classes**: `DEMO6B` (6 Bestari) and `DEMO6C` (6 Cekap)
- **Pupil registration**: ask the teacher for the class code and the 6-character registration code shown on the teacher dashboard.

## Teacher workflow

1. **Students** — view pupils as a responsive card grid with a proficiency label on each card. Add pupils manually or in bulk (paste a namelist JSON converted by ChatGPT; instructions are built into the app). Edit names and student numbers, set proficiency, search and filter, and use **Unlink account** if a name was claimed by the wrong person.
2. **Assign Homework** — pick a topic set. The preview shows which level each pupil will receive. Pupils without a level are flagged and skipped; unregistered pupils still get the assignment and it unlocks when they register.
3. **Homework Manager** — see assignment cards with assigned / submitted / awaiting-review counts. Open an assignment to view each pupil’s status, score, first-attempt accuracy, hints/retries, and written-answer review status. Click **View work** to see every question, auto-marked results, and written answers awaiting review, then leave feedback.
4. **View progress** (from a pupil card) — see completion history, honest analytics per level (final accuracy and first-attempt accuracy tracked separately), written-review counts, recent homework with feedback, and recurring errors grounded in actual wrong answers.

## Pupil workflow

1. **Registration** — go to the registration link (e.g. `/register.html?class=DEMO6B`), enter the teacher’s registration code, tap your name, and create a username + password.
2. **My Homework** — after logging in, see only your own homework cards. Tap **Start / Continue / View feedback**.
3. **Do homework** — study the target words / model sentences / reading, then answer questions. Objective questions are auto-marked; written answers always wait for teacher review (they are never auto-failed). Tap **Save progress** to continue later.
4. **Submit** — once submitted, you can’t edit. Teacher feedback appears on the card.

## Architecture

- **Server**: Node built-in `http` + `node:sqlite` + `crypto.scrypt` (password hashing) + random-token sessions stored server-side in SQLite (delivered as HttpOnly cookies).
- **Frontend**: vanilla JS (ES modules), no build step. Shared CSS with responsive cards, large touch targets, and clean states (loading, empty, error, success).
- **Database**: single SQLite file with WAL mode. Schema supports classes, pupils, accounts, sessions, template sets/templates, assignments, and per-pupil assignment snapshots with answers, attempts, and teacher feedback.
- **Security**: all access control enforced server-side. Teachers manage only their own classes. Pupils access only their own assignments. Correct answers are stripped from snapshots before they reach the pupil’s browser.

## File map

```
server/
  db.js          — schema, connection, helpers
  index.js       — HTTP server + all API routes
  seed.js        — demo data (labelled, separate from real records)
  passwords.js   — scrypt password hashing
  sessions.js    — opaque token sessions (server-side SQLite)
  marking.js     — auto-marking engine + sanitisation
public/
  index.html            — landing page
  teacher-login.html    — teacher login
  teacher.html          — teacher dashboard (Students / Assign / Manager)
  register.html         — pupil registration (mobile-friendly)
  student-login.html    — pupil login
  student.html          — pupil homework view
  css/style.css         — shared responsive styles
  js/common.js          — shared API client + DOM helpers
scripts/
  verify.js        — end-to-end workflow verification (throwaway DB)
```

## Verification

`npm run verify` runs a complete end-to-end test against a temporary database:

- register and link an existing pupil
- prevent duplicate name claims (including concurrent attempts)
- set/change proficiency
- preview and assign level-matched homework
- complete and submit homework (save progress, continue later)
- review written answers and leave feedback
- display real results on pupil cards
- enforce access control (teachers only their classes, pupils only their own work)
- verify snapshot freeze (later template edits do not alter existing homework)

## Notes

- The platform does not use browser `localStorage` as a database. All shared state lives in SQLite.
- Pupils without a set proficiency display **“Set level”** on the teacher dashboard; they are never automatically classified as weak.
- Analytics are honest and minimal: real accuracy counts, first-attempt accuracy separate from post-hint/post-retry results, written work tracked by review status. No invented data, no unsupported labels, no automatic proficiency changes.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, 'bemutatoorak.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Normalizált táblák létrehozása
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_director INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_placeholder INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_id INTEGER NOT NULL,
    period INTEGER NOT NULL,
    time TEXT NOT NULL,
    teacher_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    group_name TEXT,
    title TEXT,
    note TEXT,
    max_capacity INTEGER NOT NULL DEFAULT 15,
    is_active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (date_id) REFERENCES event_dates(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE RESTRICT,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    school TEXT NOT NULL,
    has_companion INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, email)
  );

  CREATE TABLE IF NOT EXISTS admin_pins (
    email TEXT PRIMARY KEY,
    pin TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES ('deadline', '2026-11-27T12:00')
`).run();

// Teljes adatbázis állapot kinyerése mentéshez
export function exportFullState() {
  const settings = db.prepare('SELECT * FROM settings').all();
  const dates = db.prepare('SELECT * FROM event_dates ORDER BY id ASC').all();
  const teachers = db.prepare('SELECT * FROM teachers ORDER BY id ASC').all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id ASC').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY id ASC').all();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id ASC').all();
  const registrations = db.prepare('SELECT * FROM registrations ORDER BY id ASC').all();

  return {
    savedAt: new Date().toISOString(),
    settings,
    dates,
    teachers,
    rooms,
    subjects,
    sessions,
    registrations
  };
}

// Teljes adatbázis visszaállítása Drive mentésből
export function restoreFullState(backup) {
  const restoreTx = db.transaction((data) => {
    db.prepare('DELETE FROM registrations').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM subjects').run();
    db.prepare('DELETE FROM rooms').run();
    db.prepare('DELETE FROM teachers').run();
    db.prepare('DELETE FROM event_dates').run();

    if (Array.isArray(data.settings)) {
      const insSet = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const s of data.settings) insSet.run(s.key, s.value);
    }

    const insDate = db.prepare('INSERT INTO event_dates (id, date) VALUES (?, ?)');
    for (const d of (data.dates || [])) insDate.run(d.id, d.date);

    const insTeacher = db.prepare('INSERT INTO teachers (id, name, is_director) VALUES (?, ?, ?)');
    for (const t of (data.teachers || [])) insTeacher.run(t.id, t.name, t.is_director);

    const insRoom = db.prepare('INSERT INTO rooms (id, name, is_placeholder) VALUES (?, ?, ?)');
    for (const r of (data.rooms || [])) insRoom.run(r.id, r.name, r.is_placeholder);

    const insSub = db.prepare('INSERT INTO subjects (id, name) VALUES (?, ?)');
    for (const sub of (data.subjects || [])) insSub.run(sub.id, sub.name);

    const insSession = db.prepare(`
      INSERT INTO sessions (id, date_id, period, time, teacher_id, room_id, subject_id, group_name, title, note, max_capacity, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of (data.sessions || [])) {
      insSession.run(s.id, s.date_id, s.period, s.time, s.teacher_id, s.room_id, s.subject_id, s.group_name, s.title, s.note, s.max_capacity, s.is_active);
    }

    const insReg = db.prepare(`
      INSERT INTO registrations (id, session_id, role, email, name, school, has_companion, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of (data.registrations || [])) {
      insReg.run(r.id, r.session_id, r.role, r.email, r.name, r.school, r.has_companion, r.created_at);
    }
  });

  restoreTx(backup);
}

// Alapértelmezett adatok betöltése az oraadatok.json-ból (csak legelső induláskor)
function seedFromInitialJson() {
  const jsonPath = path.join(__dirname, 'oraadatok.json');
  const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const insertDate = db.prepare('INSERT OR IGNORE INTO event_dates (date) VALUES (?)');
  const getDateId = db.prepare('SELECT id FROM event_dates WHERE date = ?');
  const insertTeacher = db.prepare('INSERT OR IGNORE INTO teachers (name, is_director) VALUES (?, ?)');
  const getTeacherId = db.prepare('SELECT id FROM teachers WHERE name = ?');
  const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (name, is_placeholder) VALUES (?, ?)');
  const getRoomId = db.prepare('SELECT id FROM rooms WHERE name = ?');
  const insertSubject = db.prepare('INSERT OR IGNORE INTO subjects (name) VALUES (?)');
  const getSubjectId = db.prepare('SELECT id FROM subjects WHERE name = ?');
  const insertSession = db.prepare(`
    INSERT INTO sessions (date_id, period, time, teacher_id, room_id, subject_id, group_name, title, note, max_capacity, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedTx = db.transaction((days) => {
    insertRoom.run('Kijelölés alatt', 1);
    insertRoom.run('Igazgatói iroda / Tárgyaló', 0);
    const directorRoomId = getRoomId.get('Igazgatói iroda / Tárgyaló').id;

    insertTeacher.run('Blanka (Igazgató)', 1);
    const directorTeacherId = getTeacherId.get('Blanka (Igazgató)').id;

    insertSubject.run('Beszélgetés az igazgatóval');
    const directorSubjectId = getSubjectId.get('Beszélgetés az igazgatóval').id;

    for (const dayObj of days) {
      insertDate.run(dayObj.date);
      const dateId = getDateId.get(dayObj.date).id;

      for (const p of dayObj.lessons) {
        const slots = [p.lesson1, p.lesson2].filter(Boolean);
        for (const lesson of slots) {
          const tName = lesson.teacher.trim();
          insertTeacher.run(tName, 0);
          const teacherId = getTeacherId.get(tName).id;

          const rName = (lesson.room || 'Kijelölés alatt').trim();
          insertRoom.run(rName, rName === 'Kijelölés alatt' ? 1 : 0);
          const roomId = getRoomId.get(rName).id;

          const sName = lesson.subject.trim();
          insertSubject.run(sName);
          const subjectId = getSubjectId.get(sName).id;

          insertSession.run(dateId, p.period, p.time, teacherId, roomId, subjectId, lesson.group || '', lesson.title || '', lesson.note || '', 15, 1);
        }

        const isDirActive = (dayObj.date === '2026-12-02' || dayObj.date === '2026-12-03') ? 1 : 0;
        insertSession.run(dateId, p.period, p.time, directorTeacherId, directorRoomId, directorSubjectId, 'Szülői tájékoztató', 'Kötetlen beszélgetés és tájékoztatás szülőknek', 'Kizárólag szülők részére (max. 5 fő)', 5, isDirActive);
      }
    }
  });

  seedTx(rawData.days);
  console.log('Kezdeti adatok betöltve az oraadatok.json fájlból.');
}

// Szerver indulásakor lefutó automatikus visszaállító függvény
export async function initializeDatabase() {
  const dateCount = db.prepare('SELECT COUNT(*) as count FROM event_dates').get().count;
  if (dateCount > 0) {
    console.log('Helyi SQLite adatbázis már tartalmaz adatokat.');
    return false;
  }

  // Ha üres az adatbázis (pl. Render újraindulás), megpróbáljuk betölteni a Google Drive-ról
  if (process.env.GAS_EMAIL_URL) {
    try {
      console.log('Üres adatbázis észlelve – állapot ellenőrzése a Google Drive-on...');
      const response = await fetch(process.env.GAS_EMAIL_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          secret: process.env.SESSION_SECRET || 'bemutatoorak-secret',
          action: 'load_backup'
        })
      });

      const result = await response.json();
      if (result.found && result.backup) {
        restoreFullState(result.backup);
        console.log(`✅ Sikeres automatikus visszaállítás a Google Drive-ról! (Mentés ideje: ${result.backup.savedAt})`);
        return false;
      }
    } catch (err) {
      console.error('⚠️ Google Drive visszaállítási hiba (átállás alapértelmezett JSON-ra):', err.message);
    }
  }

  // Ha még nincs Drive mentés, betöltjük az oraadatok.json-t, és jelezzük, hogy el kell menteni Drive-ra
  seedFromInitialJson();
  return true;
}

export default db;
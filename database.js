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

// Alapértelmezett határidő beállítása, ha még nincs
db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES ('deadline', '2026-11-27T12:00')
`).run();

// Kezdeti adatok betöltése az oraadatok.json-ból, ha üres az event_dates tábla
const dateCount = db.prepare('SELECT COUNT(*) as count FROM event_dates').get().count;

if (dateCount === 0) {
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
    // Alapértelmezett speciális rekordok felvétele
    insertRoom.run('Kijelölés alatt', 1);
    const placeholderRoomId = getRoomId.get('Kijelölés alatt').id;

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

          insertSession.run(
            dateId,
            p.period,
            p.time,
            teacherId,
            roomId,
            subjectId,
            lesson.group || '',
            lesson.title || '',
            lesson.note || '',
            15,
            1
          );
        }

        // Igazgatói beszélgetés hozzáadása (Dec 2 és Dec 3 aktív, Dec 4 inaktív)
        const isDirActive = (dayObj.date === '2026-12-02' || dayObj.date === '2026-12-03') ? 1 : 0;
        insertSession.run(
          dateId,
          p.period,
          p.time,
          directorTeacherId,
          directorRoomId,
          directorSubjectId,
          'Szülői tájékoztató',
          'Kötetlen beszélgetés és tájékoztatás szülőknek',
          'Kizárólag szülők részére (max. 5 fő)',
          5,
          isDirActive
        );
      }
    }
  });

  seedTx(rawData.days);
  console.log('Normalizált adatbázis sikeresen feltöltve!');
}

export default db;
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, 'bemutatoorak.db'));
db.pragma('journal_mode = WAL');

// Táblák létrehozása
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    day_name TEXT NOT NULL,
    period INTEGER NOT NULL,
    time TEXT NOT NULL,
    slot_type TEXT NOT NULL, -- 'lesson1', 'lesson2', 'director'
    teacher TEXT,
    group_name TEXT,
    subject TEXT,
    title TEXT,
    room TEXT,
    note TEXT,
    max_capacity INTEGER NOT NULL DEFAULT 15,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL, -- 'student' vagy 'parent'
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    school TEXT NOT NULL,
    has_companion INTEGER NOT NULL DEFAULT 0, -- 0 vagy 1
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

// Kezdeti adatok betöltése az oraadatok.json-ból, ha még üres a sessions tábla
const rowCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;

if (rowCount === 0) {
  const jsonPath = path.join(__dirname, 'oraadatok.json');
  const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const insertStmt = db.prepare(`
    INSERT INTO sessions (date, day_name, period, time, slot_type, teacher, group_name, subject, title, room, note, max_capacity, is_active)
    VALUES (@date, @day_name, @period, @time, @slot_type, @teacher, @group_name, @subject, @title, @room, @note, @max_capacity, @is_active)
  `);

  const seedTransaction = db.transaction((days) => {
    for (const dayObj of days) {
      for (const p of dayObj.lessons) {
        // 1. tanóra
        if (p.lesson1) {
          insertStmt.run({
            date: dayObj.date,
            day_name: dayObj.day,
            period: p.period,
            time: p.time,
            slot_type: 'lesson1',
            teacher: p.lesson1.teacher,
            group_name: p.lesson1.group,
            subject: p.lesson1.subject,
            title: p.lesson1.title || '',
            room: p.lesson1.room || 'Kijelölés alatt',
            note: p.lesson1.note || '',
            max_capacity: 15,
            is_active: 1
          });
        }
        // 2. tanóra
        if (p.lesson2) {
          insertStmt.run({
            date: dayObj.date,
            day_name: dayObj.day,
            period: p.period,
            time: p.time,
            slot_type: 'lesson2',
            teacher: p.lesson2.teacher,
            group_name: p.lesson2.group,
            subject: p.lesson2.subject,
            title: p.lesson2.title || '',
            room: p.lesson2.room || 'Kijelölés alatt',
            note: p.lesson2.note || '',
            max_capacity: 15,
            is_active: 1
          });
        }
        // Igazgatói (Blanka) beszélgetés: Dec 2 és Dec 3 minden periodusában aktív, Dec 4-en inaktív (admin aktiválhatja)
        const isDirectorDefaultActive = (dayObj.date === '2026-12-02' || dayObj.date === '2026-12-03') ? 1 : 0;
        insertStmt.run({
          date: dayObj.date,
          day_name: dayObj.day,
          period: p.period,
          time: p.time,
          slot_type: 'director',
          teacher: 'Blanka (Igazgató)',
          group_name: 'Szülői tájékoztató',
          subject: 'Beszélgetés az igazgatóval',
          title: 'Kötetlen beszélgetés és tájékoztatás szülőknek',
          room: 'Igazgatói iroda / Tárgyaló',
          note: 'Kizárólag szülők részére (max. 5 fő)',
          max_capacity: 5,
          is_active: isDirectorDefaultActive
        });
      }
    }
  });

  seedTransaction(rawData.days);
  console.log('Adatbázis sikeresen feltöltve az oraadatok.json alapján.');
}

export default db;
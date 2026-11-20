import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bemutatoorak-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 2 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Segédfüggvény: Dátumból magyar napnév generálása (pl. "2026-12-02" -> "SZERDA")
function getHungarianDayName(dateStr) {
  const days = ['VASÁRNAP', 'HÉTFŐ', 'KEDD', 'SZERDA', 'CSÜTÖRTÖK', 'PÉNTEK', 'SZOMBAT'];
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return days[dt.getDay()] || '';
}

// Segédfüggvény: Órasáv időpontok
const PERIOD_TIMES = {
  1: '8:00 - 8:45',
  2: '8:55 - 9:40',
  3: '9:55 - 10:40',
  4: '10:50 - 11:35',
  5: '11:45 - 12:30'
};

// Segédfüggvény: Határidő lekérdezése az adatbázisból
function getDeadlineInfo() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'deadline'").get();
  const rawValue = row ? row.value : '2026-11-27T12:00';
  const deadlineDate = new Date(rawValue);
  const passed = new Date() > deadlineDate;

  const formatted = deadlineDate.toLocaleString('hu-HU', {
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  return { rawValue, passed, formatted };
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminEmail) {
    return next();
  }
  return res.status(401).json({ error: 'Nincs jogosultságod. Kérlek, jelentkezz be!' });
}

// ==========================================
// E-MAIL KÜLDŐ SEGÉDFÜGGVÉNY (Google Apps Script HTTPS)
// ==========================================
async function sendPinEmail(toEmail, pin) {
  console.log(`[ADMIN PIN] Címzett: ${toEmail} | Kód: ${pin}`);

  if (!process.env.GAS_EMAIL_URL) {
    throw new Error('Nincs beállítva a GAS_EMAIL_URL környezeti változó a Renderen!');
  }

  const response = await fetch(process.env.GAS_EMAIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.SESSION_SECRET || 'bemutatoorak-secret',
      to: toEmail,
      subject: 'Admin belépési PIN-kód - Bemutatóórák',
      html: `
        <p>Szia!</p>
        <p>Az admin felületre történő belépéshez szükséges egyszer használatos PIN-kódod:</p>
        <h2 style="letter-spacing: 4px; color: #2563eb;">${pin}</h2>
        <p>A kód 10 percig érvényes.</p>
      `
    })
  });

  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(`Google Apps Script e-mail hiba: ${result.error || response.statusText}`);
  }
}

// ==========================================
// PUBLIKUS VÉGPONTOK
// ==========================================

app.get('/api/schedule', (req, res) => {
  const deadline = getDeadlineInfo();

  const sessions = db.prepare(`
    SELECT 
      s.id,
      d.date,
      s.period,
      s.time,
      t.name AS teacher,
      t.is_director,
      r.name AS room,
      sub.name AS subject,
      s.group_name,
      s.title,
      s.note,
      s.max_capacity,
      COUNT(reg.id) AS booked_count
    FROM sessions s
    JOIN event_dates d ON s.date_id = d.id
    JOIN teachers t ON s.teacher_id = t.id
    JOIN rooms r ON s.room_id = r.id
    JOIN subjects sub ON s.subject_id = sub.id
    LEFT JOIN registrations reg ON s.id = reg.session_id
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY d.date ASC, s.period ASC, t.is_director ASC, sub.name ASC
  `).all().map(row => ({
    ...row,
    day_name: getHungarianDayName(row.date)
  }));

  res.json({
    deadlinePassed: deadline.passed,
    deadlineText: deadline.formatted,
    sessions
  });
});

app.post('/api/register', (req, res) => {
  const deadline = getDeadlineInfo();
  if (deadline.passed) {
    return res.status(403).json({ error: `A jelentkezési határidő (${deadline.formatted}) lejárt!` });
  }

  const { role, email, name, school, hasCompanion, sessionIds } = req.body;

  if (!role || !['student', 'parent'].includes(role)) {
    return res.status(400).json({ error: 'Kérjük, válaszd ki, hogy tanuló vagy szülő vagy!' });
  }
  if (!email || !email.includes('@') || !name || !name.trim() || !school || !school.trim()) {
    return res.status(400).json({ error: 'Minden kötelező mezőt (név, e-mail, általános iskola) ki kell tölteni!' });
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: 'Legalább egy foglalkozást ki kell választani!' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const companionFlag = hasCompanion ? 1 : 0;

  const registerTx = db.transaction((ids) => {
    const getSession = db.prepare(`
      SELECT 
        s.id, s.period, s.max_capacity, s.date_id,
        d.date, t.is_director, sub.name AS subject,
        COUNT(reg.id) AS booked_count
      FROM sessions s
      JOIN event_dates d ON s.date_id = d.id
      JOIN teachers t ON s.teacher_id = t.id
      JOIN subjects sub ON s.subject_id = sub.id
      LEFT JOIN registrations reg ON s.id = reg.session_id
      WHERE s.id = ? AND s.is_active = 1
      GROUP BY s.id
    `);

    const checkDuplicate = db.prepare('SELECT id FROM registrations WHERE session_id = ? AND email = ?');
    const checkSamePeriod = db.prepare(`
      SELECT r.id FROM registrations r
      JOIN sessions s ON r.session_id = s.id
      WHERE r.email = ? AND s.date_id = ? AND s.period = ?
    `);

    const insertReg = db.prepare(`
      INSERT INTO registrations (session_id, role, email, name, school, has_companion)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const selectedPeriods = new Set();

    for (const id of ids) {
      const target = getSession.get(id);
      if (!target) {
        throw new Error('A kiválasztott foglalkozás nem létezik vagy nem aktív.');
      }

      if (role === 'student' && target.is_director === 1) {
        throw new Error('Tanulóként nem jelentkezhetsz az igazgatói beszélgetésre!');
      }
      if (role === 'parent' && target.is_director !== 1) {
        throw new Error('Szülőként kizárólag az igazgatói beszélgetésre regisztrálhatsz!');
      }

      const periodKey = `${target.date_id}_${target.period}`;
      if (selectedPeriods.has(periodKey)) {
        throw new Error(`Egy időpontban (${target.date}, ${target.period}. óra) csak egy foglalkozásra jelentkezhetsz!`);
      }
      selectedPeriods.add(periodKey);

      if (checkDuplicate.get(id, cleanEmail)) {
        throw new Error(`Erre az órára (${target.date}, ${target.period}. óra - ${target.subject}) már regisztráltál!`);
      }
      if (checkSamePeriod.get(cleanEmail, target.date_id, target.period)) {
        throw new Error(`A(z) ${target.date} ${target.period}. órájában már van egy másik foglalásod!`);
      }

      if (target.booked_count >= target.max_capacity) {
        throw new Error(`Sajnos a(z) "${target.subject}" (${target.date}, ${target.period}. óra) betelt!`);
      }

      insertReg.run(id, role, cleanEmail, name.trim(), school.trim(), companionFlag);
    }
  });

  try {
    registerTx(sessionIds);
    res.json({ success: true, message: 'Sikeres jelentkezés! Köszönjük a regisztrációt.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// ADMIN HITELESÍTÉS
// ==========================================

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.adminEmail), email: req.session?.adminEmail || null });
});

app.post('/api/admin/request-pin', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Add meg az e-mail címed!' });

  const cleanEmail = email.trim().toLowerCase();
  const allowedAdmins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  if (!allowedAdmins.includes(cleanEmail)) {
    return res.status(403).json({ error: 'Ez az e-mail cím nincs jogosultként regisztrálva (ADMIN_EMAILS).' });
  }

  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  db.prepare(`
    INSERT INTO admin_pins (email, pin, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET pin = excluded.pin, expires_at = excluded.expires_at
  `).run(cleanEmail, pin, expiresAt);

  try {
    await sendPinEmail(cleanEmail, pin);
    res.json({ success: true, message: 'A 6 számjegyű PIN-kódot elküldtük az e-mail címedre!' });
  } catch (error) {
    console.error('E-mail küldési hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/verify-pin', (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) return res.status(400).json({ error: 'E-mail és PIN-kód megadása kötelező!' });

  const cleanEmail = email.trim().toLowerCase();
  const record = db.prepare('SELECT * FROM admin_pins WHERE email = ?').get(cleanEmail);

  if (!record || record.pin !== pin.trim()) {
    return res.status(401).json({ error: 'Hibás PIN-kód!' });
  }
  if (Date.now() > record.expires_at) {
    return res.status(401).json({ error: 'A PIN-kód lejárt. Kérj újat!' });
  }

  db.prepare('DELETE FROM admin_pins WHERE email = ?').run(cleanEmail);
  req.session.adminEmail = cleanEmail;

  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ==========================================
// ADMIN DASHBOARD ÉS TÖRZSDATOK LEKÉRDEZÉSE
// ==========================================

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const deadline = getDeadlineInfo();

  const dates = db.prepare('SELECT * FROM event_dates ORDER BY date ASC').all().map(d => ({
    ...d,
    day_name: getHungarianDayName(d.date)
  }));

  const teachers = db.prepare('SELECT * FROM teachers ORDER BY is_director DESC, name ASC').all();
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY is_placeholder DESC, name ASC').all();
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY name ASC').all();

  const sessions = db.prepare(`
    SELECT 
      s.id, s.date_id, s.period, s.time, s.teacher_id, s.room_id, s.subject_id,
      s.group_name, s.title, s.note, s.max_capacity, s.is_active,
      d.date, t.name AS teacher, t.is_director, r.name AS room, sub.name AS subject,
      COUNT(reg.id) AS booked_count,
      COALESCE(SUM(reg.has_companion), 0) AS companion_count
    FROM sessions s
    JOIN event_dates d ON s.date_id = d.id
    JOIN teachers t ON s.teacher_id = t.id
    JOIN rooms r ON s.room_id = r.id
    JOIN subjects sub ON s.subject_id = sub.id
    LEFT JOIN registrations reg ON s.id = reg.session_id
    GROUP BY s.id
    ORDER BY d.date ASC, s.period ASC, t.is_director ASC, sub.name ASC
  `).all().map(s => ({
    ...s,
    day_name: getHungarianDayName(s.date)
  }));

  const roomSummary = db.prepare(`
    SELECT 
      d.date, s.period, s.time,
      r.name AS room, sub.name AS subject, t.name AS teacher,
      COUNT(reg.id) AS applicants_count,
      COALESCE(SUM(reg.has_companion), 0) AS companions_count,
      (COUNT(reg.id) + COALESCE(SUM(reg.has_companion), 0)) AS total_people
    FROM sessions s
    JOIN event_dates d ON s.date_id = d.id
    JOIN teachers t ON s.teacher_id = t.id
    JOIN rooms r ON s.room_id = r.id
    JOIN subjects sub ON s.subject_id = sub.id
    LEFT JOIN registrations reg ON s.id = reg.session_id
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY d.date ASC, s.period ASC, r.name ASC
  `).all().map(r => ({
    ...r,
    day_name: getHungarianDayName(r.date)
  }));

  const registrations = db.prepare(`
    SELECT 
      reg.*,
      d.date, s.period, s.time,
      sub.name AS subject, t.name AS teacher, r.name AS room
    FROM registrations reg
    JOIN sessions s ON reg.session_id = s.id
    JOIN event_dates d ON s.date_id = d.id
    JOIN teachers t ON s.teacher_id = t.id
    JOIN rooms r ON s.room_id = r.id
    JOIN subjects sub ON s.subject_id = sub.id
    ORDER BY d.date ASC, s.period ASC, reg.created_at DESC
  `).all();

  res.json({
    deadline: deadline.rawValue,
    dates,
    teachers,
    rooms,
    subjects,
    sessions,
    roomSummary,
    registrations
  });
});

// Határidő módosítása
app.put('/api/admin/settings/deadline', requireAdmin, (req, res) => {
  const { deadline } = req.body;
  if (!deadline) return res.status(400).json({ error: 'Érvénytelen dátum!' });
  db.prepare("UPDATE settings SET value = ? WHERE key = 'deadline'").run(deadline);
  res.json({ success: true });
});

// ==========================================
// ÜTKÖZÉSVIZSGÁLAT ÉS ÓRÁK KEZELÉSE
// ==========================================

function checkConflicts({ date_id, period, teacher_id, room_id, excludeSessionId = null }) {
  // 1. Tanár ütközés ellenőrzése (ugyanazon a napon és órasávban)
  const teacherConflict = db.prepare(`
    SELECT s.id, sub.name AS subject, t.name AS teacher
    FROM sessions s
    JOIN subjects sub ON s.subject_id = sub.id
    JOIN teachers t ON s.teacher_id = t.id
    WHERE s.date_id = ? AND s.period = ? AND s.teacher_id = ? AND s.is_active = 1
      ${excludeSessionId ? 'AND s.id != ?' : ''}
  `).get(...(excludeSessionId ? [date_id, period, teacher_id, excludeSessionId] : [date_id, period, teacher_id]));

  if (teacherConflict) {
    return `Ütközés: ${teacherConflict.teacher} ebben az órasávban már tart egy órát (${teacherConflict.subject})!`;
  }

  // 2. Terem ütközés ellenőrzése (ha nem placeholder teremről van szó, pl. "Kijelölés alatt")
  const roomInfo = db.prepare('SELECT name, is_placeholder FROM rooms WHERE id = ?').get(room_id);
  if (roomInfo && roomInfo.is_placeholder === 0) {
    const roomConflict = db.prepare(`
      SELECT s.id, sub.name AS subject, t.name AS teacher
      FROM sessions s
      JOIN subjects sub ON s.subject_id = sub.id
      JOIN teachers t ON s.teacher_id = t.id
      WHERE s.date_id = ? AND s.period = ? AND s.room_id = ? AND s.is_active = 1
        ${excludeSessionId ? 'AND s.id != ?' : ''}
    `).get(...(excludeSessionId ? [date_id, period, room_id, excludeSessionId] : [date_id, period, room_id]));

    if (roomConflict) {
      return `Teremütközés: A(z) "${roomInfo.name}" terem ebben az órasávban már foglalt (${roomConflict.teacher} - ${roomConflict.subject})!`;
    }
  }

  return null;
}

// Új óra létrehozása
app.post('/api/admin/sessions', requireAdmin, (req, res) => {
  const { date_id, period, teacher_id, room_id, subject_id, group_name, title, max_capacity } = req.body;

  if (!date_id || !period || !teacher_id || !room_id || !subject_id) {
    return res.status(400).json({ error: 'Minden legördülő mező (Dátum, Órasáv, Tantárgy, Oktató, Terem) kiválasztása kötelező!' });
  }

  const cap = parseInt(max_capacity, 10) || 15;
  if (cap < 1) return res.status(400).json({ error: 'A létszámnak legalább 1-nek kell lennie!' });

  const periodNum = parseInt(period, 10);
  const time = PERIOD_TIMES[periodNum] || `${periodNum}. óra`;

  const conflictError = checkConflicts({ date_id, period: periodNum, teacher_id, room_id });
  if (conflictError) {
    return res.status(409).json({ error: conflictError });
  }

  db.prepare(`
    INSERT INTO sessions (date_id, period, time, teacher_id, room_id, subject_id, group_name, title, max_capacity, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(date_id, periodNum, time, teacher_id, room_id, subject_id, (group_name || '').trim(), (title || '').trim(), cap);

  res.json({ success: true });
});

// Meglévő óra szerkesztése (dátum, órasáv, oktató, terem, tantárgy, cím, létszám, aktivitás)
app.put('/api/admin/sessions/:id', requireAdmin, (req, res) => {
  const sessionId = Number(req.params.id);
  const { date_id, period, teacher_id, room_id, subject_id, title, group_name, max_capacity, is_active } = req.body;

  const cap = parseInt(max_capacity, 10);
  if (isNaN(cap) || cap < 1) {
    return res.status(400).json({ error: 'A létszámlimitnek legalább 1-nek kell lennie!' });
  }

  const periodNum = parseInt(period, 10);
  const time = PERIOD_TIMES[periodNum] || `${periodNum}. óra`;
  const activeFlag = is_active ? 1 : 0;

  // Ha aktív marad/lesz, ellenőrizzük az ütközést
  if (activeFlag === 1) {
    const conflictError = checkConflicts({
      date_id,
      period: periodNum,
      teacher_id,
      room_id,
      excludeSessionId: sessionId
    });
    if (conflictError) {
      return res.status(409).json({ error: conflictError });
    }
  }

  db.prepare(`
    UPDATE sessions
    SET date_id = ?, period = ?, time = ?, teacher_id = ?, room_id = ?, subject_id = ?, title = ?, group_name = ?, max_capacity = ?, is_active = ?
    WHERE id = ?
  `).run(
    date_id,
    periodNum,
    time,
    teacher_id,
    room_id,
    subject_id,
    (title || '').trim(),
    (group_name || '').trim(),
    cap,
    activeFlag,
    sessionId
  );

  res.json({ success: true });
});

// Óra törlése
app.delete('/api/admin/sessions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==========================================
// TÖRZSDATOK (DÁTUMOK, TANÁROK, TERMEK, TANTÁRGYAK) CRUD
// ==========================================

// Dátumok
app.post('/api/admin/dates', requireAdmin, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Add meg a dátumot!' });
  try {
    db.prepare('INSERT INTO event_dates (date) VALUES (?)').run(date);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a dátum már létezik!' });
  }
});

app.put('/api/admin/dates/:id', requireAdmin, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Add meg a dátumot!' });
  try {
    db.prepare('UPDATE event_dates SET date = ? WHERE id = ?').run(date, req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a dátum már létezik!' });
  }
});

app.delete('/api/admin/dates/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM event_dates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Tanárok / Igazgató
app.post('/api/admin/teachers', requireAdmin, (req, res) => {
  const { name, is_director } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg az oktató nevét!' });
  try {
    db.prepare('INSERT INTO teachers (name, is_director) VALUES (?, ?)').run(name.trim(), is_director ? 1 : 0);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a név már szerepel a listában!' });
  }
});

app.put('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  const { name, is_director } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg az oktató nevét!' });
  try {
    db.prepare('UPDATE teachers SET name = ?, is_director = ? WHERE id = ?').run(name.trim(), is_director ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a név már szerepel a listában!' });
  }
});

app.delete('/api/admin/teachers/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM teachers WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Nem törölhető, mert még van hozzárendelve óra!' });
  }
});

// Termek
app.post('/api/admin/rooms', requireAdmin, (req, res) => {
  const { name, is_placeholder } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg a terem nevét!' });
  try {
    db.prepare('INSERT INTO rooms (name, is_placeholder) VALUES (?, ?)').run(name.trim(), is_placeholder ? 1 : 0);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a terem már szerepel a listában!' });
  }
});

app.put('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  const { name, is_placeholder } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg a terem nevét!' });
  try {
    db.prepare('UPDATE rooms SET name = ?, is_placeholder = ? WHERE id = ?').run(name.trim(), is_placeholder ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a terem már szerepel a listában!' });
  }
});

app.delete('/api/admin/rooms/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Nem törölhető, mert még van hozzárendelve óra!' });
  }
});

// Tantárgyak
app.post('/api/admin/subjects', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg a tantárgy nevét!' });
  try {
    db.prepare('INSERT INTO subjects (name) VALUES (?)').run(name.trim());
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a tantárgy már szerepel a listában!' });
  }
});

app.put('/api/admin/subjects/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Add meg a tantárgy nevét!' });
  try {
    db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Ez a tantárgy már szerepel a listában!' });
  }
});

app.delete('/api/admin/subjects/:id', requireAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Nem törölhető, mert még van hozzárendelve óra!' });
  }
});

// Jelentkezés törlése
app.delete('/api/admin/registrations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM registrations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Szerver fut: http://localhost:${PORT}`);
});
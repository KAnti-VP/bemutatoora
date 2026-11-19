import express from 'express';
import session from 'express-session';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Határidő: 2026. november 27. péntek 12:00:00
const DEADLINE = new Date('2026-11-27T12:00:00');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bemutatoorak-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 60 * 60 * 1000 } // 2 óra
}));

// Nodemailer Gmail beállítás
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_SENDER,
    pass: process.env.APP_PASSWORD
  }
});

// Segédfüggvény: Lejárt-e a jelentkezési határidő?
function isDeadlinePassed() {
  return new Date() > DEADLINE;
}

// Middleware: Admin jogosultság ellenőrzése
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminEmail) {
    return next();
  }
  return res.status(401).json({ error: 'Nincs jogosultságod. Kérlek, jelentkezz be!' });
}

// ==========================================
// PUBLIKUS VÉGPONTOK
// ==========================================

// Összes aktív óra és beszélgetés lekérdezése aktuális foglalási számmal
app.get('/api/schedule', (req, res) => {
  const sessions = db.prepare(`
    SELECT 
      s.*,
      COUNT(r.id) AS booked_count
    FROM sessions s
    LEFT JOIN registrations r ON s.id = r.session_id
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY s.date ASC, s.period ASC, 
      CASE s.slot_type 
        WHEN 'lesson1' THEN 1 
        WHEN 'lesson2' THEN 2 
        WHEN 'director' THEN 3 
      END ASC
  `).all();

  res.json({
    deadlinePassed: isDeadlinePassed(),
    deadlineText: '2026. november 27. (péntek) 12:00',
    sessions
  });
});

// Jelentkezés beküldése
app.post('/api/register', (req, res) => {
  if (isDeadlinePassed()) {
    return res.status(403).json({ error: 'A jelentkezési határidő (2026. november 27. 12:00) lejárt!' });
  }

  const { role, email, name, school, hasCompanion, sessionIds } = req.body;

  // Alapvető validáció
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

  // Tranzakció a versenyhelyzetek (túlfoglalás) elkerülésére
  const registerTx = db.transaction((ids) => {
    const getSession = db.prepare(`
      SELECT s.*, COUNT(r.id) as booked_count
      FROM sessions s
      LEFT JOIN registrations r ON s.id = r.session_id
      WHERE s.id = ? AND s.is_active = 1
      GROUP BY s.id
    `);

    const checkDuplicate = db.prepare(`
      SELECT id FROM registrations WHERE session_id = ? AND email = ?
    `);

    const checkSamePeriod = db.prepare(`
      SELECT r.id FROM registrations r
      JOIN sessions s ON r.session_id = s.id
      WHERE r.email = ? AND s.date = ? AND s.period = ?
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

      // Szerepkör ellenőrzése
      if (role === 'student' && target.slot_type === 'director') {
        throw new Error('Tanulóként nem jelentkezhetsz az igazgatói beszélgetésre!');
      }
      if (role === 'parent' && target.slot_type !== 'director') {
        throw new Error('Szülőként kizárólag Blanka igazgatói beszélgetésére regisztrálhatsz!');
      }

      // Ugyanabban a kérésben ne válasszon két órát ugyanabban az időpontban
      const periodKey = `${target.date}_${target.period}`;
      if (selectedPeriods.has(periodKey)) {
        throw new Error(`Egy időpontban (${target.date}, ${target.period}. óra) csak egy foglalkozásra jelentkezhetsz!`);
      }
      selectedPeriods.add(periodKey);

      // Korábban már jelentkezett-e erre az órára vagy időpontra
      if (checkDuplicate.get(id, cleanEmail)) {
        throw new Error(`Erre az órára (${target.date}, ${target.period}. óra - ${target.subject}) már regisztráltál ezzel az e-mail címmel!`);
      }
      if (checkSamePeriod.get(cleanEmail, target.date, target.period)) {
        throw new Error(`A(z) ${target.date} ${target.period}. órájában már van egy másik foglalásod!`);
      }

      // Létszámlimit ellenőrzése (kísérő nem számít bele a foglalások számába)
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
// ADMIN HITELESÍTÉS (PIN KÜLDÉS ÉS ELLENŐRZÉS)
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
    return res.status(403).json({ error: 'Ez az e-mail cím nincs jogosultként regisztrálva az admin felülethez.' });
  }

  // 6 számjegyű PIN generálása
  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 percig érvényes

  db.prepare(`
    INSERT INTO admin_pins (email, pin, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET pin = excluded.pin, expires_at = excluded.expires_at
  `).run(cleanEmail, pin, expiresAt);

  try {
    // await transporter.sendMail({
    //   from: `"Bemutatóórák Admin" <${process.env.EMAIL_SENDER}>`,
    //   to: cleanEmail,
    //   subject: 'Admin belépési PIN-kód - Bemutatóórák',
    //   text: `Szia!\n\nAz admin felületre történő belépéshez szükséges egyszer használatos PIN-kódod: ${pin}\n\nA kód 10 percig érvényes.`,
    //   html: `<p>Szia!</p><p>Az admin felületre történő belépéshez szükséges egyszer használatos PIN-kódod:</p><h2 style="letter-spacing: 4px; color: #2563eb;">${pin}</h2><p>A kód 10 percig érvényes.</p>`
    // });

    await sendPinEmail(cleanEmail, pin);

    res.json({ success: true, message: 'A 6 számjegyű PIN-kódot elküldtük az e-mail címedre!' });
  } catch (error) {
    console.error('E-mail küldési hiba:', error);
    res.status(500).json({ error: 'Nem sikerült elküldeni az e-mailt. Ellenőrizd a .env fájlban az EMAIL_SENDER és APP_PASSWORD beállításokat!' });
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

  // Sikeres belépés után töröljük a használt PIN-t
  db.prepare('DELETE FROM admin_pins WHERE email = ?').run(cleanEmail);
  req.session.adminEmail = cleanEmail;

  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ==========================================
// ADMIN KEZELŐ VÉGPONTOK
// ==========================================

// Összes foglalkozás (aktív és inaktív is), foglalások és kísérők száma, valamint terem szerinti összesítés
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const sessions = db.prepare(`
    SELECT 
      s.*,
      COUNT(r.id) AS booked_count,
      COALESCE(SUM(r.has_companion), 0) AS companion_count
    FROM sessions s
    LEFT JOIN registrations r ON s.id = r.session_id
    GROUP BY s.id
    ORDER BY s.date ASC, s.period ASC, 
      CASE s.slot_type 
        WHEN 'lesson1' THEN 1 
        WHEN 'lesson2' THEN 2 
        WHEN 'director' THEN 3 
      END ASC
  `).all();

  // Terem szerinti összesítés (időpontra és teremre bontva, hogy pontosan látszódjon hányan mennek oda)
  const roomSummary = db.prepare(`
    SELECT 
      s.date,
      s.day_name,
      s.period,
      s.time,
      s.room,
      s.subject,
      s.teacher,
      COUNT(r.id) AS applicants_count,
      COALESCE(SUM(r.has_companion), 0) AS companions_count,
      (COUNT(r.id) + COALESCE(SUM(r.has_companion), 0)) AS total_people
    FROM sessions s
    LEFT JOIN registrations r ON s.id = r.session_id
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY s.date ASC, s.period ASC, s.room ASC
  `).all();

  // Részletes jelentkezési lista
  const registrations = db.prepare(`
    SELECT 
      r.*,
      s.date,
      s.day_name,
      s.period,
      s.time,
      s.subject,
      s.teacher,
      s.room,
      s.slot_type
    FROM registrations r
    JOIN sessions s ON r.session_id = s.id
    ORDER BY s.date ASC, s.period ASC, r.created_at DESC
  `).all();

  res.json({ sessions, roomSummary, registrations });
});

// Foglalkozás (terem, limit, aktivitás, cím, megjegyzés) módosítása
app.put('/api/admin/sessions/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { room, max_capacity, is_active, title, note } = req.body;

  const cap = parseInt(max_capacity, 10);
  if (isNaN(cap) || cap < 1) {
    return res.status(400).json({ error: 'A létszámlimitnek legalább 1-nek kell lennie!' });
  }

  db.prepare(`
    UPDATE sessions
    SET room = ?, max_capacity = ?, is_active = ?, title = ?, note = ?
    WHERE id = ?
  `).run(
    room || 'Kijelölés alatt',
    cap,
    is_active ? 1 : 0,
    title || '',
    note || '',
    id
  );

  res.json({ success: true });
});

// Jelentkezés törlése
app.delete('/api/admin/registrations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM registrations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Szerver fut: http://localhost:${PORT}`);
  console.log(`Admin felület: http://localhost:${PORT}/admin`);
});

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
    headers: {
      'Content-Type': 'application/json'
    },
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
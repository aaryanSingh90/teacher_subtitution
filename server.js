// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const sqldb = require('./connection/database'); // must export pool/client with .query()

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- CORS & middleware ---------------- */
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = allowedOriginsEnv ? allowedOriginsEnv.split(',').map(s => s.trim()) : [];

if (process.env.NODE_ENV === 'production' && allowedOrigins.length) {
    app.use(cors({
        origin: function(origin, callback) {
            if (!origin) return callback(null, true);
            if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
            callback(new Error('Not allowed by CORS'));
        }
    }));
} else {
    app.use(cors());
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Helpers ---------------- */
function normalizeDay(d) {
    if (!d) return d;
    const up = String(d).trim().toUpperCase();
    if (['THU', 'THUR', 'THURS', 'THURSDAY'].includes(up)) return 'THUR';
    return up.slice(0,3);
}

function extractSubjectCode(activityDescription) {
    if (!activityDescription) return 'N/A';
    const s = String(activityDescription).trim();
    const parts = s.split(' - ');
    if (parts && parts[0]) {
        const codeCandidate = parts[0].trim().toUpperCase();
        if (/^[A-Z0-9_]+$/.test(codeCandidate)) return codeCandidate;
    }
    const m = s.match(/^\s*([A-Za-z0-9_]+)/);
    return m ? m[1].toUpperCase() : 'N/A';
}

/* ---------------- SQL CTE ---------------- */
const subjectsAggCTE = `
    SELECT
        tsa.teacher_id,
        GROUP_CONCAT(DISTINCT tsa.subject_code ORDER BY tsa.subject_code SEPARATOR ', ') AS subjects_codes,
        GROUP_CONCAT(DISTINCT CONCAT(tsa.subject_code, ' - ', COALESCE(s.subject_name, '')) ORDER BY tsa.subject_code SEPARATOR ' | ') AS subjects_detail
    FROM teacher_subject_assignment tsa
    LEFT JOIN subjects s ON s.subject_code = tsa.subject_code
    GROUP BY tsa.teacher_id
`;

/* ---------------- Core: findSubstitutes (uses slot_id as key) ---------------- */
async function findSubstitutes(absentTeacherIdRaw, targetDayRaw) {
    const absentTeacherId = String(absentTeacherIdRaw || '').trim();
    const targetDay = normalizeDay(targetDayRaw || '');

    if (!absentTeacherId) throw new Error('Invalid absent teacher ID.');
    if (!targetDay) throw new Error('Invalid or missing day.');

    console.log(`findSubstitutes called for: ${absentTeacherId}, targetDayRaw: ${targetDayRaw} -> normalized: ${targetDay}`);

    // Verify teacher attendance exists
    const qAttendance = `SELECT teacher_name, attendance FROM teacher_attendance WHERE LOWER(teacher_id) = LOWER(?) LIMIT 1`;
    const [attRows] = await sqldb.query(qAttendance, [absentTeacherId]);
    if (!attRows || attRows.length === 0) {
        return { absentName: `Teacher ID: ${absentTeacherId}`, absentTeacherSubjectDetail: 'N/A', schedule: [], note: 'Teacher not found' };
    }
    const teacherRow = attRows[0];
    const isAbsent = String((teacherRow.attendance || '')).trim().toUpperCase() === 'ABSENT';
    const absentTeacherName = teacherRow.teacher_name || `Teacher ID: ${absentTeacherId}`;

    // Absent teacher subject detail
    const qAbsentTeacherInfo = `
        WITH subjects_agg AS ( ${subjectsAggCTE} )
        SELECT
            ta.teacher_name,
            COALESCE(sa.subjects_detail, sa.subjects_codes, 'Subject(s) Not Assigned') AS absent_teacher_subject_detail
        FROM teacher_attendance ta
        LEFT JOIN subjects_agg sa
          ON LOWER(sa.teacher_id) = LOWER(ta.teacher_id)
        WHERE LOWER(ta.teacher_id) = LOWER(?)
        LIMIT 1
    `;
    const [absentInfo] = await sqldb.query(qAbsentTeacherInfo, [absentTeacherId]);
    const absentTeacherSubjectDetail = (absentInfo && absentInfo.length) ? absentInfo[0].absent_teacher_subject_detail : 'N/A';

    if (!isAbsent) {
        return { absentName: absentTeacherName, absentTeacherSubjectDetail, schedule: [], note: 'Teacher is not marked as ABSENT in attendance table' };
    }

    // qClasses: select classes to cover (slot_id authoritative)
    const qClasses = `
        SELECT 
            tt.teacher_id     AS absent_teacher_id,
            tt.day_of_week,
            tt.slot_id,
            ts.time_range,
            tt.activity_description AS class_to_cover,
            tt.room_location,
            (UPPER(IFNULL(tt.activity_description, '')) LIKE '%LAB%') AS is_lab
        FROM teacher_timetable tt
        JOIN time_slots ts ON ts.slot_id = tt.slot_id
        WHERE LOWER(tt.teacher_id) = LOWER(?)
          AND UPPER(tt.day_of_week) = UPPER(?)
          AND tt.is_free = FALSE
        ORDER BY tt.slot_id;
    `;

    // qSubs: candidates for each slot_id
    const qSubs = `
        WITH subjects_agg AS ( ${subjectsAggCTE} )
        SELECT
            c.absent_teacher_id,
            c.slot_id,
            c.time_range,
            c.class_to_cover,
            c.room_location,
            s.teacher_id                                   AS substitute_teacher_id,
            s.teacher_name                                 AS substitute_teacher_name,
            COALESCE(sa.subjects_codes, '')                AS subjects_codes,
            COALESCE(sa.subjects_detail, '')               AS subjects_detail,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM teacher_subject_assignment tsa
                    WHERE LOWER(tsa.teacher_id) = LOWER(s.teacher_id)
                      AND UPPER(TRIM(tsa.subject_code)) = UPPER(SUBSTRING_INDEX(c.class_to_cover, ' - ', 1))
                ) THEN 'BEST FIT (Same Subject)'
                ELSE 'GOOD FIT (Free, Any Subject)'
            END AS substitution_priority
        FROM (
            SELECT tt.teacher_id AS absent_teacher_id,
                   tt.day_of_week,
                   tt.slot_id,
                   ts.time_range,
                   tt.activity_description AS class_to_cover,
                   tt.room_location
            FROM teacher_timetable tt
            JOIN time_slots ts ON ts.slot_id = tt.slot_id
            WHERE LOWER(tt.teacher_id) = LOWER(?)
              AND UPPER(tt.day_of_week) = UPPER(?)
              AND tt.is_free = FALSE
        ) c
        JOIN teacher_attendance s
          ON UPPER(TRIM(s.attendance)) = 'PRESENT'
         AND LOWER(s.teacher_id) <> LOWER(c.absent_teacher_id)
        LEFT JOIN subjects_agg sa
          ON LOWER(sa.teacher_id) = LOWER(s.teacher_id)
        WHERE
              EXISTS (
                SELECT 1 FROM teacher_timetable tt_free
                WHERE LOWER(tt_free.teacher_id) = LOWER(s.teacher_id)
                  AND UPPER(tt_free.day_of_week) = UPPER(c.day_of_week)
                  AND tt_free.slot_id = c.slot_id
                  AND tt_free.is_free = TRUE
              )
           OR NOT EXISTS (
                SELECT 1 FROM teacher_timetable tt_busy
                WHERE LOWER(tt_busy.teacher_id) = LOWER(s.teacher_id)
                  AND UPPER(tt_busy.day_of_week) = UPPER(c.day_of_week)
                  AND tt_busy.slot_id = c.slot_id
                  AND tt_busy.is_free = FALSE
              )
        ORDER BY c.slot_id,
                 (substitution_priority = 'BEST FIT (Same Subject)') DESC,
                 s.teacher_name;
    `;

    try {
        const [classes] = await sqldb.query(qClasses, [absentTeacherId, targetDay]);
        console.log('DBG: classes found count =', (classes && classes.length) ? classes.length : 0);

        if (!classes || classes.length === 0) {
            console.log('DBG: No classes returned for', absentTeacherId, targetDay);
            return { absentName: absentTeacherName, absentTeacherSubjectDetail, schedule: [] };
        }

        const [subs] = await sqldb.query(qSubs, [absentTeacherId, targetDay, absentTeacherId, targetDay]);
        console.log('DBG: subs rows count =', (subs && subs.length) ? subs.length : 0);

        // Grouping by slot_id | class_to_cover (slot_id is authoritative key)
        const byKey = new Map();
        for (const row of classes) {
            const key = `${row.slot_id}|${row.class_to_cover}`;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    slot_id: row.slot_id,
                    slot: row.time_range,
                    class_info: row.class_to_cover,
                    subject: extractSubjectCode(row.class_to_cover),
                    room: row.room_location || null,
                    is_lab: !!row.is_lab,
                    available_substitutes: []
                });
            }
        }

        for (const s of subs) {
            const key = `${s.slot_id}|${s.class_to_cover}`;
            if (byKey.has(key)) {
                byKey.get(key).available_substitutes.push({
                    substitute_id: s.substitute_teacher_id,
                    substitute_name: s.substitute_teacher_name,
                    priority: s.substitution_priority,
                    subjects_codes: s.subjects_codes,
                    subjects_detail: s.subjects_detail
                });
            }
        }

        const schedule = Array.from(byKey.values()).sort((a,b) => a.slot_id - b.slot_id);
        return { absentName: absentTeacherName, absentTeacherSubjectDetail, schedule };
    } catch (error) {
        console.error('Database Error in findSubstitutes:', error);
        throw new Error('Database query failed during substitution search.');
    }
}

/* ---------------- Routes ---------------- */

app.get('/api/ping', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/teachers', async (_req, res) => {
    try {
        const [teachers] = await sqldb.query('SELECT teacher_id, teacher_name, attendance FROM teacher_attendance ORDER BY teacher_id');
        res.json(teachers);
    } catch (error) {
        console.error('GET /api/teachers error:', error);
        res.status(500).json({ message: 'Error fetching teachers.' });
    }
});

app.post('/api/attendance', async (req, res) => {
    const { teacherId, status } = req.body;
    if (!teacherId || !status) return res.status(400).json({ message: 'Missing teacherId or status.' });
    if (typeof teacherId !== 'string' || teacherId.length > 50) return res.status(400).json({ message: 'Invalid teacherId.' });

    const normalized = String(status).trim();
    try {
        const [result] = await sqldb.query('UPDATE teacher_attendance SET attendance = ? WHERE teacher_id = ?', [normalized, teacherId]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Teacher not found.' });
        res.json({ message: `Teacher ${teacherId} marked as ${normalized}.` });
    } catch (error) {
        console.error('POST /api/attendance error:', error);
        res.status(500).json({ message: 'Error updating attendance.' });
    }
});

app.get('/api/substitute/:teacherId/:day', async (req, res) => {
    const absentTeacherId = (req.params.teacherId || '').toUpperCase();
    const targetDay = normalizeDay(req.params.day || '');

    if (!absentTeacherId) return res.status(400).json({ message: 'Missing teacherId param.' });
    if (!targetDay) return res.status(400).json({ message: 'Missing or invalid day param.' });

    try {
        const result = await findSubstitutes(absentTeacherId, targetDay);
        res.json({
            absent_teacher: result.absentName || `Teacher ID: ${absentTeacherId}`,
            absent_teacher_subject: result.absentTeacherSubjectDetail || 'N/A',
            schedule_to_cover: result.schedule || [],
            note: result.note || undefined
        });
    } catch (error) {
        console.error('GET /api/substitute error:', error.message || error);
        res.status(500).json({ message: 'Error fetching substitution data: ' + (error.message || 'unknown') });
    }
});

/* ---------------- Debug endpoints ---------------- */

app.get('/api/debug/free/:day/:slot', async (req, res) => {
    const day = normalizeDay(req.params.day || '');
    const slot = Number(req.params.slot);
    if (!day || Number.isNaN(slot)) return res.status(400).json({ message: 'Provide day and numeric slot.' });

    try {
        const q = `
            SELECT s.teacher_id, s.teacher_name
            FROM teacher_attendance s
            WHERE UPPER(TRIM(s.attendance)) = 'PRESENT'
              AND (
                    EXISTS (
                      SELECT 1 FROM teacher_timetable tt_free
                      WHERE LOWER(tt_free.teacher_id) = LOWER(s.teacher_id)
                        AND UPPER(tt_free.day_of_week) = UPPER(?)
                        AND tt_free.slot_id = ?
                        AND tt_free.is_free = TRUE
                    )
                    OR NOT EXISTS (
                      SELECT 1 FROM teacher_timetable tt_busy
                      WHERE LOWER(tt_busy.teacher_id) = LOWER(s.teacher_id)
                        AND UPPER(tt_busy.day_of_week) = UPPER(?)
                        AND tt_busy.slot_id = ?
                        AND tt_busy.is_free = FALSE
                    )
                  )
            ORDER BY s.teacher_id;
        `;
        const [rows] = await sqldb.query(q, [day, slot, day, slot]);
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Debug query failed.' });
    }
});

app.get('/api/debug/timetable/:day', async (req, res) => {
    const day = (req.params.day || '').toUpperCase();
    try {
        const [rows] = await sqldb.query(
            'SELECT teacher_id, slot_id, activity_description, room_location, is_free, day_of_week FROM teacher_timetable WHERE UPPER(day_of_week) LIKE CONCAT(UPPER(?), "%") ORDER BY teacher_id, slot_id',
            [day]
        );
        res.json(rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Query failed.' });
    }
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
    console.log(`🚀 Backend Server listening on port ${PORT}`);
});

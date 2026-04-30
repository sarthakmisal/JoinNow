const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DB_URL });

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS hr_contacts (
            id SERIAL PRIMARY KEY,
            name TEXT,
            email TEXT UNIQUE NOT NULL,
            company TEXT,
            role TEXT,
            job_title TEXT,
            job_url TEXT,
            job_location TEXT,
            city TEXT,
            sent BOOLEAN NOT NULL DEFAULT FALSE,
            sent_at TIMESTAMPTZ
        );
    `);

    // Lightweight migrations for older schemas
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS job_title TEXT');
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS job_url TEXT');
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS job_location TEXT');
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS city TEXT');
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS sent BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE hr_contacts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS role_configs (
            name TEXT PRIMARY KEY,
            description TEXT NOT NULL DEFAULT '',
            remote_only BOOLEAN,
            city TEXT,
            cities TEXT,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pool.query('ALTER TABLE role_configs ADD COLUMN IF NOT EXISTS remote_only BOOLEAN');
    await pool.query('ALTER TABLE role_configs ADD COLUMN IF NOT EXISTS city TEXT');
    await pool.query('ALTER TABLE role_configs ADD COLUMN IF NOT EXISTS cities TEXT');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS company_role_outreach (
            company TEXT NOT NULL,
            role TEXT NOT NULL,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (company, role)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY,
            daily_limit INTEGER NOT NULL DEFAULT 100,
            remote_only BOOLEAN NOT NULL DEFAULT TRUE,
            use_hunter_fallback BOOLEAN NOT NULL DEFAULT TRUE,
            collect_only BOOLEAN NOT NULL DEFAULT TRUE,
            city TEXT,
            cities TEXT,
            company_role_cooldown_days INTEGER NOT NULL DEFAULT 30,
            automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Lightweight migrations for older schemas
    await pool.query('ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS city TEXT');
    await pool.query('ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS cities TEXT');
    await pool.query('ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS company_role_cooldown_days INTEGER NOT NULL DEFAULT 30');
    await pool.query('ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE app_settings ALTER COLUMN daily_limit SET DEFAULT 100');

    // Ensure singleton row exists.
    await pool.query(
        `INSERT INTO app_settings (id)
         VALUES (1)
         ON CONFLICT (id) DO NOTHING`
    );
    await pool.query('UPDATE app_settings SET daily_limit=100 WHERE id=1 AND daily_limit < 100');
}

async function getRoleConfigs({ activeOnly = true } = {}) {
    const sql = activeOnly
        ? 'SELECT name, description, remote_only, city, cities, active FROM role_configs WHERE active=true ORDER BY updated_at DESC'
        : 'SELECT name, description, remote_only, city, cities, active FROM role_configs ORDER BY updated_at DESC';
    const res = await pool.query(sql);
    return res.rows || [];
}

async function setRoleConfigs(roleDefs) {
    const roles = Array.isArray(roleDefs) ? roleDefs : [];
    // Replace strategy: deactivate all, then upsert new active ones.
    await pool.query('UPDATE role_configs SET active=false, updated_at=NOW()');

    for (const r of roles) {
        const name = String(r?.name || '').trim();
        if (!name) continue;
        const description = String(r?.description || '').trim();
        const remote_only = r?.remote_only ?? r?.remoteOnly;
        const city = r?.city === undefined ? null : String(r.city || '').trim() || null;
        const cities = r?.cities === undefined ? null : String(r.cities || '').trim() || null;
        const active = r?.active === undefined ? true : Boolean(r.active);
        await pool.query(
            `INSERT INTO role_configs (name, description, remote_only, city, cities, active, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())
             ON CONFLICT (name) DO UPDATE SET
                description=EXCLUDED.description,
                remote_only=EXCLUDED.remote_only,
                city=EXCLUDED.city,
                cities=EXCLUDED.cities,
                active=EXCLUDED.active,
                updated_at=NOW()`,
            [
                name,
                description,
                remote_only === undefined ? null : Boolean(remote_only),
                city,
                cities,
                active,
            ]
        );
    }
}

async function getSettings() {
    const res = await pool.query(
        'SELECT daily_limit, remote_only, use_hunter_fallback, collect_only, city, cities, company_role_cooldown_days, automation_enabled FROM app_settings WHERE id=1'
    );
    return (
        res.rows?.[0] || {
            daily_limit: 100,
            remote_only: true,
            use_hunter_fallback: true,
            collect_only: true,
            city: null,
            cities: 'Pune,Mumbai,Bangalore',
            company_role_cooldown_days: 30,
            automation_enabled: false,
        }
    );
}

async function setSettings(patch) {
    const current = await getSettings();

    const daily_limit_raw = patch?.daily_limit ?? patch?.dailyLimit;
    const daily_limit = Number.isFinite(Number(daily_limit_raw))
        ? Math.max(1, Math.min(500, Number(daily_limit_raw)))
        : Number(current.daily_limit);

    const remote_only = patch?.remote_only ?? patch?.remoteOnly;
    const use_hunter_fallback = patch?.use_hunter_fallback ?? patch?.useHunterFallback;
    const collect_only = patch?.collect_only ?? patch?.collectOnly;

    const city_raw = patch?.city;
    const city =
        city_raw === undefined
            ? (current.city || null)
            : String(city_raw || '').trim() || null;

    const cities_raw = patch?.cities;
    const cities =
        cities_raw === undefined
            ? (current.cities || 'Pune,Mumbai,Bangalore')
            : String(cities_raw || '').trim() || '';

    const cooldown_raw = patch?.company_role_cooldown_days ?? patch?.companyRoleCooldownDays;
    const company_role_cooldown_days = Number.isFinite(Number(cooldown_raw))
        ? Math.max(0, Math.min(365, Number(cooldown_raw)))
        : Number(current.company_role_cooldown_days ?? 30);

    const automation_enabled_raw = patch?.automation_enabled ?? patch?.automationEnabled;
    const automation_enabled =
        automation_enabled_raw === undefined
            ? Boolean(current.automation_enabled)
            : Boolean(automation_enabled_raw);

    await pool.query(
        `UPDATE app_settings
         SET daily_limit=$1,
             remote_only=$2,
             use_hunter_fallback=$3,
             collect_only=$4,
             city=$5,
             cities=$6,
             company_role_cooldown_days=$7,
             automation_enabled=$8,
             updated_at=NOW()
         WHERE id=1`,
        [
            daily_limit,
            remote_only === undefined ? Boolean(current.remote_only) : Boolean(remote_only),
            use_hunter_fallback === undefined
                ? Boolean(current.use_hunter_fallback)
                : Boolean(use_hunter_fallback),
            collect_only === undefined ? Boolean(current.collect_only) : Boolean(collect_only),
            city,
            cities,
            company_role_cooldown_days,
            automation_enabled,
        ]
    );
}

async function isAlreadySent(email) {
    const res = await pool.query('SELECT 1 FROM hr_contacts WHERE email=$1 AND sent=true', [email]);
    return res.rowCount > 0;
}

function getLocalDayBounds(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
}

async function countSentBetween(start, end) {
    const res = await pool.query(
        'SELECT COUNT(*)::int AS count FROM hr_contacts WHERE sent=true AND sent_at >= $1 AND sent_at < $2',
        [start, end]
    );
    return Number(res.rows?.[0]?.count || 0);
}

async function getDailyProgress({ date = new Date(), dailyLimit } = {}) {
    const settings = dailyLimit === undefined ? await getSettings() : null;
    const limit = Number.isFinite(Number(dailyLimit))
        ? Number(dailyLimit)
        : Number(settings?.daily_limit || 100);
    const { start, end } = getLocalDayBounds(date);
    const sentToday = await countSentBetween(start, end);
    return {
        date: start.toISOString().slice(0, 10),
        dayStart: start.toISOString(),
        dayEnd: end.toISOString(),
        dailyLimit: limit,
        sentToday,
        remainingToday: Math.max(0, limit - sentToday),
        targetReached: sentToday >= limit,
    };
}

async function isCompanyRoleBlocked(company, role, cooldownDays) {
    const c = String(company || '').trim();
    const r = String(role || '').trim();
    if (!c || !r) return false;

    const days = Number.isFinite(Number(cooldownDays)) ? Number(cooldownDays) : null;
    if (days !== null && days <= 0) return false;

    // Primary source of truth.
    const resLedger = await pool.query(
        'SELECT sent_at FROM company_role_outreach WHERE company=$1 AND role=$2 LIMIT 1',
        [c, r]
    );
    const sentAt = resLedger.rows?.[0]?.sent_at ? new Date(resLedger.rows[0].sent_at).getTime() : null;
    if (sentAt !== null) {
        if (days === null) return true;
        const ageMs = Date.now() - sentAt;
        return ageMs >= 0 && ageMs < days * 24 * 60 * 60 * 1000;
    }

    // Back-compat for older installs (before ledger existed).
    const resLegacy = await pool.query(
        'SELECT sent_at FROM hr_contacts WHERE company=$1 AND role=$2 AND sent=true ORDER BY sent_at DESC NULLS LAST LIMIT 1',
        [c, r]
    );
    const legacySentAt = resLegacy.rows?.[0]?.sent_at
        ? new Date(resLegacy.rows[0].sent_at).getTime()
        : null;
    if (legacySentAt === null) return false;
    if (days === null) return true;
    const legacyAgeMs = Date.now() - legacySentAt;
    return legacyAgeMs >= 0 && legacyAgeMs < days * 24 * 60 * 60 * 1000;
}

async function markCompanyRoleSent(company, role) {
    const c = String(company || '').trim();
    const r = String(role || '').trim();
    if (!c || !r) return;
    await pool.query(
        `INSERT INTO company_role_outreach (company, role, sent_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (company, role) DO UPDATE SET sent_at=EXCLUDED.sent_at`,
        [c, r]
    );
}

async function hasContactForOpening(company, role, jobTitle) {
    const c = String(company || '').trim();
    const r = String(role || '').trim();
    const j = String(jobTitle || '').trim();
    if (!c || !r) return false;

    const res = await pool.query(
        `SELECT 1
         FROM hr_contacts
         WHERE lower(company)=lower($1)
           AND lower(role)=lower($2)
           AND lower(COALESCE(job_title, ''))=lower($3)
         LIMIT 1`,
        [c, r, j]
    );
    return res.rowCount > 0;
}

async function saveContact({ name, email, company, role, jobTitle, jobUrl, jobLocation, city }) {
    await pool.query(
        `INSERT INTO hr_contacts (name, email, company, role, job_title, job_url, job_location, city)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (email) DO UPDATE SET
        name=COALESCE(EXCLUDED.name, hr_contacts.name),
        company=COALESCE(EXCLUDED.company, hr_contacts.company),
        role=COALESCE(EXCLUDED.role, hr_contacts.role),
        job_title=COALESCE(EXCLUDED.job_title, hr_contacts.job_title),
        job_url=COALESCE(EXCLUDED.job_url, hr_contacts.job_url),
        job_location=COALESCE(EXCLUDED.job_location, hr_contacts.job_location),
        city=COALESCE(EXCLUDED.city, hr_contacts.city)`,
        [
            name || null,
            email,
            company || null,
            role || null,
            jobTitle || null,
            jobUrl || null,
            jobLocation || null,
            city || null,
        ]
    );
}

async function listLeads({ sent, limit, offset } = {}) {
    const lim = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 50;
    const off = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;

    let where = '';
    const params = [];

    if (sent === true) {
        where = 'WHERE sent=true';
    } else if (sent === false) {
        where = 'WHERE sent=false';
    }

    params.push(lim);
    params.push(off);

    const res = await pool.query(
        `SELECT id, name, email, company, role, job_title, job_url, job_location, city, sent, sent_at
         FROM hr_contacts
         ${where}
         ORDER BY COALESCE(sent_at, NOW()) DESC, id DESC
         LIMIT $1 OFFSET $2`,
        params
    );
    return res.rows || [];
}

async function listUnsentLeadsForRoles(roleNames, limit) {
    const roles = Array.isArray(roleNames)
        ? roleNames.map(r => String(r || '').trim()).filter(Boolean)
        : [];
    if (roles.length === 0) return [];

    const lim = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 50;

    const res = await pool.query(
        `SELECT id, name, email, company, role, job_title, job_url, job_location, city, sent, sent_at
         FROM hr_contacts
         WHERE sent=false AND role = ANY($1)
         ORDER BY id DESC
         LIMIT $2`,
        [roles, lim]
    );
    return res.rows || [];
}

async function markSent(email) {
    await pool.query('UPDATE hr_contacts SET sent=true, sent_at=NOW() WHERE email=$1', [email]);
}

module.exports = {
    initDb,
    getRoleConfigs,
    setRoleConfigs,
    getSettings,
    setSettings,
    isAlreadySent,
    getDailyProgress,
    isCompanyRoleBlocked,
    markCompanyRoleSent,
    hasContactForOpening,
    saveContact,
    listLeads,
    listUnsentLeadsForRoles,
    markSent,
};

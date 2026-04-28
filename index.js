require('dotenv').config();
const cron = require('node-cron');
const { startServer } = require('./api-server');
const { runOutreach } = require('./outreach');
const { runSend } = require('./sender');
const { initDb, getRoleConfigs, getSettings } = require('./db');

function envBool(name) {
    if (process.env[name] === undefined) return undefined;
    return String(process.env[name]).toLowerCase() === 'true';
}

async function runCollectThenSend() {
    await initDb();

    const settings = await getSettings();

    const automationEnabled = envBool('AUTOMATION_ENABLED');
    const shouldAutomate = automationEnabled === undefined
        ? Boolean(settings.automation_enabled)
        : Boolean(automationEnabled);

    if (!shouldAutomate) {
        console.log('Automation is OFF — skipping scheduled run');
        return;
    }

    const rolesEnv = (process.env.ROLES || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const roles = rolesEnv.length
        ? rolesEnv.map(r => ({ name: r, description: '' }))
        : await getRoleConfigs({ activeOnly: true });

    const dailyLimit = Number(process.env.DAILY_LIMIT || settings.daily_limit || 50);
    const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
    // Automation flow always collects first, then sends.
    const collectOnly = true;
    const useHunterFallback =
        process.env.USE_HUNTER_FALLBACK === undefined
            ? Boolean(settings.use_hunter_fallback)
            : String(process.env.USE_HUNTER_FALLBACK).toLowerCase() === 'true';
    const remoteOnly =
        process.env.REMOTE_ONLY === undefined
            ? Boolean(settings.remote_only)
            : String(process.env.REMOTE_ONLY).toLowerCase() === 'true';

    const city = String(process.env.CITY || settings.city || '').trim() || null;
    const cities = String(process.env.CITIES || settings.cities || 'Pune,Mumbai,Bangalore');
    const companyRoleCooldownDays = Number(
        process.env.COMPANY_ROLE_COOLDOWN_DAYS || settings.company_role_cooldown_days || 30
    );

    // 1) Collect
    await runOutreach(
        {
            roles: roles.length ? roles : undefined,
            dailyLimit,
            dryRun: true,
            collectOnly,
            useHunterFallback,
            remoteOnly,
            city: remoteOnly ? null : city,
            cities: remoteOnly ? '' : cities,
            companyRoleCooldownDays,
        },
        (evt) => {
            if (evt?.message) console.log(evt.message);
        }
    );

    // 2) Send
    await runSend(
        {
            roles: roles.length ? roles : undefined,
            dailyLimit,
            dryRun,
            companyRoleCooldownDays,
        },
        (evt) => {
            if (evt?.message) console.log(evt.message);
        }
    );
}

// Start API + static frontend (root build/) from the main entrypoint.
const API_PORT = Number(process.env.API_PORT || 3001);
startServer(API_PORT);

// Run daily at 9 AM by default
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 9 * * *';
cron.schedule(CRON_SCHEDULE, runCollectThenSend);

// Uncomment to test immediately:
const RUN_ON_START = String(process.env.RUN_ON_START || 'false').toLowerCase() === 'true';
if (RUN_ON_START) runCollectThenSend();
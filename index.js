require('dotenv').config();
const cron = require('node-cron');
const { startServer } = require('./api-server');
const { runOutreach } = require('./outreach');
const { runSend } = require('./sender');
const { initDb, getRoleConfigs, getSettings, getDailyProgress } = require('./db');

let automationRunInProgress = false;

function envBool(name) {
    if (process.env[name] === undefined) return undefined;
    return String(process.env[name]).toLowerCase() === 'true';
}

async function runCollectThenSend(label = 'scheduled') {
    if (automationRunInProgress) {
        console.log(`Automation run "${label}" skipped - previous run is still active`);
        return;
    }

    automationRunInProgress = true;
    try {
        await initDb();

        const settings = await getSettings();

        const automationEnabled = envBool('AUTOMATION_ENABLED');
        const shouldAutomate = automationEnabled === undefined
            ? Boolean(settings.automation_enabled)
            : Boolean(automationEnabled);

        if (!shouldAutomate) {
            console.log('Automation is OFF - skipping scheduled run');
            return;
        }

        const rolesEnv = (process.env.ROLES || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

        const roles = rolesEnv.length
            ? rolesEnv.map(r => ({ name: r, description: '' }))
            : await getRoleConfigs({ activeOnly: true });

        const dailyLimit = Number(process.env.DAILY_LIMIT || settings.daily_limit || 100);
        const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
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

        const before = await getDailyProgress({ dailyLimit });
        if (before.targetReached) {
            console.log(`Daily target already reached (${before.sentToday}/${before.dailyLimit}) - skipping ${label}`);
            return;
        }

        console.log(`Automation ${label}: ${before.sentToday}/${before.dailyLimit} sent today, ${before.remainingToday} remaining`);

        await runOutreach(
            {
                roles: roles.length ? roles : undefined,
                dailyLimit: before.remainingToday,
                dryRun: true,
                collectOnly: true,
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

        const afterCollect = await getDailyProgress({ dailyLimit });
        if (afterCollect.targetReached) {
            console.log(`Daily target reached before send (${afterCollect.sentToday}/${afterCollect.dailyLimit})`);
            return;
        }

        await runSend(
            {
                roles: roles.length ? roles : undefined,
                dailyLimit: afterCollect.remainingToday,
                dryRun,
                companyRoleCooldownDays,
            },
            (evt) => {
                if (evt?.message) console.log(evt.message);
            }
        );

        const afterSend = await getDailyProgress({ dailyLimit });
        console.log(`Automation ${label} finished: ${afterSend.sentToday}/${afterSend.dailyLimit} sent today`);
    } finally {
        automationRunInProgress = false;
    }
}

const API_PORT = Number(process.env.API_PORT || 3001);
startServer(API_PORT);

// Run at 8 AM, 1 PM, and 11 PM local server time by default.
// Later windows skip automatically once today's target is reached.
const CRON_SCHEDULES = (process.env.CRON_SCHEDULES || process.env.CRON_SCHEDULE || '0 8,13,23 * * *')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
for (const schedule of CRON_SCHEDULES) {
    cron.schedule(schedule, () => runCollectThenSend(schedule));
    console.log(`Automation scheduled: ${schedule}`);
}

const RUN_ON_START = String(process.env.RUN_ON_START || 'false').toLowerCase() === 'true';
if (RUN_ON_START) runCollectThenSend('startup');

module.exports = { runCollectThenSend };

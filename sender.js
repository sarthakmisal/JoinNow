const { generateEmail } = require('./ai');
const { sendMail } = require('./mailer');
const {
    initDb,
    getRoleConfigs,
    getSettings,
    listUnsentLeadsForRoles,
    isCompanyRoleBlocked,
    markSent,
    markCompanyRoleSent,
} = require('./db');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function emit(onEvent, event) {
    if (typeof onEvent === 'function') onEvent(event);
}

/**
 * Sends emails for already-collected unsent leads (from Postgres).
 * @param {object} options
 * @param {Array<{name:string,description?:string,active?:boolean}>} [options.roles]
 * @param {number} [options.dailyLimit]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.companyRoleCooldownDays]
 */
async function runSend(options, onEvent) {
    await initDb();

    const settings = await getSettings();

    const roleDefs = Array.isArray(options?.roles) && options.roles.length
        ? options.roles
        : await getRoleConfigs({ activeOnly: true });

    const roleNames = roleDefs
        .filter(r => r && (r.active === undefined ? true : Boolean(r.active)))
        .map(r => String(r.name || '').trim())
        .filter(Boolean);
    const roleDescriptionByName = new Map(
        roleDefs
            .filter(r => r && (r.active === undefined ? true : Boolean(r.active)))
            .map(r => [String(r.name || '').trim().toLowerCase(), String(r.description || '').trim()])
            .filter(([name]) => name)
    );

    const dailyLimit = Number.isFinite(Number(options?.dailyLimit))
        ? Number(options.dailyLimit)
        : Number(settings.daily_limit || 50);

    const dryRun = options?.dryRun === undefined ? false : Boolean(options.dryRun);

    const companyRoleCooldownDays = Number.isFinite(Number(options?.companyRoleCooldownDays))
        ? Number(options.companyRoleCooldownDays)
        : Number(settings.company_role_cooldown_days || 30);

    let sent = 0;
    let failed = 0;

    const companyRoleSentThisRun = new Set();

    emit(onEvent, { type: 'log', message: 'Starting send…' });
    emit(onEvent, {
        type: 'stats',
        data: { sent, failed, dailyLimit, dryRun, roles: roleNames, companyRoleCooldownDays },
    });

    const leads = await listUnsentLeadsForRoles(roleNames, dailyLimit * 3);
    emit(onEvent, { type: 'log', message: `Loaded ${leads.length} unsent lead(s)` });

    for (const lead of leads) {
        if (sent >= dailyLimit) break;
        const company = String(lead.company || '').trim();
        const role = String(lead.role || '').trim();
        const email = String(lead.email || '').trim();
        if (!company || !role || !email) continue;

        const companyRoleKey = `${company.toLowerCase()}|${role.toLowerCase()}`;
        if (companyRoleSentThisRun.has(companyRoleKey)) continue;

        // cooldown-based dedupe
        if (await isCompanyRoleBlocked(company, role, companyRoleCooldownDays)) {
            emit(onEvent, {
                type: 'log',
                message: `Skipping ${company} (${role}) — still in cooldown`,
            });
            companyRoleSentThisRun.add(companyRoleKey);
            continue;
        }

        try {
            const { subject, body } = await generateEmail({
                name: lead.name || '',
                email,
                company,
                role,
                roleDescription: roleDescriptionByName.get(role.toLowerCase()) || '',
                jobTitle: lead.job_title,
                jobUrl: lead.job_url,
            });

            if (dryRun) {
                emit(onEvent, { type: 'log', message: `[DRY_RUN] Would send to ${email} @ ${company} (${role})` });
                sent++;
                companyRoleSentThisRun.add(companyRoleKey);
            } else {
                await sendMail({ to: email, subject, body });
                await markSent(email);
                await markCompanyRoleSent(company, role);

                emit(onEvent, { type: 'sent', message: `Sent to ${email} @ ${company} (${role})` });
                sent++;
                companyRoleSentThisRun.add(companyRoleKey);
            }

            emit(onEvent, { type: 'stats', data: { sent, failed } });
            await sleep(2000);
        } catch (e) {
            failed++;
            emit(onEvent, {
                type: 'error',
                message: `Send failed for ${email} @ ${company} (${role}): ${e.message || e}`,
            });
            emit(onEvent, { type: 'stats', data: { sent, failed } });
            await sleep(4000);
        }
    }

    emit(onEvent, { type: 'log', message: `Done. Sent ${sent} emails.` });
    emit(onEvent, { type: 'stats', data: { sent, failed } });

    return { sent, failed, dailyLimit, dryRun, roles: roleNames, companyRoleCooldownDays };
}

module.exports = { runSend };

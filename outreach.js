const { getJobTargets } = require('./scraper');
const { getDomain } = require('./hunter');
const { generateEmail } = require('./ai');
const { sendMail } = require('./mailer');
const {
    initDb,
    isAlreadySent,
    isCompanyRoleBlocked,
    markCompanyRoleSent,
    saveContact,
    markSent,
} = require('./db');
const { extractEmailsFromText, extractEmailsFromUrl } = require('./email-extractor');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function emit(onEvent, event) {
    if (typeof onEvent === 'function') onEvent(event);
}

/**
 * Runs a single outreach batch.
 * @param {object} options
 * @param {string[]} options.roles
 * @param {number} options.dailyLimit
 * @param {boolean} options.dryRun
 * @param {(event: {type: string, message?: string, data?: any}) => void} [onEvent]
 */
async function runOutreach(options, onEvent) {
    const defaultRoleDefs = [
        { name: 'angular developer', description: 'Angular TypeScript RxJS' },
        { name: 'react developer', description: 'React TypeScript' },
        { name: 'nodejs developer', description: 'Node.js Express APIs' },
        { name: 'mean developer', description: 'Angular Node.js MongoDB' },
        { name: 'mern developer', description: 'React Node.js MongoDB' },
    ];

    /** @type {{name: string, description: string}[]} */
    const roleDefs = Array.isArray(options?.roles) && options.roles.length
        ? options.roles.map(r => {
            if (typeof r === 'string') return { name: r, description: '' };
            return { name: String(r?.name || '').trim(), description: String(r?.description || '').trim() };
        }).filter(r => r.name)
        : defaultRoleDefs;

    const dailyLimit = Number.isFinite(Number(options?.dailyLimit)) ? Number(options.dailyLimit) : 50;
    const dryRun = Boolean(options?.dryRun);
    const collectOnly = Boolean(options?.collectOnly);
    const useHunterFallback = options?.useHunterFallback === undefined ? true : Boolean(options.useHunterFallback);
    const remoteOnly = options?.remoteOnly === undefined ? true : Boolean(options.remoteOnly);
    const city = String(options?.city || '').trim();
    const citiesRaw = options?.cities;
    const cities = Array.isArray(citiesRaw)
        ? citiesRaw.map(c => String(c || '').trim()).filter(Boolean)
        : String(citiesRaw || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    const companyRoleCooldownDays = Number.isFinite(Number(options?.companyRoleCooldownDays))
        ? Number(options.companyRoleCooldownDays)
        : 30;

    await initDb();

    let sent = 0;
    let failed = 0;
    let targetsFoundTotal = 0;
    let hunterContactsTotal = 0;

    const planned = new Set();
    const companyRoleSentThisRun = new Set();
    const companyContactsCache = new Map();
    const companyRoleAlreadySentCache = new Map();

    emit(onEvent, { type: 'log', message: 'Starting outreach…' });
    emit(onEvent, {
        type: 'stats',
        data: {
            sent,
            failed,
            targetsFoundTotal,
            hunterContactsTotal,
            dailyLimit,
            dryRun,
            roles: roleDefs,
            collectOnly,
            remoteOnly,
            cities: remoteOnly ? [] : (cities.length ? cities : city ? [city] : []),
            companyRoleCooldownDays,
        },
    });

    for (const roleDef of roleDefs) {
        if (sent >= dailyLimit) break;

        const roleName = roleDef.name;
        const cityList = remoteOnly ? [''] : (cities.length ? cities : city ? [city] : ['']);

        /** @type {any[]} */
        let targets = [];
        for (const cityItem of cityList) {
            if (sent >= dailyLimit) break;

            const search = `${roleDef.name} ${roleDef.description || ''} ${remoteOnly ? '' : cityItem}`
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120);

            let chunk = [];
            try {
                chunk = await getJobTargets(search, {
                    remoteOnly,
                    city: remoteOnly ? '' : cityItem,
                });
            } catch (e) {
                failed++;
                emit(onEvent, {
                    type: 'error',
                    message: `Failed fetching targets for role "${roleName}"${cityItem ? ` in ${cityItem}` : ''}: ${e.message || e}`,
                });
                emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });
                continue;
            }

            targetsFoundTotal += chunk.length;
            emit(onEvent, {
                type: 'log',
                message: `Role "${roleName}"${cityItem ? ` (${cityItem})` : ''}: found ${chunk.length} job targets`,
            });
            emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });

            targets = targets.concat(chunk.map(t => ({ ...t, __city: cityItem || '' })));
            await sleep(300);
        }

        for (const t of targets) {
            if (sent >= dailyLimit) break;
            if (!t.company) continue;

            const companyRoleKey = `${String(t.company).toLowerCase()}|${String(roleName).toLowerCase()}`;
            if (!collectOnly) {
                if (companyRoleSentThisRun.has(companyRoleKey)) continue;
                let alreadySentForCompanyRole = companyRoleAlreadySentCache.get(companyRoleKey);
                if (alreadySentForCompanyRole === undefined) {
                    alreadySentForCompanyRole = await isCompanyRoleBlocked(
                        t.company,
                        roleName,
                        companyRoleCooldownDays
                    );
                    companyRoleAlreadySentCache.set(companyRoleKey, alreadySentForCompanyRole);
                }
                if (alreadySentForCompanyRole) {
                    companyRoleSentThisRun.add(companyRoleKey);
                    emit(onEvent, {
                        type: 'log',
                        message: `Skipping ${t.company} (${roleName}) — still in cooldown for this company+role`,
                    });
                    continue;
                }
            }

            // 1) Prefer scraping emails directly from the job URL
            let contacts = [];

            // 1a) Extract from job description (many job boards include an application email here)
            if (t.jobDescription) {
                const emails = extractEmailsFromText(t.jobDescription);
                if (emails.length) {
                    contacts = emails.slice(0, 5).map(email => ({ name: '', email, company: t.company }));
                    emit(onEvent, { type: 'log', message: `Found ${contacts.length} email(s) in listing description for ${t.company}` });
                }
            }

            if (t.jobUrl) {
                if (contacts.length === 0) {
                    const emails = await extractEmailsFromUrl(t.jobUrl);
                    if (emails.length) {
                        contacts = emails.slice(0, 5).map(email => ({ name: '', email, company: t.company }));
                        emit(onEvent, { type: 'log', message: `Found ${contacts.length} email(s) on job page for ${t.company}` });
                    }
                }
            }

            // 2) Optional fallback: Hunter company lookup
            if (contacts.length === 0 && useHunterFallback) {
                try {
                    if (companyContactsCache.has(t.company)) {
                        contacts = companyContactsCache.get(t.company);
                    } else {
                        contacts = await getDomain(t.company);
                        companyContactsCache.set(t.company, contacts);
                    }
                } catch (e) {
                    failed++;
                    emit(onEvent, { type: 'error', message: `Hunter lookup failed for ${t.company}: ${e.message || e}` });
                    emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });
                    continue;
                }
            }

            hunterContactsTotal += contacts.length;
            emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });

            for (const contact of contacts) {
                if (sent >= dailyLimit) break;
                if (!contact.email) continue;
                if (planned.has(contact.email)) continue;

                // For real sending, skip any email already marked as sent in DB.
                // For collection-only, we still want to store/update the lead even if it was sent previously.
                if (!collectOnly) {
                    if (await isAlreadySent(contact.email)) continue;
                }

                try {
                    await saveContact({
                        ...contact,
                        role: roleName,
                        jobTitle: t.jobTitle,
                        jobUrl: t.jobUrl,
                        jobLocation: t.jobLocation,
                        city: remoteOnly ? null : (t.__city || city || null),
                    });

                    if (collectOnly) {
                        emit(onEvent, { type: 'log', message: `[COLLECT_ONLY] Saved ${contact.email} @ ${t.company} (${roleName})` });
                        planned.add(contact.email);
                        sent++;
                    } else {
                        const { subject, body } = await generateEmail({
                            ...contact,
                            role: roleName,
                            jobTitle: t.jobTitle,
                            jobUrl: t.jobUrl,
                        });

                        if (dryRun) {
                            emit(onEvent, { type: 'log', message: `[DRY_RUN] Would send to ${contact.email} @ ${t.company} (${roleName})` });
                            planned.add(contact.email);
                            sent++;
                            companyRoleSentThisRun.add(companyRoleKey);
                            break;
                        } else {
                            await sendMail({ to: contact.email, subject, body });
                            await markSent(contact.email);
                            await markCompanyRoleSent(t.company, roleName);
                            emit(onEvent, { type: 'sent', message: `Sent to ${contact.email} @ ${t.company} (${roleName})` });
                            planned.add(contact.email);
                            sent++;
                            companyRoleSentThisRun.add(companyRoleKey);
                            companyRoleAlreadySentCache.set(companyRoleKey, true);
                            break;
                        }
                    }

                    emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });
                    await sleep(2000);
                } catch (e) {
                    failed++;
                    emit(onEvent, { type: 'error', message: `Send failed for ${contact.email} @ ${t.company} (${roleName}): ${e.message || e}` });
                    emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });
                    await sleep(4000);
                }
            }

            await sleep(750);
        }
    }

    emit(onEvent, { type: 'log', message: `Done. Sent ${sent} emails.` });
    emit(onEvent, { type: 'stats', data: { sent, failed, targetsFoundTotal, hunterContactsTotal } });

    return { sent, failed, targetsFoundTotal, hunterContactsTotal, dryRun, dailyLimit, roles: roleDefs, collectOnly };
}

module.exports = { runOutreach };

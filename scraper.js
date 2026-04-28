const axios = require('axios');
const cheerio = require('cheerio');

function normalizeCompanyName(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function dedupeTargets(targets) {
    const seen = new Set();
    const out = [];

    for (const t of targets) {
        const key = `${(t.company || '').toLowerCase()}|${(t.jobTitle || '').toLowerCase()}`;
        if (!t.company || seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

// Best-effort: Naukri is frequently client-rendered / bot-protected.
// We keep this as a fallback for when markup happens to include company names.
async function getCompaniesFromNaukri(role = 'mern developer', city) {
    const roleSlug = String(role).replace(/\s+/g, '-');
    const citySlug = String(city || '').trim().replace(/\s+/g, '-');
    const url = citySlug
        ? `https://www.naukri.com/${roleSlug}-jobs-in-${citySlug}`
        : `https://www.naukri.com/${roleSlug}-jobs`;
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 20000,
        maxRedirects: 3,
        validateStatus: s => s >= 200 && s < 400
    });

    const $ = cheerio.load(String(data));
    const companies = [];

    // NOTE: selector may not exist depending on Naukri page variant.
    $('.comp-name, .compName, a.comp-name').each((_, el) => {
        const name = normalizeCompanyName($(el).text());
        if (name) companies.push(name);
    });

    return [...new Set(companies)].filter(Boolean);
}

async function getJobTargetsFromRemotive(search) {
    const url = 'https://remotive.com/api/remote-jobs';
    const { data } = await axios.get(url, {
        params: { search },
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 400
    });

    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return dedupeTargets(
        jobs.map(j => ({
            company: normalizeCompanyName(j.company_name),
            jobTitle: normalizeCompanyName(j.title),
            jobUrl: j.url || '',
            jobDescription: String(j.description || ''),
            jobLocation: normalizeCompanyName(j.candidate_required_location || j.job_type || ''),
            source: 'remotive'
        }))
    );
}

async function getJobTargets(role, options) {
    const remoteOnly = Boolean(options?.remoteOnly);
    const city = String(options?.city || '').trim();

    // Remote-only mode: Remotive API (reliable for server-side)
    if (remoteOnly) {
        const remotive = await getJobTargetsFromRemotive(role);
        if (remotive.length > 0) return remotive;
        return [];
    }

    // On-site/hybrid mode: prefer Naukri (trusted) companies.
    const companies = await getCompaniesFromNaukri(role, city);
    return companies.map(company => ({
        company,
        jobTitle: role,
        jobUrl: '',
        jobLocation: city || '',
        source: 'naukri'
    }));
}

module.exports = {
    getJobTargets,
    // exported for debugging / optional direct usage
    getCompaniesFromNaukri,
    getJobTargetsFromRemotive,
};
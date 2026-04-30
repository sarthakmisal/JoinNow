const axios = require('axios');
const cheerio = require('cheerio');

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function normalizeCompanyName(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .replace(/\u00a0/g, ' ')
        .trim();
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function absoluteUrl(url, baseUrl) {
    if (!url) return '';
    try {
        return new URL(url, baseUrl).toString();
    } catch {
        return '';
    }
}

function firstText($, root, selectors) {
    for (const selector of selectors || []) {
        const text = normalizeCompanyName($(root).find(selector).first().text());
        if (text) return text;
    }
    return '';
}

function firstHref($, root, selectors, baseUrl) {
    for (const selector of selectors || []) {
        const href = $(root).find(selector).first().attr('href');
        const full = absoluteUrl(href, baseUrl);
        if (full) return full;
    }
    return '';
}

function dedupeTargets(targets) {
    const seen = new Set();
    const out = [];

    for (const t of targets) {
        const company = normalizeCompanyName(t.company);
        if (!company) continue;
        const key = [
            company.toLowerCase(),
            String(t.jobTitle || '').toLowerCase(),
            String(t.jobUrl || '').toLowerCase(),
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...t, company });
    }
    return out;
}

async function fetchHtml(url) {
    const { data } = await axios.get(url, {
        headers: REQUEST_HEADERS,
        timeout: 20000,
        maxRedirects: 3,
        validateStatus: s => s >= 200 && s < 400,
    });
    return String(data || '');
}

async function getJobTargetsFromBoard(source, url, selectors, fallbackTitle, location) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const targets = [];

    for (const cardSelector of selectors.cards || []) {
        $(cardSelector).each((_, el) => {
            const company = firstText($, el, selectors.company);
            if (!company) return;

            targets.push({
                company,
                jobTitle: firstText($, el, selectors.title) || fallbackTitle,
                jobUrl: firstHref($, el, selectors.link, url),
                jobLocation: firstText($, el, selectors.location) || location || '',
                source,
            });
        });
    }

    if (targets.length === 0) {
        for (const companySelector of selectors.company || []) {
            $(companySelector).each((_, el) => {
                const company = normalizeCompanyName($(el).text());
                if (!company) return;
                targets.push({
                    company,
                    jobTitle: fallbackTitle,
                    jobUrl: '',
                    jobLocation: location || '',
                    source,
                });
            });
        }
    }

    return dedupeTargets(targets);
}

async function getCompaniesFromNaukri(role = 'mern developer', city) {
    const roleSlug = slugify(role);
    const citySlug = slugify(city);
    const url = citySlug
        ? `https://www.naukri.com/${roleSlug}-jobs-in-${citySlug}`
        : `https://www.naukri.com/${roleSlug}-jobs`;
    const targets = await getJobTargetsFromBoard(
        'naukri',
        url,
        {
            cards: ['.srp-jobtuple-wrapper', '.jobTuple', '.cust-job-tuple', 'article'],
            company: ['.comp-name', '.compName', 'a.comp-name', '[class*="company"]'],
            title: ['a.title', '.title', '[class*="title"]'],
            link: ['a.title', 'a[href*="/job-listings-"]', 'a[href]'],
            location: ['.locWdth', '.location', '[class*="location"]'],
        },
        role,
        city || ''
    );
    return targets.map(t => t.company);
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

function boardConfigs(search, city, remoteOnly) {
    const q = encodeURIComponent(search);
    const location = remoteOnly ? 'remote' : String(city || '').trim();
    const l = encodeURIComponent(location);
    const cutshortSlug = slugify(search);

    return [
        {
            source: 'naukri',
            url: location && !remoteOnly
                ? `https://www.naukri.com/${slugify(search)}-jobs-in-${slugify(location)}`
                : `https://www.naukri.com/${slugify(search)}-jobs`,
            selectors: {
                cards: ['.srp-jobtuple-wrapper', '.jobTuple', '.cust-job-tuple', 'article'],
                company: ['.comp-name', '.compName', 'a.comp-name', '[class*="company"]'],
                title: ['a.title', '.title', '[class*="title"]'],
                link: ['a.title', 'a[href*="/job-listings-"]', 'a[href]'],
                location: ['.locWdth', '.location', '[class*="location"]'],
            },
        },
        {
            source: 'indeed',
            url: `https://in.indeed.com/jobs?q=${q}&l=${l}`,
            selectors: {
                cards: ['.job_seen_beacon', '.result', '[data-testid="slider_item"]'],
                company: ['[data-testid="company-name"]', '.companyName', '[class*="company"]'],
                title: ['h2.jobTitle', 'a[data-jk] span[title]', '[class*="jobTitle"]'],
                link: ['h2.jobTitle a', 'a[data-jk]', 'a[href*="/viewjob"]'],
                location: ['[data-testid="text-location"]', '.companyLocation', '[class*="location"]'],
            },
        },
        {
            source: 'linkedin',
            url: `https://www.linkedin.com/jobs/search/?keywords=${q}&location=${l}${remoteOnly ? '&f_WT=2' : ''}`,
            selectors: {
                cards: ['.base-card', '.jobs-search__results-list li', 'li'],
                company: ['.base-search-card__subtitle', '.hidden-nested-link', '[class*="subtitle"]'],
                title: ['.base-search-card__title', '[class*="title"]'],
                link: ['a.base-card__full-link', 'a[href*="/jobs/view/"]', 'a[href]'],
                location: ['.job-search-card__location', '[class*="location"]'],
            },
        },
        {
            source: 'cutshort',
            url: `https://cutshort.io/jobs/${cutshortSlug}-jobs`,
            selectors: {
                cards: ['[class*="job"]', 'article', 'li'],
                company: ['[class*="company"]', '[class*="org"]'],
                title: ['[class*="title"]', 'h2', 'h3'],
                link: ['a[href*="/job/"]', 'a[href]'],
                location: ['[class*="location"]'],
            },
        },
        {
            source: 'tophire',
            url: `https://tophire.co/jobs?query=${q}&location=${l}`,
            selectors: {
                cards: ['[class*="job"]', 'article', 'li'],
                company: ['[class*="company"]', '[class*="employer"]'],
                title: ['[class*="title"]', 'h2', 'h3'],
                link: ['a[href*="job"]', 'a[href]'],
                location: ['[class*="location"]'],
            },
        },
        {
            source: 'weekday',
            url: `https://www.weekday.works/jobs?search=${q}&location=${l}`,
            selectors: {
                cards: ['[class*="job"]', 'article', 'li'],
                company: ['[class*="company"]', '[class*="org"]'],
                title: ['[class*="title"]', 'h2', 'h3'],
                link: ['a[href*="job"]', 'a[href]'],
                location: ['[class*="location"]'],
            },
        },
        {
            source: 'wellfound',
            url: `https://wellfound.com/jobs?query=${q}&location=${l}`,
            selectors: {
                cards: ['[data-test*="Job"]', '[class*="job"]', 'article', 'li'],
                company: ['[class*="company"]', '[class*="startup"]'],
                title: ['[class*="title"]', 'h2', 'h3'],
                link: ['a[href*="/jobs/"]', 'a[href]'],
                location: ['[class*="location"]'],
            },
        },
    ];
}

async function getJobTargets(role, options) {
    const remoteOnly = Boolean(options?.remoteOnly);
    const city = String(options?.city || '').trim();
    const sources = [];

    if (remoteOnly) {
        sources.push(getJobTargetsFromRemotive(role));
    }

    for (const config of boardConfigs(role, city, remoteOnly)) {
        sources.push(
            getJobTargetsFromBoard(
                config.source,
                config.url,
                config.selectors,
                role,
                remoteOnly ? 'Remote' : city
            )
        );
    }

    const settled = await Promise.allSettled(sources);
    const targets = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    return dedupeTargets(targets);
}

module.exports = {
    getJobTargets,
    getCompaniesFromNaukri,
    getJobTargetsFromRemotive,
};

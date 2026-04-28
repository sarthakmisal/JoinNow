const axios = require('axios');

function uniq(arr) {
    return [...new Set(arr)];
}

function extractEmailsFromText(text) {
    const raw = String(text || '');
    // Reasonable email regex for scraping.
    const matches = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

    const cleaned = matches
        .map((e) => e.trim().replace(/[),.;:!\]}]+$/g, ''))
        .map((e) => e.toLowerCase())
        .filter(Boolean)
        .filter((e) => !e.includes('example.com'))
        .filter((e) => !e.startsWith('noreply@'))
        .filter((e) => !e.startsWith('no-reply@'));

    return uniq(cleaned);
}

async function fetchHtml(url) {
    const res = await axios.get(url, {
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    });

    return String(res.data || '');
}

/**
 * Extracts email addresses from a job posting page.
 * Returns [] if the page is not reachable or contains none.
 */
async function extractEmailsFromUrl(url) {
    if (!url) return [];
    try {
        const html = await fetchHtml(url);
        return extractEmailsFromText(html);
    } catch {
        return [];
    }
}

module.exports = {
    extractEmailsFromText,
    extractEmailsFromUrl,
};

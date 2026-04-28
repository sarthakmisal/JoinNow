const axios = require('axios');

// Step 1: company name → domain
async function getDomain(company) {
    if (!process.env.HUNTER_API_KEY) {
        throw new Error('Missing HUNTER_API_KEY in environment');
    }

    const res = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: {
            company,
            api_key: process.env.HUNTER_API_KEY,
            limit: 5,
            department: 'hr'
        },
        timeout: 20000,
        validateStatus: s => s >= 200 && s < 400
    });

    const emails = Array.isArray(res.data?.data?.emails) ? res.data.data.emails : [];
    return emails.map(e => ({
        name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
        email: e.value,
        company,
    }));
}

module.exports = { getDomain };
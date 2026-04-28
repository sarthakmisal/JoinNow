const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

function roleFocus(role) {
    const r = String(role || '').toLowerCase();
    if (r.includes('angular')) return 'Angular';
    if (r.includes('react')) return 'React';
    if (r.includes('node')) return 'Node.js';
    if (r.includes('mern') || r.includes('mean')) return 'MERN';
    return 'Full Stack';
}

function buildMinimalEmailTemplate({ name, company, role, jobTitle, jobUrl }) {
    const focus = roleFocus(role);
    const greetingName = name ? name.split(' ')[0] : '';

    const subject = `Application: ${focus} Developer` + (company ? ` (${company})` : '');
    const lines = [];

    lines.push(`Hi${greetingName ? ` ${greetingName}` : ''},`);
    lines.push('');
    lines.push(`I'm Sarthak and I'm interested in the ${focus} Developer role.`);
    if (company) lines.push(`I’d love to be considered at ${company}.`);
    if (jobTitle && jobTitle !== role) lines.push(`Role: ${jobTitle}`);
    if (jobUrl) lines.push(`Job link: ${jobUrl}`);

    if (focus === 'Angular') {
        lines.push('I build Angular apps with clean components, RxJS flows, and strong API integration.');
    } else if (focus === 'React') {
        lines.push('I build React apps with reusable components, good state management, and performance in mind.');
    } else if (focus === 'Node.js') {
        lines.push('I build Node.js backends (REST APIs, auth, integrations) with reliable delivery and monitoring.');
    } else if (focus === 'MERN') {
        lines.push('I build MERN apps end-to-end (React + Node/Express + MongoDB) and ship production-ready features.');
    } else {
        lines.push('I build full-stack web apps and can contribute across frontend and backend.');
    }

    lines.push('I’ve attached my resume—happy to share relevant work and chat this week.');
    lines.push('');
    lines.push('Thanks,');
    lines.push('Sarthak');

    return { subject, body: lines.join('\n') };
}

async function generateEmail({ name, company, role, jobTitle, jobUrl }) {
    const useAi = String(process.env.USE_AI_EMAILS || '').toLowerCase() === 'true';
    if (!useAi || !process.env.ANTHROPIC_API_KEY) {
        return buildMinimalEmailTemplate({ name, company, role, jobTitle, jobUrl });
    }

    try {
        const msg = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 350,
            messages: [{
                role: 'user',
                content: `Write a minimal, professional outreach email to ${name || 'HR'} at ${company || 'the company'} for a ${role} role.
Constraints:
- Under 110 words
- Must show interest in the ${role} role (no generic fluff)
- Mention resume is attached
- If provided, include the job title/link once: ${jobTitle || ''} ${jobUrl || ''}
- Output EXACTLY:
Subject: ...\n\nBody: ...`
            }]
        });

        const text = msg.content?.[0]?.text || '';
        const [subjectLine, ...bodyParts] = text.split('\n\n');
        const subject = subjectLine.replace(/^Subject:\s*/i, '').trim() || `Application: ${roleFocus(role)} Developer`;
        const body = bodyParts.join('\n\n').replace(/^Body:\s*/i, '').trim();
        if (!body) return buildMinimalEmailTemplate({ name, company, role, jobTitle, jobUrl });
        return { subject, body };
    } catch {
        return buildMinimalEmailTemplate({ name, company, role, jobTitle, jobUrl });
    }
}

module.exports = { generateEmail };
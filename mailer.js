const nodemailer = require('nodemailer');
const fs = require('fs');

function getSmtpPass() {
    // Gmail “app passwords” are often shown with spaces; nodemailer expects raw token.
    return (process.env.SMTP_PASS || '').replace(/\s+/g, '');
}

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    // Basic rate limiting to reduce Gmail throttling
    rateDelta: 1000,
    rateLimit: 1,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
    auth: {
        user: process.env.SMTP_USER,
        pass: getSmtpPass(),
    },
});

function isTransientSmtpError(err) {
    const code = err?.code;
    const msg = String(err?.message || '').toLowerCase();
    return (
        code === 'ESOCKET' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EAI_AGAIN' ||
        msg.includes('econnreset') ||
        msg.includes('timed out') ||
        msg.includes('timeout')
    );
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function sendMail({ to, subject, body }) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        throw new Error('Missing SMTP_USER/SMTP_PASS in environment');
    }
    if (!process.env.RESUME_PATH) {
        throw new Error('Missing RESUME_PATH in environment');
    }

    const resumeBuffer = fs.readFileSync(process.env.RESUME_PATH);

    const mail = {
        from: process.env.SMTP_USER,
        to,
        subject,
        text: body,
        attachments: [{
            filename: 'Sarthak_Resume.pdf',
            content: resumeBuffer,
        }],
    };

    const maxAttempts = Number(process.env.SMTP_RETRIES || 3);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await transporter.sendMail(mail);
            return;
        } catch (err) {
            const transient = isTransientSmtpError(err);
            if (!transient || attempt === maxAttempts) throw err;

            const backoffMs = 1500 * attempt * attempt;
            await sleep(backoffMs);
        }
    }
}

module.exports = { sendMail };
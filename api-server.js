require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runOutreach } = require('./outreach');
const { runSend } = require('./sender');
const { initDb, getRoleConfigs, setRoleConfigs, getSettings, setSettings, listLeads } = require('./db');

const PORT = Number(process.env.API_PORT || 3001);

/** @type {Map<string, any>} */
const runs = new Map();

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
    });
    res.end(text);
}

function notFound(res) {
    json(res, 404, { ok: false, error: 'Not found' });
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1024 * 200) {
                reject(new Error('Payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data) return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function newId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compactRoles(input) {
    if (!Array.isArray(input)) return undefined;
    // Back-compat: roles may be strings or objects {name, description}
    const roles = input
        .map((r) => {
            if (typeof r === 'string') return { name: r, description: '' };
            if (r && typeof r === 'object') {
                return {
                    name: String(r.name || '').trim(),
                    description: String(r.description || '').trim(),
                    active: r.active === undefined ? true : Boolean(r.active),
                };
            }
            return null;
        })
        .filter(Boolean)
        .filter((r) => r.name)
        .slice(0, 20);
    return roles.length ? roles : undefined;
}

function pushLog(run, message) {
    run.logs.push({ t: Date.now(), message });
    if (run.logs.length > 400) run.logs.shift();
}

function getBuildRoot() {
    // Root build output lives at: <repo>/build
    return path.join(__dirname, 'build');
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.js') return 'text/javascript; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.ico') return 'image/x-icon';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.map') return 'application/json; charset=utf-8';
    return 'application/octet-stream';
}

function tryServeStatic(req, res, pathname) {
    const buildRoot = getBuildRoot();
    if (!fs.existsSync(buildRoot)) return false;

    // Prefer React Router build layout: build/client
    const clientRoot = fs.existsSync(path.join(buildRoot, 'client'))
        ? path.join(buildRoot, 'client')
        : buildRoot;

    // Prevent path traversal.
    const safePath = pathname.replace(/\0/g, '');
    const rel = safePath.startsWith('/') ? safePath.slice(1) : safePath;
    const requested = path.resolve(clientRoot, rel);
    if (!requested.startsWith(path.resolve(clientRoot))) return false;

    let filePath = requested;
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (stat && stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
    }

    // If exact file doesn't exist, fall back to SPA index.html.
    if (!fs.existsSync(filePath)) {
        const spaIndex = path.join(clientRoot, 'index.html');
        if (!fs.existsSync(spaIndex)) return false;
        filePath = spaIndex;
    }

    try {
        const buf = fs.readFileSync(filePath);
        res.writeHead(200, {
            'content-type': getContentType(filePath),
            // cache immutable assets for a day
            'cache-control': filePath.includes(`${path.sep}assets${path.sep}`)
                ? 'public, max-age=86400, immutable'
                : 'no-cache',
        });
        res.end(buf);
        return true;
    } catch {
        return false;
    }
}

function createServer() {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

            // Serve frontend build for everything outside /api
            if (!url.pathname.startsWith('/api')) {
                const served = tryServeStatic(req, res, url.pathname);
                if (served) return;
            }

            // Ensure DB schema exists for config endpoints and runs
            await initDb();

            if (req.method === 'GET' && url.pathname === '/api/health') {
                return json(res, 200, { ok: true });
            }

            if (req.method === 'GET' && url.pathname === '/api/config/roles') {
                const roles = await getRoleConfigs({ activeOnly: false });
                return json(res, 200, { ok: true, roles });
            }

            if (req.method === 'PUT' && url.pathname === '/api/config/roles') {
                const body = await readJson(req);
                const roles = compactRoles(body.roles);
                await setRoleConfigs(roles || []);
                return json(res, 200, { ok: true });
            }

            if (req.method === 'GET' && url.pathname === '/api/config/settings') {
                const settings = await getSettings();
                return json(res, 200, { ok: true, settings });
            }

            if (req.method === 'PUT' && url.pathname === '/api/config/settings') {
                const body = await readJson(req);
                await setSettings(body || {});
                const settings = await getSettings();
                return json(res, 200, { ok: true, settings });
            }

            if (req.method === 'GET' && url.pathname === '/api/leads') {
                const sentParam = url.searchParams.get('sent');
                const sent = sentParam === null ? undefined : sentParam === '1' || sentParam === 'true';
                const limit = Number(url.searchParams.get('limit') || 50);
                const offset = Number(url.searchParams.get('offset') || 0);

                const leads = await listLeads({
                    sent: sentParam === null ? undefined : sent,
                    limit,
                    offset,
                });
                return json(res, 200, { ok: true, leads });
            }

            if (req.method === 'POST' && url.pathname === '/api/run') {
                const body = await readJson(req);

                const settings = await getSettings();

                let roles = compactRoles(body.roles);
                if (!roles) {
                    roles = await getRoleConfigs({ activeOnly: true });
                }
                const dailyLimit = Number(body.dailyLimit || settings.daily_limit || 50);
                const remoteOnly = body.remoteOnly === undefined ? Boolean(settings.remote_only) : Boolean(body.remoteOnly);
                const city = body.city === undefined ? (settings.city || null) : String(body.city || '').trim() || null;
                const cities =
                    body.cities === undefined
                        ? String(settings.cities || 'Pune,Mumbai,Bangalore')
                        : body.cities;
                const collectOnly = body.collectOnly === undefined ? Boolean(settings.collect_only) : Boolean(body.collectOnly);
                const dryRun = collectOnly ? true : Boolean(body.dryRun);
                const useHunterFallback =
                    body.useHunterFallback === undefined
                        ? Boolean(settings.use_hunter_fallback)
                        : Boolean(body.useHunterFallback);
                const companyRoleCooldownDays = Number(
                    body.companyRoleCooldownDays ?? settings.company_role_cooldown_days ?? 30
                );

                const id = newId();
                const run = {
                    id,
                    state: 'running',
                    startedAt: Date.now(),
                    endedAt: null,
                    sent: 0,
                    failed: 0,
                    targetsFoundTotal: 0,
                    hunterContactsTotal: 0,
                    dailyLimit,
                    dryRun,
                    roles,
                    collectOnly,
                    useHunterFallback,
                    remoteOnly,
                    city,
                    companyRoleCooldownDays,
                    logs: [],
                };
                runs.set(id, run);

                pushLog(run, 'Run started');

                // Fire-and-forget async run
                (async () => {
                    try {
                        await runOutreach(
                            {
                                roles: run.roles,
                                dailyLimit: run.dailyLimit,
                                dryRun: run.dryRun,
                                collectOnly: run.collectOnly,
                                useHunterFallback: run.useHunterFallback,
                                remoteOnly: run.remoteOnly,
                                city: run.city,
                                cities,
                                companyRoleCooldownDays: run.companyRoleCooldownDays,
                            },
                            (evt) => {
                                if (!evt) return;
                                if (evt.type === 'stats' && evt.data) {
                                    run.sent = evt.data.sent ?? run.sent;
                                    run.failed = evt.data.failed ?? run.failed;
                                    run.targetsFoundTotal = evt.data.targetsFoundTotal ?? run.targetsFoundTotal;
                                    run.hunterContactsTotal = evt.data.hunterContactsTotal ?? run.hunterContactsTotal;
                                }
                                if (evt.message) pushLog(run, evt.message);
                            }
                        );
                        run.state = 'done';
                        run.endedAt = Date.now();
                        pushLog(run, 'Run finished');
                    } catch (e) {
                        run.state = 'error';
                        run.endedAt = Date.now();
                        run.failed += 1;
                        pushLog(run, `Run crashed: ${e.message || e}`);
                    }
                })();

                return json(res, 200, { ok: true, id });
            }

            if (req.method === 'POST' && url.pathname === '/api/send') {
                const body = await readJson(req);
                const settings = await getSettings();

                let roles = compactRoles(body.roles);
                if (!roles) {
                    roles = await getRoleConfigs({ activeOnly: true });
                }

                const dailyLimit = Number(body.dailyLimit || settings.daily_limit || 50);
                const dryRun = Boolean(body.dryRun);
                const companyRoleCooldownDays = Number(
                    body.companyRoleCooldownDays ?? settings.company_role_cooldown_days ?? 30
                );

                const id = newId();
                const run = {
                    id,
                    state: 'running',
                    startedAt: Date.now(),
                    endedAt: null,
                    sent: 0,
                    failed: 0,
                    targetsFoundTotal: 0,
                    hunterContactsTotal: 0,
                    dailyLimit,
                    dryRun,
                    roles,
                    collectOnly: false,
                    useHunterFallback: false,
                    remoteOnly: true,
                    city: null,
                    companyRoleCooldownDays,
                    logs: [],
                };
                runs.set(id, run);
                pushLog(run, 'Send started');

                (async () => {
                    try {
                        await runSend(
                            {
                                roles: run.roles,
                                dailyLimit: run.dailyLimit,
                                dryRun: run.dryRun,
                                companyRoleCooldownDays: run.companyRoleCooldownDays,
                            },
                            (evt) => {
                                if (!evt) return;
                                if (evt.type === 'stats' && evt.data) {
                                    run.sent = evt.data.sent ?? run.sent;
                                    run.failed = evt.data.failed ?? run.failed;
                                }
                                if (evt.message) pushLog(run, evt.message);
                            }
                        );
                        run.state = 'done';
                        run.endedAt = Date.now();
                        pushLog(run, 'Send finished');
                    } catch (e) {
                        run.state = 'error';
                        run.endedAt = Date.now();
                        run.failed += 1;
                        pushLog(run, `Send crashed: ${e.message || e}`);
                    }
                })();

                return json(res, 200, { ok: true, id });
            }

            const statusMatch = url.pathname.match(/^\/api\/status\/(.+)$/);
            if (req.method === 'GET' && statusMatch) {
                const id = statusMatch[1];
                const run = runs.get(id);
                if (!run) return json(res, 404, { ok: false, error: 'Unknown run id' });
                return json(res, 200, { ok: true, run });
            }

            return notFound(res);
        } catch (e) {
            return json(res, 500, { ok: false, error: e.message || 'Server error' });
        }
    });
}

function startServer(port = PORT) {
    const server = createServer();
    server.on('error', (err) => {
        const code = err && typeof err === 'object' ? err.code : null;
        if (code === 'EADDRINUSE') {
            console.error(`API server port ${port} is already in use. Set API_PORT to a free port.`);
        } else {
            console.error('API server failed to start:', err);
        }
        process.exit(1);
    });
    server.listen(port, () => {
        console.log(`API server listening on http://localhost:${port}`);
    });
    return server;
}

module.exports = { createServer, startServer };

if (require.main === module) {
    startServer();
}

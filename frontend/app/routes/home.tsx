import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/home";

type RunState = "running" | "done" | "error";

type RunStatus = {
  id: string;
  state: RunState;
  startedAt: number;
  endedAt: number | null;
  sent: number;
  failed: number;
  targetsFoundTotal: number;
  hunterContactsTotal: number;
  dailyLimit: number;
  dryRun: boolean;
  roles?: unknown;
  collectOnly?: boolean;
  logs: Array<{ t: number; message: string }>;
};

type RoleDef = {
  id: string;
  name: string;
  description: string;
  active: boolean;
};

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const STORAGE_KEY = "join_now.role_defs.v1";

type RoleDefPayload = { name: string; description: string };

type RoleDefPayloadV2 = { name: string; description: string; active?: boolean };

type SettingsPayload = {
  daily_limit?: number;
  remote_only?: boolean;
  use_hunter_fallback?: boolean;
  city?: string | null;
  cities?: string | null;
  company_role_cooldown_days?: number;
  automation_enabled?: boolean;
};

type Lead = {
  id: number;
  name: string | null;
  email: string;
  company: string | null;
  role: string | null;
  job_title: string | null;
  job_url: string | null;
  job_location: string | null;
  city: string | null;
  sent: boolean;
  sent_at: string | null;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Join Now – Outreach" },
    { name: "description", content: "Run outreach and view status." },
  ];
}

export default function Home() {
  const [roleDefs, setRoleDefs] = useState<RoleDef[]>([
    {
      id: newId(),
      name: "react developer",
      description:
        "React, TypeScript, hooks, state management, REST APIs, performance, UI",
      active: true,
    },
    {
      id: newId(),
      name: "angular developer",
      description: "Angular, RxJS, TypeScript, services, components, REST APIs",
      active: true,
    },
    {
      id: newId(),
      name: "nodejs developer",
      description:
        "Node.js, Express, APIs, authentication, PostgreSQL, integrations",
      active: true,
    },
    {
      id: newId(),
      name: "aws",
      description:
        "AWS, cloud, EC2, S3, Lambda, CI/CD, deployment, monitoring",
      active: true,
    },
    {
      id: newId(),
      name: "postgresql",
      description: "PostgreSQL, SQL, queries, indexing, performance",
      active: true,
    },
  ]);
  const [dailyLimit, setDailyLimit] = useState(50);
  const [useHunterFallback, setUseHunterFallback] = useState(true);
  const [remoteOnly, setRemoteOnly] = useState(true);
  const [city, setCity] = useState("");
  const [cities, setCities] = useState("Pune,Mumbai,Bangalore");
  const [companyRoleCooldownDays, setCompanyRoleCooldownDays] = useState(30);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const [sending, setSending] = useState(false);
  const [activeAction, setActiveAction] = useState<"collect" | "send" | null>(
    null
  );

  const [leadTab, setLeadTab] = useState<"unsent" | "sent">("unsent");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  // Load saved role defs
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // 0) Try backend settings
      try {
        const resp = await getJson<{ ok: boolean; settings?: SettingsPayload }>(
          "/api/config/settings"
        );
        if (cancelled) return;
        if (resp?.settings) {
          const s = resp.settings;
          if (typeof s.daily_limit === "number") setDailyLimit(s.daily_limit);
          if (typeof s.use_hunter_fallback === "boolean")
            setUseHunterFallback(s.use_hunter_fallback);
          if (typeof s.remote_only === "boolean") setRemoteOnly(s.remote_only);
          if (typeof s.city === "string") setCity(s.city);
          if (typeof s.cities === "string") setCities(s.cities);
          if (typeof s.company_role_cooldown_days === "number")
            setCompanyRoleCooldownDays(s.company_role_cooldown_days);
          if (typeof s.automation_enabled === "boolean")
            setAutomationEnabled(s.automation_enabled);
        }
      } catch {
        // ignore
      }

      // 1) Try backend (Postgres)
      try {
        const resp = await getJson<{ ok: boolean; roles: RoleDefPayloadV2[] }>(
          "/api/config/roles"
        );
        if (cancelled) return;
        if (Array.isArray(resp.roles) && resp.roles.length) {
          setRoleDefs(
            resp.roles.slice(0, 20).map((r) => ({
              id: newId(),
              name: String(r.name || "").trim(),
              description: String(r.description || "").trim(),
              active: r.active === undefined ? true : Boolean(r.active),
            }))
          );
          return;
        }
      } catch {
        // ignore
      }

      // 2) Fallback: localStorage
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const next: RoleDef[] = parsed
          .map((r: any) => ({
            id: String(r.id || newId()),
            name: String(r.name || "").trim(),
            description: String(r.description || "").trim(),
            active: r.active === undefined ? true : Boolean(r.active),
          }))
          .filter((r) => r.name.length > 0)
          .slice(0, 20);
        if (next.length) setRoleDefs(next);
      } catch {
        // ignore
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist role defs
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(roleDefs));
    } catch {
      // ignore
    }
  }, [roleDefs]);

  const roleDefsPayload = useMemo(() => {
    return roleDefs
      .map((r) => ({
        name: r.name.trim(),
        description: r.description.trim(),
        active: Boolean(r.active),
      }))
      .filter((r) => r.name.length > 0);
  }, [roleDefs]);

  const activeRoleDefsPayload = useMemo(() => {
    return roleDefsPayload.filter((r) => r.active !== false);
  }, [roleDefsPayload]);

  const saveRolesToBackend = async () => {
    setError(null);
    setSavedMsg(null);
    setSaving(true);
    try {
      const res = await fetch("/api/config/roles", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles: roleDefsPayload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedMsg("Saved to Postgres");
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save roles");
    } finally {
      setSaving(false);
    }
  };

  const saveSettingsToBackend = async () => {
    setError(null);
    setSavedMsg(null);
    setSavingSettings(true);
    try {
      const res = await fetch("/api/config/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          daily_limit: dailyLimit,
          remote_only: remoteOnly,
          use_hunter_fallback: useHunterFallback,
          city: city.trim() || null,
          cities: cities.trim() || null,
          company_role_cooldown_days: companyRoleCooldownDays,
          automation_enabled: automationEnabled,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedMsg("Settings saved");
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    if (!runId) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await getJson<{ ok: boolean; run: RunStatus }>(
          `/api/status/${runId}`
        );
        if (cancelled) return;
        setStatus(data.run);
        if (data.run.state === "running") {
          setRunning(activeAction === "collect");
          setSending(activeAction === "send");
        } else {
          setRunning(false);
          setSending(false);
          setActiveAction(null);
        }
        if (data.run.state !== "running" && pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to poll status");
      }
    };

    poll();
    pollRef.current = window.setInterval(poll, 1000);

    return () => {
      cancelled = true;
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [runId]);

  const onRun = async () => {
    setError(null);
    setStatus(null);
    setRunId(null);
    setRunning(true);
    setSending(false);
    setActiveAction("collect");

    try {
      const resp = await postJson<{ ok: boolean; id: string }>("/api/run", {
        roles: activeRoleDefsPayload,
        dailyLimit,
        remoteOnly,
        city: remoteOnly ? null : city.trim() || null,
        cities: remoteOnly ? null : cities.trim() || null,
        companyRoleCooldownDays,
        // Collect is always collect-only
        collectOnly: true,
        dryRun: true,
        useHunterFallback,
      });
      setRunId(resp.id);
    } catch (e) {
      setRunning(false);
      setError(e instanceof Error ? e.message : "Failed to start run");
    }
  };

  const onSend = async () => {
    setError(null);
    setStatus(null);
    setRunId(null);
    setSending(true);
    setRunning(false);
    setActiveAction("send");
    try {
      const resp = await postJson<{ ok: boolean; id: string }>("/api/send", {
        roles: activeRoleDefsPayload,
        dailyLimit,
        dryRun,
        companyRoleCooldownDays,
      });
      setRunId(resp.id);
    } catch (e) {
      setSending(false);
      setError(e instanceof Error ? e.message : "Failed to start send");
    }
  };

  const loadLeads = async (which: "unsent" | "sent") => {
    setLoadingLeads(true);
    setError(null);
    try {
      const sent = which === "sent" ? 1 : 0;
      const resp = await getJson<{ ok: boolean; leads: Lead[] }>(
        `/api/leads?sent=${sent}&limit=50&offset=0`
      );
      setLeads(Array.isArray(resp.leads) ? resp.leads : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leads");
    } finally {
      setLoadingLeads(false);
    }
  };

  useEffect(() => {
    loadLeads(leadTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadTab]);

  const addRole = () => {
    setRoleDefs((prev) => [
      ...prev,
      { id: newId(), name: "", description: "", active: true },
    ]);
  };

  const updateRole = (id: string, patch: Partial<RoleDef>) => {
    setRoleDefs((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  const removeRole = (id: string) => {
    setRoleDefs((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <main className="container mx-auto p-6 max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Outreach Runner</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Manage roles and run the collector.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={onRun}
            disabled={running || sending || activeRoleDefsPayload.length === 0 || dailyLimit < 1}
            title={
              activeRoleDefsPayload.length === 0
                ? "Enable at least one active role"
                : automationEnabled
                  ? "Automation is ON (9AM). You can still Collect now."
                  : "Collect emails now"
            }
          >
            {running ? "Collecting…" : "Collect"}
          </button>
          <button
            className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={onSend}
            disabled={sending || running || activeRoleDefsPayload.length === 0 || dailyLimit < 1}
            title="Send emails one-by-one"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium">Roles</label>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium"
                onClick={addRole}
                type="button"
              >
                Add
              </button>
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={saveRolesToBackend}
                type="button"
                disabled={saving || roleDefsPayload.length === 0}
                title="Saved in Postgres for all devices"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>

          {savedMsg && (
            <div className="text-sm text-gray-600 dark:text-gray-300">
              {savedMsg}
            </div>
          )}

          <div className="grid gap-3">
            {roleDefs.map((r) => (
              <div
                key={r.id}
                className="rounded-md border border-gray-200 dark:border-gray-800 p-3 grid gap-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={r.active}
                      onChange={(e) =>
                        updateRole(r.id, { active: e.target.checked })
                      }
                    />
                    <span className="font-medium">Active</span>
                  </label>

                  <input
                    className="flex-1 min-w-48 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 text-sm"
                    placeholder="Role name (e.g. react developer, aws, postgresql)"
                    value={r.name}
                    onChange={(e) => updateRole(r.id, { name: e.target.value })}
                  />
                  <button
                    className="rounded-md border border-gray-200 dark:border-gray-800 px-2 py-1 text-sm disabled:opacity-50"
                    onClick={() => removeRole(r.id)}
                    type="button"
                    disabled={roleDefs.length <= 1}
                    title={
                      roleDefs.length <= 1 ? "Need at least one role" : "Remove"
                    }
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  className="w-full min-h-20 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent p-2 text-sm"
                  placeholder="Description/keywords used to search jobs for this role"
                  value={r.description}
                  onChange={(e) =>
                    updateRole(r.id, { description: e.target.value })
                  }
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Settings</div>
            <button
              className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
              onClick={saveSettingsToBackend}
              type="button"
              disabled={savingSettings || dailyLimit < 1}
              title="Saved in Postgres for all devices"
            >
              {savingSettings ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Daily target</span>
              <input
                className="w-24 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1"
                type="number"
                min={1}
                max={500}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value || 1))}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={remoteOnly}
                onChange={(e) => setRemoteOnly(e.target.checked)}
              />
              <span className="font-medium">Remote only</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">City</span>
              <input
                className="w-40 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                type="text"
                placeholder="e.g. Pune"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                disabled={remoteOnly}
                title={remoteOnly ? "City is ignored when Remote only is enabled" : undefined}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Cities</span>
              <input
                className="w-72 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                type="text"
                placeholder="Pune,Mumbai,Bangalore"
                value={cities}
                onChange={(e) => setCities(e.target.value)}
                disabled={remoteOnly}
                title={remoteOnly ? "Cities are ignored when Remote only is enabled" : "Comma-separated rotation"}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Cooldown (days)</span>
              <input
                className="w-24 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1"
                type="number"
                min={0}
                max={365}
                value={companyRoleCooldownDays}
                onChange={(e) =>
                  setCompanyRoleCooldownDays(Number(e.target.value || 0))
                }
                title="Allows re-contacting the same company for the same role after N days"
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useHunterFallback}
                onChange={(e) => setUseHunterFallback(e.target.checked)}
              />
              <span className="font-medium">Use Hunter fallback</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="font-medium">Dry run (Send)</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={automationEnabled}
                onChange={(e) => setAutomationEnabled(e.target.checked)}
              />
              <span className="font-medium">Automation (daily 9AM)</span>
            </label>
          </div>

          <div className="text-xs text-gray-600 dark:text-gray-300">
            Collect uses only <span className="font-medium">Active</span> roles. Automation runs Collect → Send at 9AM.
          </div>
        </div>

        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium">Leads</div>
            <div className="flex items-center gap-2">
              <button
                className={`rounded-md border px-3 py-2 text-sm font-medium ${
                  leadTab === "unsent"
                    ? "border-gray-300 dark:border-gray-700"
                    : "border-gray-200 dark:border-gray-800 opacity-70"
                }`}
                type="button"
                onClick={() => setLeadTab("unsent")}
              >
                Unsent
              </button>
              <button
                className={`rounded-md border px-3 py-2 text-sm font-medium ${
                  leadTab === "sent"
                    ? "border-gray-300 dark:border-gray-700"
                    : "border-gray-200 dark:border-gray-800 opacity-70"
                }`}
                type="button"
                onClick={() => setLeadTab("sent")}
              >
                Sent
              </button>
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
                type="button"
                onClick={() => loadLeads(leadTab)}
                disabled={loadingLeads}
              >
                {loadingLeads ? "Loading…" : "Refresh"}
              </button>
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 dark:text-gray-300">
                  <th className="py-2 pr-4">Email</th>
                  <th className="py-2 pr-4">Company</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Job</th>
                  <th className="py-2 pr-4">Location</th>
                  <th className="py-2 pr-0">Sent</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {leads.map((l) => (
                  <tr
                    key={l.id}
                    className="border-t border-gray-200 dark:border-gray-800"
                  >
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <div className="font-medium">{l.email}</div>
                      {l.name ? (
                        <div className="text-xs text-gray-600 dark:text-gray-300">
                          {l.name}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {l.company || ""}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{l.role || ""}</td>
                    <td className="py-2 pr-4">
                      <div className="max-w-[28rem] truncate">
                        {l.job_title || ""}
                      </div>
                      {l.job_url ? (
                        <a
                          className="text-xs underline text-gray-600 dark:text-gray-300"
                          href={l.job_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open
                        </a>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {l.job_location || l.city || ""}
                    </td>
                    <td className="py-2 pr-0 whitespace-nowrap">
                      {l.sent ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
                {leads.length === 0 && !loadingLeads ? (
                  <tr>
                    <td
                      className="py-6 text-gray-600 dark:text-gray-300"
                      colSpan={6}
                    >
                      No leads yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-200 md:col-span-2">
            {error}
          </div>
        )}

        {status && (
          <div className="grid gap-3 rounded-md border border-gray-200 dark:border-gray-800 p-4 md:col-span-2">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                <span className="font-medium">State:</span> {status.state}
              </span>
              <span>
                <span className="font-medium">Sent:</span> {status.sent}
              </span>
              <span>
                <span className="font-medium">Failed:</span> {status.failed}
              </span>
              <span>
                <span className="font-medium">Targets:</span> {status.targetsFoundTotal}
              </span>
              <span>
                <span className="font-medium">Hunter contacts:</span> {status.hunterContactsTotal}
              </span>
            </div>

            <div className="grid gap-2">
              <div className="text-sm font-medium">Logs</div>
              <pre className="max-h-80 overflow-auto rounded-md bg-gray-50 dark:bg-gray-950/50 p-3 text-xs border border-gray-200 dark:border-gray-800">
                {status.logs.map((l) => l.message).join("\n")}
              </pre>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

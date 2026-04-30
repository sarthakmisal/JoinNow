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
  collectOnly?: boolean;
  logs: Array<{ t: number; message: string }>;
};

type RoleDef = {
  id: string;
  name: string;
  description: string;
  remote_only: boolean | null;
  city: string;
  cities: string;
  active: boolean;
};

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

type AutomationStatus = {
  automationEnabled: boolean;
  schedule: string[];
  progress: {
    dailyLimit: number;
    sentToday: number;
    remainingToday: number;
    targetReached: boolean;
  };
};

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultRole(name: string, description: string): RoleDef {
  return {
    id: newId(),
    name,
    description,
    remote_only: null,
    city: "",
    cities: "",
    active: true,
  };
}

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
    { title: "Join Now - Outreach" },
    { name: "description", content: "Run outreach and view status." },
  ];
}

export default function Home() {
  const [roleDefs, setRoleDefs] = useState<RoleDef[]>([
    defaultRole("react developer", "React, TypeScript, hooks, state management, REST APIs, performance, UI"),
    defaultRole("angular developer", "Angular, RxJS, TypeScript, services, components, REST APIs"),
    defaultRole("nodejs developer", "Node.js, Express, APIs, authentication, PostgreSQL, integrations"),
    defaultRole("aws", "AWS, cloud, EC2, S3, Lambda, CI/CD, deployment, monitoring"),
    defaultRole("postgresql", "PostgreSQL, SQL, queries, indexing, performance"),
  ]);
  const [dailyLimit, setDailyLimit] = useState(100);
  const [useHunterFallback, setUseHunterFallback] = useState(true);
  const [remoteOnly, setRemoteOnly] = useState(true);
  const [city, setCity] = useState("");
  const [cities, setCities] = useState("Pune,Mumbai,Bangalore");
  const [companyRoleCooldownDays, setCompanyRoleCooldownDays] = useState(30);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [automationStatus, setAutomationStatus] = useState<AutomationStatus | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activeAction, setActiveAction] = useState<"collect" | "send" | null>(null);
  const [leadTab, setLeadTab] = useState<"unsent" | "sent">("unsent");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const pollRef = useRef<number | null>(null);

  const roleDefsPayload = useMemo(
    () =>
      roleDefs
        .map((r) => ({
          name: r.name.trim(),
          description: r.description.trim(),
          remote_only: r.remote_only,
          city: r.city.trim() || null,
          cities: r.cities.trim() || null,
          active: Boolean(r.active),
        }))
        .filter((r) => r.name.length > 0),
    [roleDefs]
  );

  const activeRoleDefsPayload = useMemo(
    () => roleDefsPayload.filter((r) => r.active !== false),
    [roleDefsPayload]
  );

  const controlsDisabled = automationEnabled || running || sending;
  const sentToday = automationStatus?.progress.sentToday ?? 0;
  const remainingToday =
    automationStatus?.progress.remainingToday ?? Math.max(0, dailyLimit - sentToday);

  const updateRole = (id: string, patch: Partial<RoleDef>) => {
    setRoleDefs((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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

  const loadAutomationStatus = async () => {
    try {
      const resp = await getJson<{ ok: boolean } & AutomationStatus>("/api/automation/status");
      setAutomationStatus(resp);
      setAutomationEnabled(Boolean(resp.automationEnabled));
    } catch {
      // The main error surface is reserved for user-triggered actions.
    }
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const resp = await getJson<{ ok: boolean; settings?: SettingsPayload }>(
          "/api/config/settings"
        );
        if (cancelled || !resp.settings) return;
        const s = resp.settings;
        if (typeof s.daily_limit === "number") setDailyLimit(s.daily_limit);
        if (typeof s.use_hunter_fallback === "boolean") setUseHunterFallback(s.use_hunter_fallback);
        if (typeof s.remote_only === "boolean") setRemoteOnly(s.remote_only);
        if (typeof s.city === "string") setCity(s.city);
        if (typeof s.cities === "string") setCities(s.cities);
        if (typeof s.company_role_cooldown_days === "number")
          setCompanyRoleCooldownDays(s.company_role_cooldown_days);
        if (typeof s.automation_enabled === "boolean") setAutomationEnabled(s.automation_enabled);
      } catch {
        // ignore
      }

      try {
        const resp = await getJson<{ ok: boolean; roles: any[] }>("/api/config/roles");
        if (cancelled) return;
        if (Array.isArray(resp.roles) && resp.roles.length) {
          setRoleDefs(
            resp.roles.slice(0, 20).map((r) => ({
              id: newId(),
              name: String(r.name || "").trim(),
              description: String(r.description || "").trim(),
              remote_only: typeof r.remote_only === "boolean" ? r.remote_only : null,
              city: String(r.city || ""),
              cities: String(r.cities || ""),
              active: r.active === undefined ? true : Boolean(r.active),
            }))
          );
        }
      } catch {
        // ignore
      }

      await loadAutomationStatus();
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadLeads(leadTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadTab]);

  useEffect(() => {
    const id = window.setInterval(loadAutomationStatus, automationEnabled ? 5000 : 30000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationEnabled]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await getJson<{ ok: boolean; run: RunStatus }>(`/api/status/${runId}`);
        if (cancelled) return;
        setStatus(data.run);
        if (data.run.state === "running") {
          setRunning(activeAction === "collect");
          setSending(activeAction === "send");
        } else {
          setRunning(false);
          setSending(false);
          setActiveAction(null);
          loadLeads(leadTab);
          loadAutomationStatus();
        }
        if (data.run.state !== "running" && pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to poll status");
      }
    };

    poll();
    pollRef.current = window.setInterval(poll, 1000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [runId]);

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
      setSavedMsg("Roles saved");
      window.setTimeout(() => setSavedMsg(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save roles");
    } finally {
      setSaving(false);
    }
  };

  const saveSettingsToBackend = async (automationOverride = automationEnabled) => {
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
          automation_enabled: automationOverride,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAutomationEnabled(automationOverride);
      setSavedMsg("Settings saved");
      window.setTimeout(() => setSavedMsg(null), 2500);
      await loadAutomationStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleAutomation = async () => {
    await saveSettingsToBackend(!automationEnabled);
  };

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

  return (
    <main className="container mx-auto p-6 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Outreach Runner</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Configure roles, collect job contacts, and send resume outreach.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
              automationEnabled
                ? "border-green-500 text-green-700 dark:text-green-300"
                : "border-gray-200 dark:border-gray-800"
            }`}
            onClick={toggleAutomation}
            disabled={savingSettings}
            type="button"
          >
            {automationEnabled ? "Automation On" : "Automation Off"}
          </button>
          <button
            className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={onRun}
            disabled={controlsDisabled || activeRoleDefsPayload.length === 0 || dailyLimit < 1}
          >
            {running ? "Collecting..." : "Collect"}
          </button>
          <button
            className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
            onClick={onSend}
            disabled={controlsDisabled || activeRoleDefsPayload.length === 0 || dailyLimit < 1}
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      {automationEnabled && (
        <section className="mt-6 rounded-md border border-gray-200 dark:border-gray-800 p-4">
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <span><span className="font-medium">Sent today:</span> {sentToday}</span>
            <span><span className="font-medium">Remaining:</span> {remainingToday}</span>
            <span><span className="font-medium">Target:</span> {automationStatus?.progress.dailyLimit ?? dailyLimit}</span>
            <span><span className="font-medium">Runs:</span> {(automationStatus?.schedule || ["08:00", "13:00", "23:00"]).join(", ")}</span>
          </div>
        </section>
      )}

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium">Roles</label>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={() => setRoleDefs((prev) => [...prev, defaultRole("", "")])}
                type="button"
                disabled={controlsDisabled}
              >
                Add
              </button>
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
                onClick={saveRolesToBackend}
                type="button"
                disabled={controlsDisabled || saving || roleDefsPayload.length === 0}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {savedMsg && <div className="text-sm text-gray-600 dark:text-gray-300">{savedMsg}</div>}

          <div className="grid gap-3">
            {roleDefs.map((r) => (
              <div key={r.id} className="rounded-md border border-gray-200 dark:border-gray-800 p-3 grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={r.active}
                      disabled={controlsDisabled}
                      onChange={(e) => updateRole(r.id, { active: e.target.checked })}
                    />
                    <span className="font-medium">Active</span>
                  </label>
                  <input
                    className="flex-1 min-w-48 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                    placeholder="Role name"
                    value={r.name}
                    disabled={controlsDisabled}
                    onChange={(e) => updateRole(r.id, { name: e.target.value })}
                  />
                  <button
                    className="rounded-md border border-gray-200 dark:border-gray-800 px-2 py-1 text-sm disabled:opacity-50"
                    onClick={() => setRoleDefs((prev) => prev.filter((x) => x.id !== r.id))}
                    type="button"
                    disabled={controlsDisabled || roleDefs.length <= 1}
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  className="w-full min-h-20 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent p-2 text-sm disabled:opacity-50"
                  placeholder="Mail text / role requirements. This text is used as the email body."
                  value={r.description}
                  disabled={controlsDisabled}
                  onChange={(e) => updateRole(r.id, { description: e.target.value })}
                  spellCheck={false}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <select
                    className="rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                    value={r.remote_only === null ? "global" : r.remote_only ? "remote" : "city"}
                    disabled={controlsDisabled}
                    onChange={(e) =>
                      updateRole(r.id, {
                        remote_only: e.target.value === "global" ? null : e.target.value === "remote",
                      })
                    }
                  >
                    <option value="global">Global location</option>
                    <option value="remote">Remote</option>
                    <option value="city">City based</option>
                  </select>
                  {r.remote_only === false && (
                    <>
                      <input
                        className="w-40 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                        placeholder="City"
                        value={r.city}
                        disabled={controlsDisabled}
                        onChange={(e) => updateRole(r.id, { city: e.target.value })}
                      />
                      <input
                        className="w-72 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                        placeholder="Cities: Pune,Mumbai,Bangalore"
                        value={r.cities}
                        disabled={controlsDisabled}
                        onChange={(e) => updateRole(r.id, { cities: e.target.value })}
                      />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Settings</div>
            <button
              className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
              onClick={() => saveSettingsToBackend()}
              type="button"
              disabled={controlsDisabled || savingSettings || dailyLimit < 1}
            >
              {savingSettings ? "Saving..." : "Save"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Daily target</span>
              <input
                className="w-24 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                type="number"
                min={1}
                max={500}
                value={dailyLimit}
                disabled={controlsDisabled}
                onChange={(e) => setDailyLimit(Number(e.target.value || 1))}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={remoteOnly}
                disabled={controlsDisabled}
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
                disabled={controlsDisabled || remoteOnly}
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
                disabled={controlsDisabled || remoteOnly}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium">Cooldown days</span>
              <input
                className="w-24 rounded-md border border-gray-200 dark:border-gray-800 bg-transparent px-2 py-1 disabled:opacity-50"
                type="number"
                min={0}
                max={365}
                value={companyRoleCooldownDays}
                disabled={controlsDisabled}
                onChange={(e) => setCompanyRoleCooldownDays(Number(e.target.value || 0))}
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useHunterFallback}
                disabled={controlsDisabled}
                onChange={(e) => setUseHunterFallback(e.target.checked)}
              />
              <span className="font-medium">Use Hunter fallback</span>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dryRun}
                disabled={controlsDisabled}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="font-medium">Dry run (Send)</span>
            </label>
          </div>

          <div className="text-xs text-gray-600 dark:text-gray-300">
            Automation runs at 8AM, 1PM, and 11PM. Later runs stop once the daily target is reached.
          </div>
        </div>

        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-4 grid gap-3 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium">Leads</div>
            <div className="flex items-center gap-2">
              {(["unsent", "sent"] as const).map((tab) => (
                <button
                  key={tab}
                  className={`rounded-md border px-3 py-2 text-sm font-medium ${
                    leadTab === tab
                      ? "border-gray-300 dark:border-gray-700"
                      : "border-gray-200 dark:border-gray-800 opacity-70"
                  }`}
                  type="button"
                  onClick={() => setLeadTab(tab)}
                >
                  {tab === "unsent" ? "Unsent" : "Sent"}
                </button>
              ))}
              <button
                className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
                type="button"
                onClick={() => loadLeads(leadTab)}
                disabled={loadingLeads}
              >
                {loadingLeads ? "Loading..." : "Refresh"}
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
                  <tr key={l.id} className="border-t border-gray-200 dark:border-gray-800">
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <div className="font-medium">{l.email}</div>
                      {l.name && <div className="text-xs text-gray-600 dark:text-gray-300">{l.name}</div>}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{l.company || ""}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{l.role || ""}</td>
                    <td className="py-2 pr-4">
                      <div className="max-w-[28rem] truncate">{l.job_title || ""}</div>
                      {l.job_url && (
                        <a className="text-xs underline text-gray-600 dark:text-gray-300" href={l.job_url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      )}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{l.job_location || l.city || ""}</td>
                    <td className="py-2 pr-0 whitespace-nowrap">{l.sent ? "Yes" : "No"}</td>
                  </tr>
                ))}
                {leads.length === 0 && !loadingLeads && (
                  <tr>
                    <td className="py-6 text-gray-600 dark:text-gray-300" colSpan={6}>
                      No leads yet.
                    </td>
                  </tr>
                )}
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
              <span><span className="font-medium">State:</span> {status.state}</span>
              <span><span className="font-medium">{status.collectOnly ? "Collected" : "Sent"}:</span> {status.sent}</span>
              <span><span className="font-medium">Failed:</span> {status.failed}</span>
              <span><span className="font-medium">Targets:</span> {status.targetsFoundTotal}</span>
              <span><span className="font-medium">Hunter contacts:</span> {status.hunterContactsTotal}</span>
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

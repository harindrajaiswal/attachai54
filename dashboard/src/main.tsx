import React, { useEffect, useState, useCallback, Component, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
} from 'recharts';
import {
  LayoutDashboard,
  Building2,
  BookOpen,
  MessageSquareText,
  Palette,
  Users,
  ChartNoAxesCombined,
  Settings,
  Activity,
  LogOut,
  Sun,
  Moon,
  Menu,
  X,
  Plus,
  Search,
  Copy,
  RefreshCw,
  Trash2,
  Save,
  ChevronRight,
  KeyRound,
  Upload,
  Download,
  CheckCircle2,
  AlertCircle,
  Database,
  Server,
  Cloud,
  Mail,
  Sparkles,
  ShieldCheck,
  PanelRight,
  History,
  RotateCcw,
  Eye,
} from 'lucide-react';
import './index.css';

type Client = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  config: any;
  prompt: string;
  domains: string[];
  stats?: any;
  apiKey?: { enabled: boolean; createdAt: string };
  embedCode?: string;
};
type Page =
  | 'overview'
  | 'clients'
  | 'prompt'
  | 'knowledge'
  | 'widget'
  | 'leads'
  | 'sessions'
  | 'analytics'
  | 'providers'
  | 'system'
  | 'health';
const nav: [Page, string, React.ElementType][] = [
  ['overview', 'Overview', LayoutDashboard],
  ['clients', 'Clients', Building2],
  ['prompt', 'Prompt Studio', MessageSquareText],
  ['knowledge', 'Knowledge', BookOpen],
  ['widget', 'Widget', Palette],
  ['leads', 'Leads', Users],
  ['sessions', 'Sessions', History],
  ['analytics', 'Analytics', ChartNoAxesCombined],
  ['providers', 'Providers', Cloud],
  ['system', 'System settings', Settings],
  ['health', 'Health', Activity],
];
const key = () => sessionStorage.getItem('orbit.adminKey') || '';
async function api<T = any>(path: string, init: RequestInit = {}) {
  const r = await fetch('/admin' + path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      'x-admin-api-key': key(),
      ...init.headers,
    },
  });
  if (!r.ok) {
    let m = `Request failed (${r.status})`;
    let payload: any;
    try {
      payload = await r.json();
      m = payload.error.message;
    } catch {}
    const error = new Error(m) as Error & { payload?: any };
    error.payload = payload;
    throw error;
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <main className="min-h-screen grid place-items-center p-8">
        <div className="card max-w-lg p-8 text-center">
          <AlertCircle className="mx-auto mb-4 text-red-500" size={36} />
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="opacity-60 my-3">{this.state.error.message}</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload dashboard
          </button>
        </div>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Login({ done }: { done: () => void }) {
  const [value, setValue] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    sessionStorage.setItem('orbit.adminKey', value);
    try {
      await api('/auth/validate', { method: 'POST' });
      done();
    } catch (e) {
      sessionStorage.removeItem('orbit.adminKey');
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-[#090b10] text-white grid lg:grid-cols-2">
      <section className="hidden lg:flex p-14 flex-col justify-between bg-[radial-gradient(circle_at_20%_20%,#6d5dfc44,transparent_38%),radial-gradient(circle_at_80%_70%,#0ea5e944,transparent_35%)]">
        <div className="flex items-center gap-3 font-bold text-lg">
          <span className="grid place-items-center size-9 rounded-xl bg-violet-500">
            <Sparkles size={19} />
          </span>
          Orbit AI
        </div>
        <div>
          <div className="text-violet-300 text-sm font-semibold tracking-widest uppercase mb-4">
            Operations control plane
          </div>
          <h1 className="text-5xl font-semibold leading-tight max-w-xl">
            One precise view of every AI customer experience.
          </h1>
          <p className="mt-5 text-white/55 max-w-lg">
            Configure, monitor, and improve your multi-tenant assistants with real operational data.
          </p>
        </div>
        <p className="text-xs text-white/35">
          Secure admin access · Credentials remain in this browser tab
        </p>
      </section>
      <section className="grid place-items-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2 mb-12 font-bold">
            <Sparkles className="text-violet-400" />
            Orbit AI
          </div>
          <div className="size-11 rounded-xl bg-violet-500/15 text-violet-400 grid place-items-center mb-6">
            <KeyRound />
          </div>
          <h2 className="text-3xl font-semibold">Welcome back</h2>
          <p className="text-white/45 mt-2 mb-8">Enter your administrator API key to continue.</p>
          <label className="block text-sm mb-2" htmlFor="admin-key">
            Admin API key
          </label>
          <input
            id="admin-key"
            autoFocus
            required
            type="password"
            minLength={16}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="field bg-white/5 border-white/10"
            placeholder="••••••••••••••••"
          />
          <button disabled={busy} className="btn primary w-full mt-4">
            {busy ? 'Validating…' : 'Continue securely'} <ChevronRight size={17} />
          </button>
          <div className="mt-5 flex gap-2 text-xs text-white/40">
            <ShieldCheck size={15} />
            Stored in sessionStorage only and cleared on logout.
          </div>
        </form>
      </section>
    </main>
  );
}
function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-10 w-56" />
      <div className="grid md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((x) => (
          <div key={x} className="skeleton h-32" />
        ))}
      </div>
      <div className="skeleton h-72" />
    </div>
  );
}
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-14 text-center">
      <div className="mx-auto size-11 grid place-items-center rounded-xl bg-violet-500/10 text-violet-500 mb-3">
        <Sparkles size={20} />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm opacity-50 mt-1">{body}</p>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-sm grid place-items-center p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card w-full max-w-lg max-h-[90vh] overflow-auto p-6">
        <header className="flex justify-between mb-5">
          <h2 className="font-semibold text-lg">{title}</h2>
          <button aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
function Overview() {
  const [d, setD] = useState<any>();
  useEffect(() => {
    api('/overview')
      .then(setD)
      .catch((e) => toast.error(e.message));
  }, []);
  if (!d) return <Skeleton />;
  const cards = [
    ['Clients', d.clients, Building2],
    ['Active', d.activeClients, CheckCircle2],
    ['Chats today', d.conversationsToday, MessageSquareText],
    ['Leads today', d.leadsToday, Users],
  ];
  return (
    <>
      <Header title="Overview" sub="Live operations across every tenant" />
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map(([n, v, I]: any) => (
          <div className="card p-5" key={n}>
            <div className="flex justify-between">
              <span className="text-sm opacity-55">{n}</span>
              <I size={18} className="text-violet-500" />
            </div>
            <strong className="text-3xl block mt-5">{v}</strong>
            <span className="text-xs opacity-40">Recorded in SQLite</span>
          </div>
        ))}
      </div>
      <div className="grid xl:grid-cols-[1.5fr_1fr] gap-5 mt-5">
        <div className="card p-6">
          <h3 className="font-semibold">Recent activity</h3>
          {d.recentAudits.length ? (
            <div className="mt-4 divide-y divide-black/5 dark:divide-white/5">
              {d.recentAudits.map((x: any) => (
                <div key={x.id} className="py-3 flex gap-3">
                  <span className="size-2 mt-2 rounded-full bg-violet-500" />
                  <div>
                    <div className="text-sm font-medium">{x.action.replaceAll('.', ' · ')}</div>
                    <div className="text-xs opacity-40">
                      {new Date(x.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No activity yet"
              body="Actions taken in the dashboard will appear here."
            />
          )}
        </div>
        <div className="card p-6">
          <h3 className="font-semibold">Provider stack</h3>
          {Object.entries(d.providers).map(([n, v]: any) => (
            <div key={n} className="mt-4 flex items-center justify-between">
              <span className="capitalize text-sm opacity-60">{n}</span>
              <span className="text-sm font-medium">{typeof v === 'string' ? v : v.provider}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
function Header({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm opacity-50 mt-1">{sub}</p>
      </div>
      {action}
    </header>
  );
}
function Clients({
  selected: _selected,
  setSelected,
}: {
  selected?: Client;
  setSelected: (x: Client) => void;
}) {
  const [data, setData] = useState<Client[]>([]),
    [q, setQ] = useState(''),
    [status, setStatus] = useState('all'),
    [modal, setModal] = useState(false),
    [edit, setEdit] = useState<Client>(),
    [copyOnce, setCopyOnce] = useState<{
      clientName: string;
      apiKey: string;
      embedCode: string;
    }>();
  const load = useCallback(
    () =>
      api<any>(`/clients?q=${encodeURIComponent(q)}&status=${status}&pageSize=100`)
        .then((x) => setData(x.items))
        .catch((e) => toast.error(e.message)),
    [q, status],
  );
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<any>('/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: f.get('name'),
          slug: f.get('slug'),
          domains: String(f.get('domains'))
            .split(',')
            .map((x) => x.trim()),
          prompt: 'Answer using only the supplied knowledge.',
          config: {
            assistantName: f.get('name'),
            teamEmail: f.get('email') || undefined,
            fallbackMessage: 'I’m sorry, I don’t have that information.',
          },
        }),
      });

      setModal(false);
      load();

      setCopyOnce({
        clientName: r.client.name,
        apiKey: r.apiKey,
        embedCode: r.embedCode,
      });
      toast.success('Client created. Save the API key before closing the dialog.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function rotate(c: Client) {
    if (
      !confirm(`Rotate the API key for ${c.name}? The previous key will stop working immediately.`)
    )
      return;
    const r = await api<any>(`/clients/${c.id}/rotate-key`, { method: 'POST' });
    setCopyOnce({
      clientName: c.name,
      apiKey: r.apiKey,
      embedCode: r.embedCode,
    });
    load();
  }
  async function setKeyEnabled(c: Client, enabled: boolean) {
    await api(`/clients/${c.id}/key/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    toast.success(`API key ${enabled ? 'enabled' : 'disabled'}`);
    load();
  }
  async function remove(c: Client) {
    if (!confirm(`Permanently delete ${c.name}?`)) return;
    await api(`/clients/${c.id}`, { method: 'DELETE' });
    toast.success('Client deleted');
    load();
  }
  async function saveEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api(`/clients/${edit!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: f.get('name'),
        enabled: f.get('enabled') === 'on',
        domains: String(f.get('domains'))
          .split(',')
          .map((x) => x.trim()),
        config: { ...edit!.config, teamEmail: f.get('email') || undefined },
      }),
    });
    setEdit(undefined);
    toast.success('Client updated');
    load();
  }
  return (
    <>
      <Header
        title="Clients"
        sub="Search, onboard, suspend, and manage tenant access"
        action={
          <button className="btn primary" onClick={() => setModal(true)}>
            <Plus size={17} />
            New client
          </button>
        }
      />
      <div className="card">
        <div className="p-4 flex flex-wrap gap-3 border-b border-black/5 dark:border-white/5">
          <div className="relative flex-1 min-w-52">
            <Search size={17} className="absolute left-3 top-3 opacity-40" />
            <input
              aria-label="Search clients"
              className="field pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clients…"
            />
          </div>
          <select className="field w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        {data.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left opacity-45">
                <tr>
                  <th className="p-4">Client</th>
                  <th>Domains</th>
                  <th>Status</th>
                  <th>Key</th>
                  <th className="text-right p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-black/5 dark:border-white/5 hover:bg-violet-500/5"
                  >
                    <td className="p-4">
                      <button
                        className="font-semibold hover:text-violet-500"
                        onClick={() => setSelected(c)}
                      >
                        {c.name}
                      </button>
                      <div className="text-xs opacity-40">/{c.slug}</div>
                    </td>
                    <td>{c.domains?.join(', ')}</td>
                    <td>
                      <span
                        className={`px-2 py-1 rounded-full text-xs ${c.enabled ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}
                      >
                        {c.enabled ? 'Active' : 'Suspended'}
                      </span>
                    </td>
                    <td>{c.apiKey?.enabled ? 'Enabled' : 'Disabled'}</td>
                    <td className="p-4 text-right">
                      <button
                        aria-label="Rotate API key"
                        className="btn secondary p-2 mr-2"
                        onClick={() => rotate(c)}
                      >
                        <RefreshCw size={16} />
                      </button>
                      <button
                        aria-label={c.apiKey?.enabled ? 'Disable API key' : 'Enable API key'}
                        className="btn secondary p-2 mr-2"
                        onClick={() => setKeyEnabled(c, !c.apiKey?.enabled)}
                      >
                        <KeyRound size={16} />
                      </button>
                      <button
                        aria-label="Edit"
                        className="btn secondary p-2 mr-2"
                        onClick={() => setEdit(c)}
                      >
                        <PanelRight size={16} />
                      </button>
                      <button
                        aria-label="Delete"
                        className="btn danger p-2"
                        onClick={() => remove(c)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No clients found" body="Adjust your filters or create the first tenant." />
        )}
      </div>
      {modal && (
        <Modal title="Create client" onClose={() => setModal(false)}>
          <form onSubmit={create} className="space-y-4">
            <label className="text-sm">
              Company name
              <input name="name" required className="field mt-1" />
            </label>
            <label className="text-sm">
              Slug
              <input
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]{1,62}"
                className="field mt-1"
              />
            </label>
            <label className="text-sm">
              Allowed domains
              <input
                name="domains"
                required
                placeholder="example.com, app.example.com"
                className="field mt-1"
              />
            </label>
            <label className="text-sm">
              Team email
              <input name="email" type="email" className="field mt-1" />
            </label>
            <button className="btn primary w-full">Create client</button>
          </form>
        </Modal>
      )}
      {edit && (
        <Modal title="Edit client" onClose={() => setEdit(undefined)}>
          <form onSubmit={saveEdit} className="space-y-4">
            <label className="text-sm">
              Name
              <input name="name" required defaultValue={edit.name} className="field mt-1" />
            </label>
            <label className="text-sm">
              Team email
              <input
                name="email"
                type="email"
                defaultValue={edit.config.teamEmail}
                className="field mt-1"
              />
            </label>
            <label className="text-sm">
              Allowed domains
              <input name="domains" defaultValue={edit.domains.join(', ')} className="field mt-1" />
            </label>
            <label className="flex gap-2">
              <input type="checkbox" name="enabled" defaultChecked={edit.enabled} />
              Client active
            </label>
            <button className="btn primary w-full">
              <Save size={16} />
              Save changes
            </button>
          </form>
        </Modal>
      )}
      {copyOnce && (
        <Modal title="API key and embed code — shown once" onClose={() => setCopyOnce(undefined)}>
          <p className="text-sm opacity-60 mb-3">
            Save the API key and embed code for {copyOnce.clientName}. The key cannot be retrieved
            after this dialog closes.
          </p>

          <label className="text-sm font-medium" htmlFor="copy-once-api-key">
            API key
          </label>
          <div className="flex gap-2 mt-2">
            <input
              id="copy-once-api-key"
              aria-label="API key shown once"
              readOnly
              type="password"
              className="field font-mono"
              value={copyOnce.apiKey}
            />
            <button
              className="btn secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(copyOnce.apiKey);
                toast.success('API key copied');
              }}
            >
              <Copy size={16} /> Copy
            </button>
          </div>

          <label className="text-sm font-medium block mt-5" htmlFor="copy-once-embed-code">
            Embed code
          </label>
          <textarea
            id="copy-once-embed-code"
            aria-label="Embed code shown once"
            readOnly
            rows={4}
            className="field mt-2 font-mono text-xs"
            value={copyOnce.embedCode}
          />
          <button
            className="btn secondary mt-2"
            onClick={async () => {
              await navigator.clipboard.writeText(copyOnce.embedCode);
              toast.success('Embed code copied');
            }}
          >
            <Copy size={16} /> Copy embed code
          </button>
        </Modal>
      )}
    </>
  );
}
function NeedClient({ children, client }: { children: ReactNode; client?: Client }) {
  return client ? (
    <>{children}</>
  ) : (
    <div className="card">
      <Empty
        title="Select a client"
        body="Choose a client from the Clients page to manage this area."
      />
    </div>
  );
}
function Prompt({ client, refresh }: { client?: Client; refresh: () => void }) {
  const [prompt, setPrompt] = useState(client?.prompt || ''),
    [history, setHistory] = useState<any[]>([]),
    [saved, setSaved] = useState(true),
    [preview, setPreview] = useState<any>();
  useEffect(() => {
    setPrompt(client?.prompt || '');
    if (client) api(`/clients/${client.id}/prompts/history`).then(setHistory);
  }, [client]);
  useEffect(() => {
    if (!client || prompt === client.prompt) return;
    setSaved(false);
    const t = setTimeout(
      () =>
        api(`/clients/${client.id}`, { method: 'PATCH', body: JSON.stringify({ prompt }) })
          .then(() => {
            setSaved(true);
            refresh();
          })
          .catch((e) => toast.error(e.message)),
      800,
    );
    return () => clearTimeout(t);
  }, [prompt, client, refresh]);
  async function restore(id: string) {
    await api(`/clients/${client!.id}/prompts/${id}/restore`, { method: 'POST' });
    toast.success('Version restored');
    refresh();
  }
  async function test(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q'));
    try {
      const r = await api<any>(`/clients/${client!.id}/prompts/preview`, {
        method: 'POST',
        body: JSON.stringify({ question: q, prompt }),
      });
      setPreview(r);
    } catch (error) {
      const e = error as Error & { payload?: any };
      setPreview({
        status: 'provider_error',
        error: e.message,
        retrieval: e.payload?.error?.details?.retrieval,
      });
    }
  }
  return (
    <NeedClient client={client}>
      <Header
        title="Prompt Studio"
        sub={`Autosaved instructions for ${client?.name}`}
        action={
          <span className="text-xs opacity-50 flex gap-2 items-center">
            {saved ? (
              <>
                <CheckCircle2 size={15} />
                Saved
              </>
            ) : (
              <>Saving…</>
            )}
          </span>
        }
      />
      <div className="grid xl:grid-cols-[1.5fr_1fr] gap-5">
        <div className="card p-5">
          <label className="font-medium" htmlFor="prompt">
            System prompt
          </label>
          <textarea
            id="prompt"
            className="field mt-3 min-h-96 font-mono text-sm leading-6"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex justify-between mt-3">
            <span className="text-xs opacity-40">
              {prompt.length.toLocaleString()} / 20,000 characters
            </span>
            <button
              className="btn secondary text-xs"
              onClick={async () => {
                await api(`/clients/${client!.id}/prompts/reset`, { method: 'POST' });
                refresh();
              }}
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
        </div>
        <div className="space-y-5">
          <div className="card p-5">
            <h3 className="font-semibold flex gap-2">
              <Eye size={18} />
              Preview
            </h3>
            <form onSubmit={test} className="mt-4">
              <input name="q" required className="field" placeholder="Ask a test question" />
              <button className="btn primary mt-3 w-full">Run preview</button>
            </form>
            {preview && (
              <div className="mt-4 text-sm p-3 rounded-xl bg-violet-500/8 space-y-2">
                <div className="text-xs uppercase tracking-wide opacity-50">{preview.status}</div>
                <div>{preview.answer || preview.error}</div>
                <div className="text-xs opacity-60">
                  Retrieved {preview.retrieval?.count ?? 0} chunk(s)
                  {preview.retrieval?.sources
                    ?.map((x: any) => ` · ${x.source} (${x.score})`)
                    .join('')}
                </div>
              </div>
            )}
          </div>
          <div className="card p-5">
            <h3 className="font-semibold flex gap-2">
              <History size={18} />
              Version history
            </h3>
            {history.length ? (
              <div className="mt-3 space-y-2">
                {history.slice(0, 8).map((v) => (
                  <button
                    onClick={() => restore(v.id)}
                    key={v.id}
                    className="w-full text-left p-3 rounded-xl hover:bg-violet-500/8"
                  >
                    <div className="text-xs opacity-40">
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                    <div className="text-sm truncate mt-1">{v.prompt}</div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm opacity-45 mt-4">Versions appear after edits.</p>
            )}
          </div>
        </div>
      </div>
    </NeedClient>
  );
}
function Knowledge({ client }: { client?: Client }) {
  const [files, setFiles] = useState<any[]>([]),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    () => client && api(`/clients/${client.id}/knowledge`).then(setFiles),
    [client],
  );
  useEffect(() => {
    load();
  }, [load]);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    const f = new FormData();
    [...e.target.files].forEach((x) => f.append('file', x));
    setBusy(true);
    try {
      await api(`/clients/${client!.id}/knowledge`, { method: 'POST', body: f });
      toast.success(`${e.target.files.length} file(s) indexed`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
      // Storage may already contain the file even when indexing failed.
      void load();
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }
  async function del(name: string) {
    if (!confirm(`Delete ${name}?`)) return;
    await api(`/clients/${client!.id}/knowledge/${encodeURIComponent(name)}`, { method: 'DELETE' });
    load();
  }
  return (
    <NeedClient client={client}>
      <Header
        title="Knowledge"
        sub={`Documents and embedding state for ${client?.name}`}
        action={
          <>
            <input
              id="upload"
              hidden
              type="file"
              multiple
              disabled={busy}
              accept=".txt,.md,.pdf,.docx"
              onChange={upload}
            />
            <label htmlFor="upload" className="btn primary">
              <Upload size={17} />
              {busy ? 'Indexing…' : 'Upload files'}
            </label>
          </>
        }
      />
      <div className="card">
        <div className="p-4 flex justify-end">
          <button
            className="btn secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/clients/${client!.id}/knowledge/rebuild`, { method: 'POST' });
                await load();
                toast.success('Index rebuilt');
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={16} />
            Rebuild all
          </button>
        </div>
        {files.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left opacity-45">
                <tr>
                  <th className="p-4">File</th>
                  <th>Size</th>
                  <th>Chunks</th>
                  <th>Embedding</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.filename} className="border-t border-black/5 dark:border-white/5">
                    <td className="p-4 font-medium">{f.filename}</td>
                    <td>{Math.ceil((f.size || f.bytes) / 1024)} KB</td>
                    <td>{f.chunks}</td>
                    <td>
                      <span className={`flex gap-1 ${f.embeddingStatus === 'failed' ? 'text-red-500' : f.embeddingStatus === 'ready' ? 'text-emerald-500' : 'text-amber-500'}`}>
                        {f.embeddingStatus === 'failed' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
                        {f.embeddingStatus || f.status}
                      </span>
                    </td>
                    <td>
                      <button
                        aria-label={`Delete ${f.filename}`}
                        className="btn danger p-2"
                        onClick={() => del(f.filename)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No knowledge uploaded"
            body="Upload TXT, Markdown, PDF, or DOCX files to build the tenant index."
          />
        )}
      </div>
    </NeedClient>
  );
}
function Widget({ client, refresh }: { client?: Client; refresh: () => void }) {
  const cfg = client?.config.widget || {},
    [v, setV] = useState<any>(cfg),
    [snippet, setSnippet] = useState('');

  useEffect(() => {
    setV(client?.config.widget || {});
    setSnippet('');
  }, [client]);

  async function save() {
    await api(`/clients/${client!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ config: { ...client!.config, widget: v } }),
    });
    refresh();
    toast.success('Widget configuration saved');
  }
  async function generateEmbedCode() {
    if (!client) return;

    if (
      !confirm(
        `Generate a new embed code for ${client.name}? The current public API key will stop working immediately.`,
      )
    )
      return;

    try {
      const r = await api<any>(`/clients/${client.id}/rotate-key`, {
        method: 'POST',
      });

      setSnippet(typeof r?.embedCode === 'string' ? r.embedCode : '');
      toast.success('New embed code generated. The previous key is no longer valid.');
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <NeedClient client={client}>
      <Header
        title="Widget designer"
        sub="Customize every surface and preview changes live"
        action={
          <button className="btn primary" onClick={save}>
            <Save size={16} />
            Save
          </button>
        }
      />
      <div className="grid xl:grid-cols-[1fr_1.2fr] gap-5">
        <div className="card p-5 grid sm:grid-cols-2 gap-4">
          <label className="text-sm">
            Primary color
            <input
              type="color"
              className="field h-11"
              value={v.primaryColor || '#6d5dfc'}
              onChange={(e) => setV({ ...v, primaryColor: e.target.value })}
            />
          </label>
          <label className="text-sm">
            Assistant name
            <input
              className="field mt-1"
              value={v.assistantName || client?.config.assistantName || ''}
              onChange={(e) => setV({ ...v, assistantName: e.target.value })}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Welcome message
            <input
              className="field mt-1"
              value={v.welcomeMessage || ''}
              onChange={(e) => setV({ ...v, welcomeMessage: e.target.value })}
            />
          </label>
          <label className="text-sm">
            Position
            <select
              className="field mt-1"
              value={v.position || 'bottom-right'}
              onChange={(e) => setV({ ...v, position: e.target.value })}
            >
              <option>bottom-right</option>
              <option>bottom-left</option>
            </select>
          </label>
          <label className="text-sm">
            Icon
            <select
              className="field mt-1"
              value={v.icon || 'chat'}
              onChange={(e) => setV({ ...v, icon: e.target.value })}
            >
              <option>chat</option>
              <option>sparkles</option>
              <option>help</option>
            </select>
          </label>
          <label className="text-sm">
            Width
            <input
              type="number"
              min="280"
              max="600"
              className="field mt-1"
              value={v.width || 360}
              onChange={(e) => setV({ ...v, width: +e.target.value })}
            />
          </label>
          <label className="text-sm">
            Height
            <input
              type="number"
              min="360"
              max="800"
              className="field mt-1"
              value={v.height || 520}
              onChange={(e) => setV({ ...v, height: +e.target.value })}
            />
          </label>
          <label className="text-sm">
            Radius
            <input
              type="range"
              min="0"
              max="32"
              value={v.radius || 18}
              onChange={(e) => setV({ ...v, radius: +e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!v.dark}
              onChange={(e) => setV({ ...v, dark: e.target.checked })}
            />
            Dark widget
          </label>
          <label className="text-sm sm:col-span-2">
            Suggested questions
            <textarea
              className="field mt-1"
              value={(v.suggestedQuestions || []).join('\n')}
              onChange={(e) =>
                setV({ ...v, suggestedQuestions: e.target.value.split('\n').filter(Boolean) })
              }
            />
          </label>
        </div>
        <div>
          <div className="card min-h-[500px] p-6 bg-[radial-gradient(circle_at_60%_20%,#6d5dfc15,transparent_35%)] flex items-center justify-center">
            <div
              style={{
                width: v.width || 360,
                height: Math.min(v.height || 520, 460),
                borderRadius: v.radius || 18,
                background: v.dark ? '#11141b' : 'white',
                color: v.dark ? 'white' : '#172033',
              }}
              className="shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-4 text-white" style={{ background: v.primaryColor || '#6d5dfc' }}>
                <strong>{v.assistantName || client?.config.assistantName}</strong>
                <div className="text-xs opacity-70">Typically replies instantly</div>
              </div>
              <div className="p-4 flex-1">
                <div className="rounded-xl bg-slate-500/10 p-3 text-sm">
                  {v.welcomeMessage || client?.config.welcomeMessage || 'How can I help today?'}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(v.suggestedQuestions || []).map((q: string) => (
                    <span key={q} className="text-xs rounded-full border border-current/15 p-2">
                      {q}
                    </span>
                  ))}
                </div>
              </div>
              <div className="m-3 rounded-xl border border-current/10 p-3 text-sm opacity-45">
                Type your message…
              </div>
            </div>
          </div>
          <div className="card p-4 mt-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium">Embed code</span>

              <button className="btn secondary text-xs" onClick={generateEmbedCode}>
                <KeyRound size={14} />
                Generate embed code
              </button>
            </div>

            {snippet ? (
              <>
                <code className="text-xs block mt-3 overflow-x-auto opacity-60">{snippet}</code>

                <button
                  className="btn secondary text-xs mt-3"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(snippet)
                      .then(() => toast.success('Embed code copied'))
                  }
                >
                  <Copy size={14} />
                  Copy embed code
                </button>
              </>
            ) : (
              <p className="text-xs opacity-50 mt-3">
                Generate an embed code to get a new client-specific widget key.
              </p>
            )}
          </div>
        </div>
      </div>
    </NeedClient>
  );
}
function Leads({ client }: { client?: Client }) {
  const [d, setD] = useState<any[]>([]),
    [q, setQ] = useState(''),
    [status, setStatus] = useState('all'),
    [open, setOpen] = useState<any>();
  const load = useCallback(
    () =>
      client &&
      api<any>(
        `/clients/${client.id}/leads?q=${encodeURIComponent(q)}&status=${status}&pageSize=100`,
      ).then((x) => setD(x.items)),
    [client, q, status],
  );
  useEffect(() => {
    load();
  }, [load]);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(e.currentTarget);
    await api(`/clients/${client!.id}/leads/${open.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: f.get('status'),
        assignee: f.get('assignee') || null,
        notes: f.get('notes'),
      }),
    });
    setOpen(undefined);
    load();
    toast.success('Lead updated');
  }
  return (
    <NeedClient client={client}>
      <Header
        title="Leads"
        sub={`Pipeline and linked conversations for ${client?.name}`}
        action={
          <a
            className="btn secondary"
            href={`/admin/clients/${client?.id}/leads.csv`}
            onClick={async (e) => {
              e.preventDefault();
              const r = await fetch(e.currentTarget.href, {
                  headers: { 'x-admin-api-key': key() },
                }),
                b = await r.blob(),
                u = URL.createObjectURL(b),
                a = document.createElement('a');
              a.href = u;
              a.download = 'leads.csv';
              a.click();
              URL.revokeObjectURL(u);
            }}
          >
            <Download size={16} />
            Export CSV
          </a>
        }
      />
      <div className="card">
        <div className="p-4 flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 opacity-40" size={16} />
            <input
              className="field pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search leads…"
            />
          </div>
          <select className="field w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            {['new', 'contacted', 'qualified', 'won', 'lost'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        {d.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left opacity-45">
                <tr>
                  <th className="p-4">Lead</th>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.map((x) => (
                  <tr className="border-t border-black/5 dark:border-white/5" key={x.id}>
                    <td className="p-4">
                      <b>{x.name}</b>
                      <div className="text-xs opacity-40">{x.email || x.phone || 'No contact'}</div>
                    </td>
                    <td className="max-w-64 truncate">{x.requirement}</td>
                    <td className="capitalize">{x.status}</td>
                    <td>{x.assignee || 'Unassigned'}</td>
                    <td>
                      <button
                        className="btn secondary p-2"
                        onClick={async () =>
                          setOpen(await api(`/clients/${client!.id}/leads/${x.id}`))
                        }
                      >
                        <PanelRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No leads yet"
            body="Leads captured through the public API will appear here."
          />
        )}
      </div>
      {open && (
        <Modal title="Lead details" onClose={() => setOpen(undefined)}>
          <div className="mb-4 text-sm">
            <b>{open.name}</b>
            <div className="opacity-50">
              {open.email} {open.phone}
            </div>
            <p className="mt-3">{open.requirement}</p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save(e);
            }}
            className="space-y-3"
          >
            <label className="text-sm">
              Status
              <select name="status" className="field mt-1" defaultValue={open.status}>
                {['new', 'contacted', 'qualified', 'won', 'lost'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Assignee
              <input name="assignee" className="field mt-1" defaultValue={open.assignee} />
            </label>
            <label className="text-sm">
              Notes
              <textarea name="notes" className="field mt-1 min-h-28" defaultValue={open.notes} />
            </label>
            {open.conversation && (
              <div className="rounded-xl bg-slate-500/8 p-3">
                <div className="text-xs font-semibold mb-2">Linked conversation</div>
                {open.conversation.messages.map((m: any, i: number) => (
                  <p key={i} className="text-sm">
                    <b>{m.role}:</b> {m.content}
                  </p>
                ))}
              </div>
            )}
            <button className="btn primary w-full">Save workflow</button>
          </form>
        </Modal>
      )}
    </NeedClient>
  );
}
function Sessions({ client }: { client?: Client }) {
  const [items, setItems] = useState<any[]>([]),
    [detail, setDetail] = useState<any>();
  useEffect(() => {
    setDetail(undefined);
    if (client) api(`/clients/${client.id}/conversations`).then(setItems);
  }, [client]);
  async function open(id: string) {
    setDetail(await api(`/clients/${client!.id}/conversations/${id}`));
  }
  return (
    <NeedClient client={client}>
      <Header title="Sessions" sub={`Tenant-scoped conversation history for ${client?.name}`} />
      <div className="grid xl:grid-cols-[.8fr_1.2fr] gap-5">
        <div className="card p-4">
          {items.length ? (
            items.map((x) => (
              <button
                key={x.id}
                className="w-full text-left p-3 rounded-xl hover:bg-violet-500/8"
                onClick={() => open(x.id)}
              >
                <div className="font-medium">
                  {x.messageCount} messages · {x.leadCount} leads
                </div>
                <div className="text-xs opacity-45 mt-1">
                  {new Date(x.lastMessageAt || x.createdAt).toLocaleString()}
                </div>
              </button>
            ))
          ) : (
            <Empty
              title="No sessions yet"
              body="Public and widget conversations will appear here."
            />
          )}
        </div>
        <div className="card p-5">
          {detail ? (
            <div className="space-y-3">
              <div className="text-xs opacity-45">Session {detail.session_id}</div>
              {detail.messages.map((m: any, i: number) => (
                <div
                  key={i}
                  className={`p-3 rounded-xl text-sm ${m.role === 'user' ? 'bg-violet-500/10' : 'bg-black/5 dark:bg-white/5'}`}
                >
                  <div className="text-xs uppercase opacity-45 mb-1">{m.role}</div>
                  {m.content}
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="Select a session"
              body="Choose a tenant conversation to inspect its history."
            />
          )}
        </div>
      </div>
    </NeedClient>
  );
}
function Analytics({ client }: { client?: Client }) {
  const [d, setD] = useState<any>(),
    [period, setPeriod] = useState('daily');
  useEffect(() => {
    if (client) api(`/clients/${client.id}/analytics?period=${period}`).then(setD);
  }, [client, period]);
  return (
    <NeedClient client={client}>
      <Header
        title="Analytics"
        sub="Measured engagement, conversion, and latency"
        action={
          <select className="field w-32" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option>daily</option>
            <option>weekly</option>
            <option>monthly</option>
          </select>
        }
      />
      {!d ? (
        <Skeleton />
      ) : (
        <>
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {[
              ['Chats', d.conversations],
              ['Leads', d.leads],
              ['Conversion', `${(d.conversionRate * 100).toFixed(1)}%`],
              ['Avg latency', `${Math.round(d.averageResponseLatencyMs)} ms`],
            ].map((x) => (
              <div className="card p-5" key={x[0]}>
                <div className="text-sm opacity-50">{x[0]}</div>
                <div className="text-3xl font-semibold mt-3">{x[1]}</div>
              </div>
            ))}
          </div>
          <div className="grid xl:grid-cols-2 gap-5 mt-5">
            <div className="card p-5 h-80">
              <h3 className="font-semibold mb-4">Chats and leads</h3>
              <ResponsiveContainer width="100%" height="85%">
                <AreaChart data={d.series}>
                  <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#6d5dfc" stopOpacity=".45" />
                      <stop offset="1" stopColor="#6d5dfc" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.12} />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Area dataKey="chats" stroke="#6d5dfc" fill="url(#g)" />
                  <Area dataKey="leads" stroke="#10b981" fill="transparent" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="card p-5">
              <h3 className="font-semibold">Top questions</h3>
              {d.topQuestions.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={d.topQuestions} layout="vertical">
                    <XAxis type="number" />
                    <YAxis dataKey="question" type="category" width={120} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#6d5dfc" radius={5} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty
                  title="No questions yet"
                  body="Real customer questions will be ranked here."
                />
              )}
            </div>
            <div className="card p-5">
              <h3 className="font-semibold">Knowledge usage</h3>
              {d.knowledgeUsage.length ? (
                <pre>{JSON.stringify(d.knowledgeUsage, null, 2)}</pre>
              ) : (
                <Empty
                  title="No retrieval usage yet"
                  body="Source usage appears after knowledge-backed chats."
                />
              )}
            </div>
            <div className="card p-5">
              <h3 className="font-semibold">Top pages</h3>
              <Empty
                title="Page tracking unavailable"
                body="The public API does not currently collect referring page URLs. No synthetic data is shown."
              />
            </div>
          </div>
        </>
      )}
    </NeedClient>
  );
}
function Providers() {
  const [d, setD] = useState<any>(),
    [form, setForm] = useState<any>({ provider: 'local', temperature: 0 });
  useEffect(() => {
    api('/settings/provider').then((x: any) => {
      setD(x);
      if (x.staged?.provider) setForm(x.staged);
    });
  }, []);
  async function test() {
    try {
      const x = await api<any>('/settings/provider/test', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (x.connected) toast.success(`Connected to ${x.provider}`);
      else toast.error(`Test failed: ${x.status}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function save() {
    const { apiKey: _apiKey, ...safe } = form;
    await api('/settings/provider', { method: 'PUT', body: JSON.stringify(safe) });
    toast.success('Non-secret settings staged. Restart required.');
  }
  async function env() {
    const x = await api<any>('/settings/provider/env', {
      method: 'POST',
      body: JSON.stringify(form),
    });
    await navigator.clipboard.writeText(x.content);
    toast.success('Restart-ready environment config copied');
  }
  return (
    <>
      <Header
        title="Provider settings"
        sub="Switch OpenAI-compatible providers without source changes"
      />
      <div className="grid xl:grid-cols-[1fr_1.2fr] gap-5">
        <div className="card p-5">
          <h3 className="font-semibold">Running provider</h3>
          {d && (
            <div className="mt-4 space-y-3 text-sm">
              {Object.entries(d.running).map(([k, v]) => (
                <div className="flex justify-between" key={k}>
                  <span className="opacity-45 capitalize">{k}</span>
                  <span>{String(v ?? '—')}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-5 p-3 rounded-xl bg-amber-500/10 text-amber-600 text-xs">
            Staged settings require a process restart. Secrets are never persisted or returned.
          </div>
        </div>
        <div className="card p-5 grid sm:grid-cols-2 gap-4">
          <label className="text-sm">
            Provider
            <select
              className="field mt-1"
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              {[
                'local',
                'nvidia',
                'openai',
                'openrouter',
                'groq',
                'together',
                'deepseek',
                'custom',
                'azure',
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Model
            <input
              className="field mt-1"
              value={form.model || ''}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Base URL
            <input
              className="field mt-1"
              placeholder="Preset used when blank"
              value={form.baseUrl || ''}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value || undefined })}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            API key (write-only, used for this test/config export)
            <input
              type="password"
              autoComplete="new-password"
              className="field mt-1"
              value={form.apiKey || ''}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </label>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button className="btn primary" onClick={test}>
              <Activity size={16} />
              Test connection
            </button>
            <button className="btn secondary" onClick={save}>
              <Save size={16} />
              Stage settings
            </button>
            <button className="btn secondary" onClick={env}>
              <Copy size={16} />
              Copy env config
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
function System() {
  const [d, setD] = useState<any>();
  useEffect(() => {
    api('/settings/system').then(setD);
  }, []);
  if (!d) return <Skeleton />;
  const rows: [string, any, React.ElementType][] = [
    ['General', d.general, Settings],
    ['SMTP', d.smtp, Mail],
    ['Storage', d.storage, Database],
    ['Database', d.database, Server],
    ['API & CORS', d.api, ShieldCheck],
    ['Environment', d.environment, Activity],
  ];
  return (
    <>
      <Header title="System settings" sub="Safe diagnostics with sensitive values redacted" />
      <div className="grid md:grid-cols-2 gap-5">
        {rows.map(([name, obj, I]) => (
          <div className="card p-5" key={name}>
            <h3 className="font-semibold flex gap-2">
              <I size={18} className="text-violet-500" />
              {name}
            </h3>
            <div className="mt-4 space-y-3">
              {Object.entries(obj).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 text-sm">
                  <span className="opacity-45">{k}</span>
                  <span className="text-right break-all">
                    {typeof v === 'object' ? JSON.stringify(v) : String(v ?? 'Not configured')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
function Health() {
  const [d, setD] = useState<any>();
  useEffect(() => {
    const f = () =>
      api('/health')
        .then(setD)
        .catch(() => {});
    f();
    const t = setInterval(f, 5000);
    return () => clearInterval(t);
  }, []);
  if (!d) return <Skeleton />;
  return (
    <>
      <Header
        title="System health"
        sub="Realtime polling every five seconds"
        action={
          <span className="flex items-center gap-2 text-sm text-emerald-500">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            Live
          </span>
        }
      />
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {Object.entries(d.providers).map(([n, v]: any) => (
          <div className="card p-5" key={n}>
            <div className="flex justify-between">
              <span className="font-semibold capitalize">{n}</span>
              {v.connected ? (
                <CheckCircle2 className="text-emerald-500" />
              ) : (
                <AlertCircle className="text-red-500" />
              )}
            </div>
            <div className="mt-5 text-sm opacity-50">{v.provider}</div>
            <div className="text-xs mt-1">
              {v.status || v.detail || (v.connected ? 'Operational' : 'Unavailable')}
            </div>
          </div>
        ))}
      </div>
      <div className="card p-5 mt-5 grid sm:grid-cols-3 gap-5">
        <div>
          <div className="text-xs opacity-45">Uptime</div>
          <b>{Math.floor(d.uptimeSeconds)} sec</b>
        </div>
        <div>
          <div className="text-xs opacity-45">Memory RSS</div>
          <b>{Math.round(d.memory.rss / 1024 / 1024)} MB</b>
        </div>
        <div>
          <div className="text-xs opacity-45">Version</div>
          <b>{d.version}</b>
        </div>
      </div>
    </>
  );
}
function App() {
  const [authed, setAuthed] = useState(!!key()),
    [page, setPage] = useState<Page>('overview'),
    [dark, setDark] = useState(localStorage.getItem('orbit.theme') === 'dark'),
    [mobile, setMobile] = useState(false),
    [selected, setSelectedState] = useState<Client>();
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('orbit.theme', dark ? 'dark' : 'light');
  }, [dark]);
  const select = async (c: Client) => {
    const full = await api<Client>(`/clients/${c.id}`);
    setSelectedState(full);
    setPage('prompt');
  };
  const refresh = useCallback(async () => {
    if (selected) setSelectedState(await api(`/clients/${selected.id}`));
  }, [selected?.id]);
  if (!authed) return <Login done={() => setAuthed(true)} />;
  const content =
    page === 'overview' ? (
      <Overview />
    ) : page === 'clients' ? (
      <Clients selected={selected} setSelected={select} />
    ) : page === 'prompt' ? (
      <Prompt client={selected} refresh={refresh} />
    ) : page === 'knowledge' ? (
      <Knowledge client={selected} />
    ) : page === 'widget' ? (
      <Widget client={selected} refresh={refresh} />
    ) : page === 'leads' ? (
      <Leads client={selected} />
    ) : page === 'sessions' ? (
      <Sessions client={selected} />
    ) : page === 'analytics' ? (
      <Analytics client={selected} />
    ) : page === 'providers' ? (
      <Providers />
    ) : page === 'system' ? (
      <System />
    ) : (
      <Health />
    );
  return (
    <div className="min-h-screen bg-[#f4f6fa] dark:bg-[#090b10] dark:text-[#e5e9f2]">
      <aside
        className={`${mobile ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed z-40 inset-y-0 left-0 w-64 bg-white dark:bg-[#0e1117] border-r border-black/5 dark:border-white/5 transition-transform flex flex-col`}
      >
        <div className="h-18 p-5 flex items-center justify-between">
          <div className="flex items-center gap-3 font-bold">
            <span className="size-8 grid place-items-center rounded-lg bg-violet-500 text-white">
              <Sparkles size={17} />
            </span>
            Orbit AI
          </div>
          <button className="md:hidden" onClick={() => setMobile(false)}>
            <X />
          </button>
        </div>
        {selected && (
          <div className="mx-3 mb-3 p-3 rounded-xl bg-violet-500/8">
            <div className="text-[10px] uppercase tracking-wider opacity-40">Selected client</div>
            <div className="text-sm font-semibold truncate mt-1">{selected.name}</div>
          </div>
        )}
        <nav className="px-3 flex-1 overflow-y-auto" aria-label="Main navigation">
          {nav.map(([id, label, I]) => (
            <button
              key={id}
              onClick={() => {
                setPage(id);
                setMobile(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm mb-1 ${page === id ? 'nav-active font-semibold' : 'opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5'}`}
            >
              <I size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-black/5 dark:border-white/5">
          <button
            className="w-full flex items-center gap-3 px-3 py-2 text-sm opacity-60 hover:text-red-500"
            onClick={() => {
              sessionStorage.removeItem('orbit.adminKey');
              setAuthed(false);
            }}
          >
            <LogOut size={17} />
            Log out
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          aria-label="Close menu"
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="md:pl-64">
        <header className="h-18 sticky top-0 z-20 bg-[#f4f6fa]/80 dark:bg-[#090b10]/80 backdrop-blur-xl flex items-center justify-between px-4 md:px-8 border-b border-black/5 dark:border-white/5">
          <button className="md:hidden" aria-label="Open menu" onClick={() => setMobile(true)}>
            <Menu />
          </button>
          <div className="hidden md:block text-xs opacity-45">
            Workspace / <span className="capitalize">{page}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              aria-label="Toggle theme"
              className="btn secondary p-2"
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <span className="size-8 rounded-full bg-gradient-to-br from-violet-500 to-sky-400" />
          </div>
        </header>
        <main className="p-4 md:p-8 max-w-[1500px] mx-auto">{content}</main>
      </div>
      <Toaster richColors theme={dark ? 'dark' : 'light'} position="bottom-right" />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);

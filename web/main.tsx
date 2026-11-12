import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Property = {
  slug: string;
  name: string;
  category: string;
  city: string;
  headline: string;
  blurb: string;
};
type Inquiry = {
  id: string;
  property_slug: string;
  name: string;
  email: string;
  message: string;
  stage: string;
  crm_status: string;
  last_error: string | null;
  deal_id: string | null;
  owner: string | null;
  follow_up_at: string | null;
  overdue: boolean;
};
type Activity = {
  id: string;
  kind: "received" | "stage" | "follow_up";
  details: { owner?: string | null; stage?: string; dueAt?: string | null };
  created_at: string;
};
type Conversion = {
  property_slug: string;
  source: string;
  campaign: string;
  submissions: number;
};
type Copy = {
  slug: string;
  headline: string;
  blurb: string;
  draft_headline: string | null;
  draft_blurb: string | null;
};
const labels: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  closed: "Closed",
  pending: "Queued",
  sending: "Syncing",
  retry: "Waiting to retry",
  synced: "Synced",
  failed: "Failed",
};
async function api<T>(
  url: string,
  {
    method = "GET",
    token = "",
    body,
  }: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch("/api" + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Unable to complete request.");
  return data;
}
function Public({
  properties,
  reload,
}: {
  properties: Property[];
  reload: () => void;
}) {
  const params = new URLSearchParams(location.search);
  const [selected, setSelected] = useState(params.get("property") || "");
  const [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [requestKey, setKey] = useState(() => crypto.randomUUID());
  const active = properties.find((p) => p.slug === selected) || properties[0];
  function select(p: Property) {
    setSelected(p.slug);
    setSent(false);
    setError("");
    setKey(crypto.randomUUID());
    const u = new URL(location.href);
    u.searchParams.set("property", p.slug);
    history.replaceState(null, "", u);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget),
      current = new URLSearchParams(location.search);
    const campaign = Object.fromEntries(
      [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
      ].flatMap((k) => {
        const value = current.get(k)?.trim().slice(0, 100);
        return value ? [[k, value]] : [];
      }),
    );
    setBusy(true);
    setError("");
    try {
      await api("/inquiries", {
        method: "POST",
        body: {
          requestKey,
          propertySlug: active.slug,
          name: f.get("name"),
          email: f.get("email"),
          message: f.get("message"),
          campaign,
        },
      });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!active)
    return (
      <section className="panel">
        <h2>Explore our properties</h2>
        <p>No properties are available.</p>
        <button onClick={reload}>Reload properties</button>
      </section>
    );
  return (
    <>
      <div className="intro">
        <span className="eyebrow">THE PROPERTY COLLECTION</span>
        <h1>Find your next place.</h1>
        <p>
          Explore three demo properties and send an inquiry directly to the
          right team.
        </p>
      </div>
      <div className="cards">
        {properties.map((p) => (
          <button
            className={"property " + (p.slug === active.slug ? "selected" : "")}
            key={p.slug}
            aria-pressed={p.slug === active.slug}
            onClick={() => select(p)}
            disabled={busy}
          >
            <span className="eyebrow">{p.category}</span>
            <strong>{p.name}</strong>
            <span>{p.city}</span>
          </button>
        ))}
      </div>
      <div className="split">
        <section className="panel property-copy">
          <span className="eyebrow">{active.name}</span>
          <h2>{active.headline}</h2>
          <p>{active.blurb}</p>
        </section>
        <section className="panel">
          <h2>Make an inquiry</h2>
          {sent ? (
            <div role="status">
              <p>Thanks. Your inquiry was sent to {active.name}.</p>
              <button
                onClick={() => {
                  setKey(crypto.randomUUID());
                  setSent(false);
                }}
              >
                Send another inquiry
              </button>
            </div>
          ) : (
            <form
              key={active.slug}
              onSubmit={submit}
              onChange={() => {
                if (error) {
                  setKey(crypto.randomUUID());
                  setError("");
                }
              }}
            >
              <label>
                Name
                <input
                  name="name"
                  autoComplete="name"
                  maxLength={100}
                  required
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                />
              </label>
              <label>
                What are you planning?
                <textarea name="message" maxLength={2000} required rows={4} />
              </label>
              {error && <p role="alert">{error}</p>}
              <button className="primary" disabled={busy}>
                {busy ? "Sending…" : "Send inquiry"}
              </button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
function Staff({
  properties,
  reload,
}: {
  properties: Property[];
  reload: () => void;
}) {
  const [token, setToken] = useState(""),
    [filter, setFilter] = useState(""),
    [viewFilter, setViewFilter] = useState("all"),
    [tab, setTab] = useState("inbox");
  const [activity, setActivity] = useState<{
    inquiryId: string;
    events: Activity[];
  } | null>(null);
  const [inquiries, setRows] = useState<Inquiry[]>([]),
    [conversions, setConversions] = useState<Conversion[]>([]),
    [copies, setCopies] = useState<Copy[]>([]);
  const [mode, setMode] = useState(""),
    [notice, setNotice] = useState(""),
    [problem, setProblem] = useState("");
  async function load(t: string, f = filter, view = viewFilter) {
    const query = new URLSearchParams({ view });
    if (f) query.set("property", f);
    const [q, c, p] = await Promise.all([
      api<{ mode: string; inquiries: Inquiry[] }>("/staff/inquiries?" + query, {
        token: t,
      }),
      api<Conversion[]>("/staff/conversions", { token: t }),
      api<Copy[]>("/staff/content", { token: t }),
    ]);
    setRows(q.inquiries);
    setConversions(c);
    setCopies(p);
    setMode(q.mode);
  }
  async function perform(fn: () => Promise<void>) {
    setNotice("");
    setProblem("");
    try {
      await fn();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }
  if (!token)
    return (
      <section className="panel signin">
        <h1>Staff workspace</h1>
        <p>Enter the staff token configured for this demo.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              t = String(f.get("token"));
            void perform(async () => {
              await load(t);
              setToken(t);
            });
          }}
        >
          <label>
            Staff token
            <input name="token" type="password" required />
          </label>
          <button className="primary">Open workspace</button>
        </form>
        {problem && <p role="alert">{problem}</p>}
      </section>
    );
  const names = Object.fromEntries(properties.map((p) => [p.slug, p.name]));
  return (
    <>
      <div className="intro compact">
        <span className="eyebrow">
          {mode === "demo" ? "DEMO CRM" : "HUBSPOT CRM"}
        </span>
        <h1>Staff workspace</h1>
        <p>
          Follow up on inquiries, review campaign submissions, and publish
          property updates.
        </p>
      </div>
      <div className="toolbar" aria-label="Workspace sections">
        {[
          ["inbox", "Inquiry inbox"],
          ["campaigns", "Campaigns"],
          ["content", "Site content"],
        ].map(([key, title]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {title}
          </button>
        ))}
        <button
          onClick={() =>
            void perform(async () => {
              await load(token);
              setNotice("Workspace refreshed.");
            })
          }
        >
          Refresh
        </button>
        <button
          onClick={() => {
            setToken("");
            setRows([]);
            setConversions([]);
            setCopies([]);
            setActivity(null);
            setProblem("");
            setNotice("");
          }}
        >
          Lock workspace
        </button>
      </div>
      {problem && <p role="alert">{problem}</p>}
      {notice && <p role="status">{notice}</p>}
      {tab === "inbox" && (
        <section className="panel">
          <div className="toolbar">
            <label>
              Filter by property
              <select
                value={filter}
                onChange={(e) => {
                  const next = e.target.value;
                  setFilter(next);
                  void perform(async () => {
                    await load(token, next);
                  });
                }}
              >
                <option value="">All properties</option>
                {properties.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Follow-up queue
              <select
                value={viewFilter}
                onChange={(e) => {
                  const next = e.target.value;
                  setViewFilter(next);
                  void perform(() => load(token, filter, next));
                }}
              >
                <option value="all">All inquiries</option>
                <option value="unassigned">Unassigned</option>
                <option value="overdue">Overdue</option>
              </select>
            </label>
            <button
              onClick={() =>
                void perform(async () => {
                  const r = await api<{ status: string }>("/staff/sync", {
                    method: "POST",
                    token,
                  });
                  await load(token);
                  setNotice("CRM queue: " + r.status + ".");
                })
              }
            >
              Run one sync
            </button>
          </div>
          {!inquiries.length && <p>No inquiries for this selection.</p>}
          {inquiries.map((r) => (
            <article className="inquiry" key={r.id}>
              <div>
                <h3>{r.name}</h3>
                <span>
                  {names[r.property_slug] || r.property_slug} · {r.email}
                </span>
                <p>{r.message}</p>
                <p className="follow-up-summary">
                  {r.owner ? "Assigned to " + r.owner : "Unassigned"} ·{" "}
                  {r.follow_up_at
                    ? (r.overdue ? "Overdue since " : "Follow up by ") +
                      new Date(r.follow_up_at).toLocaleString()
                    : "No follow-up scheduled"}
                </p>
                <form
                  className="follow-up"
                  key={JSON.stringify([r.owner, r.follow_up_at])}
                  aria-label={"Follow-up for " + r.name}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const values = new FormData(e.currentTarget);
                    const date = String(values.get("dueAt") || "");
                    void perform(async () => {
                      await api("/staff/inquiries/" + r.id + "/follow-up", {
                        method: "PUT",
                        token,
                        body: {
                          owner:
                            String(values.get("owner") || "").trim() || null,
                          dueAt: date ? new Date(date).toISOString() : null,
                        },
                      });
                      await load(token);
                      if (activity?.inquiryId === r.id) {
                        setActivity({
                          inquiryId: r.id,
                          events: await api<Activity[]>(
                            "/staff/inquiries/" + r.id + "/activity",
                            { token },
                          ),
                        });
                      }
                      setNotice("Follow-up saved.");
                    });
                  }}
                >
                  <label>
                    Assigned to{" "}
                    <input
                      name="owner"
                      maxLength={100}
                      defaultValue={r.owner || ""}
                      placeholder="Team or staff member"
                    />
                  </label>
                  <label>
                    Follow-up due{" "}
                    <input
                      name="dueAt"
                      type="datetime-local"
                      defaultValue={localDate(r.follow_up_at)}
                    />
                  </label>
                  <button>Save follow-up</button>
                </form>
                <button
                  className="activity-toggle"
                  aria-expanded={activity?.inquiryId === r.id}
                  onClick={() => {
                    if (activity?.inquiryId === r.id) {
                      setActivity(null);
                      return;
                    }
                    void perform(async () =>
                      setActivity({
                        inquiryId: r.id,
                        events: await api<Activity[]>(
                          "/staff/inquiries/" + r.id + "/activity",
                          { token },
                        ),
                      }),
                    );
                  }}
                >
                  {activity?.inquiryId === r.id
                    ? "Hide activity"
                    : "Show activity"}
                </button>
                {activity?.inquiryId === r.id && (
                  <ol
                    className="activity"
                    aria-label={"Activity for " + r.name}
                  >
                    {activity.events.map((ev) => (
                      <li key={ev.id}>
                        {ev.kind === "received"
                          ? "Inquiry received"
                          : ev.kind === "stage"
                            ? "Stage set to " + labels[ev.details.stage || ""]
                            : (ev.details.owner
                                ? "Assigned to " + ev.details.owner
                                : "Assignment cleared") +
                              (ev.details.dueAt
                                ? " · Due " +
                                  new Date(ev.details.dueAt).toLocaleString()
                                : " · No due date")}
                        <small>
                          {new Date(ev.created_at).toLocaleString()}
                        </small>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div className="inquiry-actions">
                <label>
                  Stage for {r.name}
                  <select
                    value={r.stage}
                    onChange={(e) => {
                      const stage = e.target.value;
                      void perform(async () => {
                        await api("/staff/inquiries/" + r.id, {
                          method: "PATCH",
                          token,
                          body: { stage },
                        });
                        await load(token);
                        if (activity?.inquiryId === r.id) {
                          setActivity({
                            inquiryId: r.id,
                            events: await api<Activity[]>(
                              "/staff/inquiries/" + r.id + "/activity",
                              { token },
                            ),
                          });
                        }
                        setNotice("Stage saved.");
                      });
                    }}
                  >
                    {["new", "contacted", "closed"].map((s) => (
                      <option key={s} value={s}>
                        {labels[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="badge">CRM: {labels[r.crm_status]}</span>
                {r.last_error && <small>{r.last_error}</small>}
                {["retry", "failed"].includes(r.crm_status) && (
                  <button
                    onClick={() =>
                      void perform(async () => {
                        await api("/staff/inquiries/" + r.id + "/retry", {
                          method: "POST",
                          token,
                        });
                        await load(token);
                        setNotice("Retry queued.");
                      })
                    }
                  >
                    Retry CRM sync
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      {tab === "campaigns" && (
        <section className="panel">
          <h2>Inquiry submissions by campaign</h2>
          <p>Counts submitted inquiries by property and UTM tags.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Source</th>
                  <th>Campaign</th>
                  <th>Inquiries</th>
                </tr>
              </thead>
              <tbody>
                {conversions.map((r) => (
                  <tr
                    key={JSON.stringify([
                      r.property_slug,
                      r.source,
                      r.campaign,
                    ])}
                  >
                    <td>{names[r.property_slug] || r.property_slug}</td>
                    <td>{r.source}</td>
                    <td>{r.campaign}</td>
                    <td>{r.submissions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!conversions.length && <p>No submissions yet.</p>}
        </section>
      )}
      {tab === "content" && (
        <div className="cards edit">
          {copies.map((r) => (
            <section className="panel" key={JSON.stringify(r)}>
              <h2>{names[r.slug] || r.slug}</h2>
              <p>{r.draft_headline ? "Unpublished draft" : "Published copy"}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void perform(async () => {
                    await api("/staff/content/" + r.slug, {
                      method: "PUT",
                      token,
                      body: {
                        headline: d.get("headline"),
                        blurb: d.get("blurb"),
                      },
                    });
                    await load(token);
                    setNotice("Draft saved. The public page is unchanged.");
                  });
                }}
              >
                <label>
                  Headline
                  <input
                    name="headline"
                    defaultValue={r.draft_headline ?? r.headline}
                    required
                    maxLength={100}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    name="blurb"
                    defaultValue={r.draft_blurb ?? r.blurb}
                    required
                    maxLength={600}
                  />
                </label>
                <div className="toolbar">
                  <button>Save draft</button>
                  <button
                    className="primary"
                    type="button"
                    disabled={!r.draft_headline}
                    onClick={() =>
                      void perform(async () => {
                        await api("/staff/content/" + r.slug + "/publish", {
                          method: "POST",
                          token,
                        });
                        await load(token);
                        reload();
                        setNotice("Published to the property page.");
                      })
                    }
                  >
                    Publish
                  </button>
                </div>
              </form>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
function localDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function App() {
  const [view, setView] = useState("properties"),
    [properties, setProperties] = useState<Property[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  function reload() {
    void api<Property[]>("/properties")
      .then((data) => {
        setProperties(data);
        setError("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    reload();
  }, []);
  return (
    <>
      <header>
        <strong>Property Inquiry Hub</strong>
        <nav aria-label="Main navigation">
          <button
            aria-pressed={view === "properties"}
            onClick={() => setView("properties")}
          >
            Properties
          </button>
          <button
            aria-pressed={view === "staff"}
            onClick={() => setView("staff")}
          >
            Staff
          </button>
        </nav>
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <p role="status">Loading properties…</p>
        ) : view === "properties" ? (
          <Public properties={properties} reload={reload} />
        ) : (
          <Staff properties={properties} reload={reload} />
        )}
      </main>
      <footer>
        Portfolio demo · All properties and inquiries are fictional.
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

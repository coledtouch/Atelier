// Connected-account tools. Each tool is described in OpenAI function format (so any provider can
// call it) plus `x-write` (needs the user's approval in the app) and `x-label` (shown in the UI).
// Tokens live in Worker secrets (primary accounts) and KV (extra accounts added in the app);
// Google (Gmail, Calendar, Drive, Photos) and Canva use per-account OAuth refresh tokens kept in KV.
import { waitUntil } from 'cloudflare:workers';

class ToolError extends Error {}

async function callJson(url, init, label) {
  const r = await fetch(url, init);
  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 500) }; }
  if (!r.ok) throw new ToolError(`${label} ${r.status}: ${j.message || j.error?.message || j.error_description || j.error || j.errors?.[0]?.message || text.slice(0, 200)}`);
  return j;
}
const clip = (s, n = 400) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const S = (desc, extra = {}) => ({ type: 'string', description: desc, ...extra });
const N = (desc) => ({ type: 'integer', description: desc });
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

// ───────────────────────── token accounts (GitHub, Cloudflare) ─────────────────────────
// Primary account = the Worker secret; extra accounts are added in the app and stored in KV.
const PRIMARY_SECRET = { github: 'GITHUB_TOKEN', cloudflare: 'CLOUDFLARE_API_TOKEN' };
const IDENTIFY = {
  github: async (token) => (await callJson('https://api.github.com/user', { headers: ghHeaders(token) }, 'GitHub')).login,
  cloudflare: async (token) => {
    const v = await callJson('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${token}` } }, 'Cloudflare');
    if (v.result?.status !== 'active') throw new ToolError('That Cloudflare token is not active.');
    const accts = await callJson('https://api.cloudflare.com/client/v4/accounts?per_page=5', { headers: { authorization: `Bearer ${token}` } }, 'Cloudflare').catch(() => ({ result: [] }));
    if (accts.result?.[0]?.name) return accts.result[0].name;
    // Zone-scoped tokens can't list accounts, but each zone names its account.
    const zones = await callJson('https://api.cloudflare.com/client/v4/zones?per_page=1', { headers: { authorization: `Bearer ${token}` } }, 'Cloudflare').catch(() => ({ result: [] }));
    return zones.result?.[0]?.account?.name || zones.result?.[0]?.name || `token …${token.slice(-4)}`;
  },
};
export async function tokenAccounts(env, svc) {
  const out = [];
  const primary = env[PRIMARY_SECRET[svc]];
  if (primary) {
    let label = await env.ATELIER_KV.get(`label:${svc}:primary`);
    if (!label) {
      label = await IDENTIFY[svc](primary).catch(() => 'main');
      await env.ATELIER_KV.put(`label:${svc}:primary`, label, { expirationTtl: 86400 });
    }
    out.push({ id: 'primary', label, token: primary, source: 'secret' });
  }
  const extra = (await env.ATELIER_KV.get(`accounts:${svc}`, 'json')) || [];
  // Retry naming accounts that were saved with a placeholder label.
  const unnamed = extra.filter((a) => a.label.startsWith('token …'));
  if (unnamed.length) {
    for (const a of unnamed) a.label = await IDENTIFY[svc](a.token).catch(() => a.label);
    if (unnamed.some((a) => !a.label.startsWith('token …'))) await env.ATELIER_KV.put(`accounts:${svc}`, JSON.stringify(extra));
  }
  for (const a of extra) out.push({ ...a, source: 'app' });
  return out;
}
export async function addTokenAccount(env, svc, token) {
  if (!PRIMARY_SECRET[svc]) throw new ToolError('Unknown service');
  token = String(token || '').trim();
  if (token.length < 20) throw new ToolError('That doesn’t look like a token.');
  const label = await IDENTIFY[svc](token);
  const list = ((await env.ATELIER_KV.get(`accounts:${svc}`, 'json')) || []).filter((a) => a.label !== label);
  list.push({ id: crypto.randomUUID().slice(0, 8), label, token });
  await env.ATELIER_KV.put(`accounts:${svc}`, JSON.stringify(list));
  return label;
}
export async function removeTokenAccount(env, svc, id) {
  const list = ((await env.ATELIER_KV.get(`accounts:${svc}`, 'json')) || []).filter((a) => a.id !== id);
  await env.ATELIER_KV.put(`accounts:${svc}`, JSON.stringify(list));
  return list.length;
}
// The account(s) a call should use: the named one, or all of them.
async function chooseAccounts(env, svc, wanted, name) {
  const all = await tokenAccounts(env, svc);
  if (!all.length) throw new ToolError(`${name} is not connected.`);
  if (!wanted) return all;
  const w = String(wanted).toLowerCase();
  const hit = all.filter((a) => a.label.toLowerCase() === w || a.label.toLowerCase().includes(w));
  if (!hit.length) throw new ToolError(`No connected ${name} account matches "${wanted}". Connected: ${all.map((a) => a.label).join(', ')}`);
  return hit;
}
// Run fn for each account and merge the results (tagged with the account); errors from single accounts are tolerated.
async function acrossAccounts(accounts, fn) {
  const res = await Promise.allSettled(accounts.map(async (acct) => (await fn(acct)).map((r) => ({ account: acct.label, ...r }))));
  const ok = res.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  if (!ok.length && res.some((r) => r.status === 'rejected')) throw res.find((r) => r.status === 'rejected').reason;
  return ok;
}
// First account for which fn succeeds (e.g. the one that can see a repo or owns a zone).
async function firstWorking(accounts, fn) {
  let last;
  for (const acct of accounts) {
    try { return { account: acct.label, ...(await fn(acct)) }; } catch (err) { last = err; }
  }
  throw last;
}
const ACCT = (what) => S(`Which connected ${what} account to use (omit to use all / whichever has access)`);

// ───────────────────────── GitHub ─────────────────────────
function ghHeaders(token, body) {
  return {
    authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'atelier-assistant',
    ...(body ? { 'content-type': 'application/json' } : {}),
  };
}
const github = {
  ready: async (env) => (await tokenAccounts(env, 'github')).length > 0,
  api: (acct, path, init = {}) => callJson(`https://api.github.com${path}`, { ...init, headers: ghHeaders(acct.token, init.body) }, `GitHub (${acct.label})`),
  tools: {
    github_repos: {
      label: 'List my GitHub repos', desc: 'List the user\'s GitHub repositories across their connected accounts, most recently pushed first.',
      params: obj({ limit: N('Max repos per account (default 20)'), account: ACCT('GitHub') }),
      run: async (env, a) => acrossAccounts(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) =>
        (await github.api(acct, `/user/repos?sort=pushed&per_page=${Math.min(a.limit || 20, 50)}`))
          .map((r) => ({ repo: r.full_name, private: r.private, description: clip(r.description, 160), pushed: r.pushed_at, open_issues: r.open_issues_count, url: r.html_url }))),
    },
    github_search: {
      label: 'Search GitHub', desc: 'Search GitHub. type=repositories|issues|code. GitHub search syntax, e.g. "is:pr is:open author:@me" or "repo:owner/name bug". Runs for every connected account unless one is named.',
      params: obj({ query: S('Search query'), type: S('repositories, issues (also PRs) or code', { enum: ['repositories', 'issues', 'code'] }), account: ACCT('GitHub') }, ['query', 'type']),
      run: async (env, a) => {
        const results = await acrossAccounts(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) => {
          const q = a.query.replace(/@me\b/g, acct.label);
          const j = await github.api(acct, `/search/${a.type}?q=${encodeURIComponent(q)}&per_page=10`);
          return (j.items || []).map((i) => a.type === 'code'
            ? { repo: i.repository?.full_name, path: i.path, url: i.html_url }
            : a.type === 'issues'
              ? { repo: i.repository_url?.split('/repos/')[1], number: i.number, title: i.title, state: i.state, is_pr: Boolean(i.pull_request), updated: i.updated_at, url: i.html_url }
              : { repo: i.full_name, description: clip(i.description, 160), stars: i.stargazers_count, url: i.html_url });
        });
        const seen = new Set();
        return results.filter((r) => !seen.has(r.url) && seen.add(r.url)); // same public result via two accounts → once
      },
    },
    github_issues: {
      label: 'List issues / PRs', desc: 'List issues or pull requests in a repo (uses whichever connected account can see it).',
      params: obj({ repo: S('owner/name'), kind: S('issues or pulls', { enum: ['issues', 'pulls'] }), state: S('open, closed or all', { enum: ['open', 'closed', 'all'] }), account: ACCT('GitHub') }, ['repo']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) => {
        const kind = a.kind === 'pulls' ? 'pulls' : 'issues';
        const list = await github.api(acct, `/repos/${a.repo}/${kind}?state=${a.state || 'open'}&per_page=25`);
        return { items: list.filter((i) => kind === 'pulls' || !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login, updated: i.updated_at, url: i.html_url })) };
      }),
    },
    github_read: {
      label: 'Read a GitHub file', desc: 'Read a file (or list a directory) in a repo (uses whichever connected account can see it).',
      params: obj({ repo: S('owner/name'), path: S('File or directory path ("" for root)'), ref: S('Branch/tag/sha (optional)'), account: ACCT('GitHub') }, ['repo', 'path']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) => {
        const j = await github.api(acct, `/repos/${a.repo}/contents/${a.path.replace(/^\//, '')}${a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ''}`);
        if (Array.isArray(j)) return { entries: j.map((f) => ({ name: f.name, type: f.type, path: f.path })) };
        const bytes = Uint8Array.from(atob((j.content || '').replace(/\n/g, '')), (c) => c.charCodeAt(0));
        return { path: j.path, size: j.size, url: j.html_url, content: clip(new TextDecoder().decode(bytes), 20000) };
      }),
    },
    github_notifications: {
      label: 'GitHub notifications', desc: 'Unread GitHub notifications (review requests, mentions, CI) across connected accounts.',
      params: obj({ account: ACCT('GitHub') }),
      run: async (env, a) => acrossAccounts(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) =>
        (await github.api(acct, '/notifications?per_page=25')).map((n) => ({ repo: n.repository?.full_name, type: n.subject?.type, title: n.subject?.title, reason: n.reason, updated: n.updated_at }))),
    },
    github_create_issue: {
      write: true, label: 'Create GitHub issue', desc: 'Open a new issue in a repo. `account` = which GitHub account files it (default: the first that can access the repo).',
      params: obj({ repo: S('owner/name'), title: S('Issue title'), body: S('Issue body (Markdown)'), account: ACCT('GitHub') }, ['repo', 'title']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) => {
        const i = await github.api(acct, `/repos/${a.repo}/issues`, { method: 'POST', body: JSON.stringify({ title: a.title, body: a.body || '' }) });
        return { number: i.number, url: i.html_url };
      }),
    },
    github_comment: {
      write: true, label: 'Comment on GitHub', desc: 'Comment on an issue or pull request. `account` = which GitHub account posts it.',
      params: obj({ repo: S('owner/name'), number: N('Issue or PR number'), body: S('Comment (Markdown)'), account: ACCT('GitHub') }, ['repo', 'number', 'body']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'github', a.account, 'GitHub'), async (acct) => {
        const c = await github.api(acct, `/repos/${a.repo}/issues/${a.number}/comments`, { method: 'POST', body: JSON.stringify({ body: a.body }) });
        return { url: c.html_url };
      }),
    },
  },
};

// ───────────────────────── Stripe ─────────────────────────
const money = (amt, cur) => `${(amt / 100).toFixed(2)} ${String(cur || '').toUpperCase()}`;
const stripe = {
  ready: (env) => Boolean(env.STRIPE_API_KEY),
  api: (env, path, form) =>
    callJson(`https://api.stripe.com/v1${path}`, {
      method: form ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${env.STRIPE_API_KEY}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    }, 'Stripe'),
  tools: {
    stripe_balance: {
      label: 'Stripe balance', desc: 'Current Stripe balance (available and pending).', params: obj({}),
      run: async (env) => { const b = await stripe.api(env, '/balance'); return { available: b.available.map((x) => money(x.amount, x.currency)), pending: b.pending.map((x) => money(x.amount, x.currency)) }; },
    },
    stripe_payments: {
      label: 'Recent payments', desc: 'Most recent payments (payment intents).', params: obj({ limit: N('Max results (default 15)') }),
      run: async (env, a) => (await stripe.api(env, `/payment_intents?limit=${Math.min(a.limit || 15, 50)}`)).data
        .map((p) => ({ id: p.id, amount: money(p.amount, p.currency), status: p.status, customer: p.customer, description: clip(p.description, 120), created: new Date(p.created * 1000).toISOString() })),
    },
    stripe_customers: {
      label: 'Find Stripe customers', desc: 'Find customers by email or name.', params: obj({ query: S('Email address or name') }, ['query']),
      run: async (env, a) => {
        const q = a.query.includes('@') ? `email:'${a.query.replace(/'/g, '')}'` : `name~'${a.query.replace(/'/g, '')}'`;
        return (await stripe.api(env, `/customers/search?query=${encodeURIComponent(q)}&limit=10`)).data
          .map((c) => ({ id: c.id, name: c.name, email: c.email, created: new Date(c.created * 1000).toISOString() }));
      },
    },
    stripe_subscriptions: {
      label: 'Stripe subscriptions', desc: 'List subscriptions.', params: obj({ status: S('active, past_due, canceled, trialing or all') }),
      run: async (env, a) => (await stripe.api(env, `/subscriptions?limit=25&status=${a.status || 'all'}`)).data
        .map((s) => ({ id: s.id, customer: s.customer, status: s.status, amount: s.items?.data?.[0]?.price ? money(s.items.data[0].price.unit_amount, s.items.data[0].price.currency) + '/' + s.items.data[0].price.recurring?.interval : null, renews: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null })),
    },
    stripe_invoices: {
      label: 'Stripe invoices', desc: 'List invoices, optionally for one customer or status.', params: obj({ customer: S('Customer id (optional)'), status: S('draft, open, paid, uncollectible or void (optional)') }),
      run: async (env, a) => (await stripe.api(env, `/invoices?limit=20${a.customer ? `&customer=${a.customer}` : ''}${a.status ? `&status=${a.status}` : ''}`)).data
        .map((i) => ({ id: i.id, customer: i.customer_email || i.customer, total: money(i.total, i.currency), status: i.status, due: i.due_date ? new Date(i.due_date * 1000).toISOString() : null, url: i.hosted_invoice_url })),
    },
    stripe_refund: {
      write: true, label: 'Refund a payment', desc: 'Refund a payment intent, fully or partially. Amount is in cents; omit for a full refund.',
      params: obj({ payment_intent: S('Payment intent id (pi_…)'), amount_cents: N('Partial amount in cents (optional)'), reason: S('duplicate, fraudulent or requested_by_customer', { enum: ['duplicate', 'fraudulent', 'requested_by_customer'] }) }, ['payment_intent']),
      run: async (env, a) => {
        const r = await stripe.api(env, '/refunds', { payment_intent: a.payment_intent, ...(a.amount_cents ? { amount: String(a.amount_cents) } : {}), ...(a.reason ? { reason: a.reason } : {}) });
        return { id: r.id, amount: money(r.amount, r.currency), status: r.status };
      },
    },
  },
};

// ───────────────────────── Cloudflare ─────────────────────────
const cloudflare = {
  ready: async (env) => (await tokenAccounts(env, 'cloudflare')).length > 0,
  api: async (acct, path, init = {}) => {
    const j = await callJson(`https://api.cloudflare.com/client/v4${path}`, {
      ...init, headers: { authorization: `Bearer ${acct.token}`, 'content-type': 'application/json' },
    }, `Cloudflare (${acct.label})`);
    return j.result;
  },
  zoneId: async (acct, zone) => {
    const z = (await cloudflare.api(acct, `/zones?name=${encodeURIComponent(zone)}`))[0];
    if (!z) throw new ToolError(`No zone named ${zone} in ${acct.label}`);
    return z.id;
  },
  accountId: async (acct) => (await cloudflare.api(acct, '/accounts'))[0]?.id,
  tools: {
    cf_zones: {
      label: 'Cloudflare zones', desc: 'List the domains (zones) across all connected Cloudflare accounts.', params: obj({ account: ACCT('Cloudflare') }),
      run: async (env, a) => acrossAccounts(await chooseAccounts(env, 'cloudflare', a.account, 'Cloudflare'), async (acct) =>
        (await cloudflare.api(acct, '/zones?per_page=50')).map((z) => ({ zone: z.name, status: z.status, plan: z.plan?.name }))),
    },
    cf_dns_records: {
      label: 'List DNS records', desc: 'List DNS records for a zone (finds the account that owns it).', params: obj({ zone: S('Domain, e.g. example.com'), account: ACCT('Cloudflare') }, ['zone']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'cloudflare', a.account, 'Cloudflare'), async (acct) => ({
        records: (await cloudflare.api(acct, `/zones/${await cloudflare.zoneId(acct, a.zone)}/dns_records?per_page=100`))
          .map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied })),
      })),
    },
    cf_workers: {
      label: 'List Workers', desc: 'List Cloudflare Workers scripts across connected accounts.', params: obj({ account: ACCT('Cloudflare') }),
      run: async (env, a) => acrossAccounts(await chooseAccounts(env, 'cloudflare', a.account, 'Cloudflare'), async (acct) => {
        const id = acct.id === 'primary' && env.CLOUDFLARE_ACCOUNT_ID ? env.CLOUDFLARE_ACCOUNT_ID : await cloudflare.accountId(acct);
        return (await cloudflare.api(acct, `/accounts/${id}/workers/scripts`)).map((w) => ({ name: w.id, modified: w.modified_on }));
      }),
    },
    cf_dns_create: {
      write: true, label: 'Add DNS record', desc: 'Create a DNS record (in the account that owns the zone).',
      params: obj({ zone: S('Domain'), type: S('A, AAAA, CNAME, TXT, MX…'), name: S('Record name (e.g. www or @)'), content: S('Record value'), proxied: { type: 'boolean', description: 'Proxy through Cloudflare' }, account: ACCT('Cloudflare') }, ['zone', 'type', 'name', 'content']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'cloudflare', a.account, 'Cloudflare'), async (acct) => {
        const r = await cloudflare.api(acct, `/zones/${await cloudflare.zoneId(acct, a.zone)}/dns_records`, { method: 'POST', body: JSON.stringify({ type: a.type, name: a.name, content: a.content, proxied: Boolean(a.proxied), ttl: 1 }) });
        return { id: r.id, name: r.name, type: r.type };
      }),
    },
    cf_purge_cache: {
      write: true, label: 'Purge Cloudflare cache', desc: 'Purge a zone\'s cache — everything, or specific URLs.',
      params: obj({ zone: S('Domain'), urls: { type: 'array', items: { type: 'string' }, description: 'URLs to purge (omit to purge everything)' }, account: ACCT('Cloudflare') }, ['zone']),
      run: async (env, a) => firstWorking(await chooseAccounts(env, 'cloudflare', a.account, 'Cloudflare'), async (acct) => {
        await cloudflare.api(acct, `/zones/${await cloudflare.zoneId(acct, a.zone)}/purge_cache`, { method: 'POST', body: JSON.stringify(a.urls?.length ? { files: a.urls } : { purge_everything: true }) });
        return { purged: a.urls?.length ? a.urls : 'everything' };
      }),
    },
  },
};

// ───────────────────────── Railway ─────────────────────────
const railway = {
  ready: (env) => Boolean(env.RAILWAY_API_TOKEN),
  gql: async (env, query, variables = {}) => {
    const call = () => callJson('https://backboard.railway.com/graphql/v2', {
      method: 'POST', headers: { authorization: `Bearer ${env.RAILWAY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }, 'Railway');
    // Railway's edge drops connections now and then (502/503/504) — retry reads a couple of times.
    let j;
    for (let attempt = 0; ; attempt++) {
      try { j = await call(); break; } catch (err) {
        if (attempt >= 4 || /^mutation/.test(query.trim()) || !/ 50[234]:/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (j.errors?.length) throw new ToolError(`Railway: ${j.errors[0].message}`);
    return j.data;
  },
  tools: {
    railway_projects: {
      label: 'Railway projects', desc: 'List Railway projects with their services and environments.', params: obj({}),
      run: async (env) => (await railway.gql(env, `query { projects { edges { node { id name updatedAt
          services { edges { node { id name } } } environments { edges { node { id name } } } } } } }`))
        .projects.edges.map(({ node: p }) => ({ id: p.id, name: p.name, updated: p.updatedAt, services: p.services.edges.map((s) => ({ id: s.node.id, name: s.node.name })), environments: p.environments.edges.map((x) => ({ id: x.node.id, name: x.node.name })) })),
    },
    railway_deployments: {
      label: 'Railway deployments', desc: 'Recent deployments for a project (optionally one service).',
      params: obj({ projectId: S('Project id'), serviceId: S('Service id (optional)') }, ['projectId']),
      run: async (env, a) => (await railway.gql(env, `query($input: DeploymentListInput!) { deployments(first: 8, input: $input) { edges { node { id status createdAt staticUrl serviceId } } } }`,
        { input: { projectId: a.projectId, ...(a.serviceId ? { serviceId: a.serviceId } : {}) } }))
        .deployments.edges.map(({ node: d }) => ({ id: d.id, status: d.status, created: d.createdAt, url: d.staticUrl ? `https://${d.staticUrl}` : null, serviceId: d.serviceId })),
    },
    railway_redeploy: {
      write: true, label: 'Redeploy on Railway', desc: 'Redeploy an existing deployment.', params: obj({ deploymentId: S('Deployment id') }, ['deploymentId']),
      run: async (env, a) => (await railway.gql(env, 'mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }', { id: a.deploymentId })).deploymentRedeploy,
    },
  },
};

// ───────────────────────── Slack ─────────────────────────
const slack = {
  ready: (env) => Boolean(env.SLACK_USER_TOKEN),
  api: async (env, method, params = {}, post = false) => {
    const qs = new URLSearchParams(params).toString();
    const j = await callJson(`https://slack.com/api/${method}${post ? '' : `?${qs}`}`, {
      method: post ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${env.SLACK_USER_TOKEN}`, ...(post ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
      body: post ? JSON.stringify(params) : undefined,
    }, 'Slack');
    if (!j.ok) throw new ToolError(`Slack: ${j.error}`);
    return j;
  },
  tools: {
    slack_search: {
      label: 'Search Slack', desc: 'Search Slack messages (Slack search syntax: from:@name in:#channel after:2026-09-01).',
      params: obj({ query: S('Search query') }, ['query']),
      run: async (env, a) => (await slack.api(env, 'search.messages', { query: a.query, count: 15, sort: 'timestamp' })).messages.matches
        .map((m) => ({ channel: m.channel?.name, channel_id: m.channel?.id, from: m.username, text: clip(m.text, 500), ts: m.ts, url: m.permalink })),
    },
    slack_channels: {
      label: 'Slack channels', desc: 'List Slack channels and DMs the user is in.', params: obj({}),
      run: async (env) => (await slack.api(env, 'users.conversations', { types: 'public_channel,private_channel,im,mpim', limit: 200, exclude_archived: true })).channels
        .map((c) => ({ id: c.id, name: c.name || (c.is_im ? `DM ${c.user}` : c.id) })),
    },
    slack_history: {
      label: 'Read Slack channel', desc: 'Recent messages in a channel or DM.', params: obj({ channel: S('Channel id'), limit: N('Messages (default 20)') }, ['channel']),
      run: async (env, a) => (await slack.api(env, 'conversations.history', { channel: a.channel, limit: Math.min(a.limit || 20, 50) })).messages
        .map((m) => ({ user: m.user, text: clip(m.text, 600), ts: m.ts, thread_ts: m.thread_ts })),
    },
    slack_post: {
      write: true, label: 'Post to Slack', desc: 'Post a message as the user to a channel or DM (optionally in a thread).',
      params: obj({ channel: S('Channel id'), text: S('Message text (Slack mrkdwn)'), thread_ts: S('Reply in this thread (optional)') }, ['channel', 'text']),
      run: async (env, a) => { const j = await slack.api(env, 'chat.postMessage', { channel: a.channel, text: a.text, ...(a.thread_ts ? { thread_ts: a.thread_ts } : {}) }, true); return { ok: true, ts: j.ts, channel: j.channel }; },
    },
  },
};

// ───────────────────────── Gmail (OAuth) ─────────────────────────
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
].join(' ');

// Connected Gmail accounts live in KV as [{ email, refresh }]; access tokens are cached per address.
async function googleAccounts(env) {
  const list = (await env.ATELIER_KV.get('google_accounts', 'json')) || [];
  // One-time upgrade from the single-account format.
  const legacy = await env.ATELIER_KV.get('google_refresh');
  if (legacy) {
    try {
      const access = await exchangeRefresh(env, legacy);
      const email = await gmailProfileEmail(access.access_token);
      if (!list.some((a) => a.email === email)) list.push({ email, refresh: legacy });
      await env.ATELIER_KV.put('google_accounts', JSON.stringify(list));
    } catch {}
    await env.ATELIER_KV.delete('google_refresh');
    await env.ATELIER_KV.delete('google_access');
  }
  return list;
}
async function exchangeRefresh(env, refresh) {
  return callJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
  }, 'Google');
}
async function gmailProfileEmail(accessToken) {
  const p = await callJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` } }, 'Gmail');
  return String(p.emailAddress || '').toLowerCase();
}
// Called by the OAuth callback: store (or replace) the account the user just approved.
export async function saveGoogleAccount(env, refresh, accessToken, scope = '') {
  const email = await gmailProfileEmail(accessToken);
  const list = (await googleAccounts(env)).filter((a) => a.email !== email);
  list.push({ email, refresh, scope });
  await env.ATELIER_KV.put('google_accounts', JSON.stringify(list));
  await env.ATELIER_KV.delete(`google_access:${email}`);
  return email;
}
export async function removeGoogleAccount(env, email) {
  const list = await googleAccounts(env);
  const keep = email ? list.filter((a) => a.email !== String(email).toLowerCase()) : [];
  for (const a of list) if (!keep.includes(a)) await env.ATELIER_KV.delete(`google_access:${a.email}`);
  await env.ATELIER_KV.put('google_accounts', JSON.stringify(keep));
  return keep.map((a) => a.email);
}
// Google access token for an account, for routes outside the tool runner (Photos picker).
export async function googleTokenFor(env, wanted) {
  const acct = await pickAccount(env, wanted);
  return { email: acct.email, token: await googleAccessToken(env, acct) };
}
export async function googleAccountList(env) { return (await googleAccounts(env)).map((a) => ({ email: a.email, scope: a.scope || '' })); }
const needsScope = (acct, scope, what) => {
  if (acct.scope && !acct.scope.includes(scope)) throw new ToolError(`${acct.email} hasn’t granted ${what} access yet — in Settings → Connections tap “+ Add account” and pick ${acct.email} again to allow it.`);
};
async function pickAccount(env, wanted) {
  const list = await googleAccounts(env);
  if (!list.length) throw new ToolError('Gmail is not connected — use Settings → Connections → Connect Gmail.');
  if (!wanted) return list[0];
  const w = String(wanted).toLowerCase().trim();
  const hit = list.find((a) => a.email === w) || list.find((a) => a.email.includes(w));
  if (!hit) throw new ToolError(`No connected Gmail account matches "${wanted}". Connected: ${list.map((a) => a.email).join(', ')}`);
  return hit;
}
async function googleAccessToken(env, account) {
  const key = `google_access:${account.email}`;
  const cached = await env.ATELIER_KV.get(key, 'json');
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const j = await exchangeRefresh(env, account.refresh);
  await env.ATELIER_KV.put(key, JSON.stringify({ token: j.access_token, exp: Date.now() + j.expires_in * 1000 }));
  // Keep a record of what this account actually granted (refresh responses carry the scope list).
  if (j.scope && j.scope !== account.scope) {
    account.scope = j.scope;
    const list = await googleAccounts(env);
    const hit = list.find((a) => a.email === account.email);
    if (hit) { hit.scope = j.scope; await env.ATELIER_KV.put('google_accounts', JSON.stringify(list)); }
  }
  return j.access_token;
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
function rfc822({ to, cc, subject, body, inReplyTo }) {
  const enc = (t) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(t)))}?=`;
  const lines = [`To: ${to}`, cc ? `Cc: ${cc}` : '', `Subject: ${enc(subject || '')}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '', inReplyTo ? `References: ${inReplyTo}` : '', '', body || ''].filter((l, i, a) => l !== '' || i === a.length - 2);
  return b64url(new TextEncoder().encode(lines.join('\r\n')));
}
function plainBody(payload) {
  const walk = (p) => {
    if (p.mimeType === 'text/plain' && p.body?.data) return fromB64url(p.body.data);
    for (const part of p.parts || []) { const t = walk(part); if (t) return t; }
    return '';
  };
  let t = walk(payload);
  if (!t) {
    const html = (function find(p) { if (p.mimeType === 'text/html' && p.body?.data) return fromB64url(p.body.data); for (const x of p.parts || []) { const h = find(x); if (h) return h; } return ''; })(payload);
    t = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
const ACCOUNT = S('Which connected Gmail address to use (omit for the default; searches cover all accounts)');
const gmail = {
  ready: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  api: async (env, account, path, init = {}) => {
    try {
      return await callJson(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
        ...init, headers: { authorization: `Bearer ${await googleAccessToken(env, account)}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      }, `Gmail (${account.email})`);
    } catch (err) {
      // Google answers 400 "Precondition check failed" for accounts with no Gmail mailbox: a Google account made
      // with a non-Gmail address, or a Workspace user with Gmail switched off. Calendar/Drive still work for them.
      if (/ 400: .*precondition check failed/i.test(err.message)) throw new ToolError(`${account.email} has no Gmail mailbox (a Google account without Gmail, or Gmail is turned off for it in Google Workspace). Its Calendar and Drive still work.`);
      if (/ 403: .*(insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT)/i.test(err.message)) throw new ToolError(`${account.email} hasn’t granted Gmail access — in Settings → Connections tap “+ Add account”, pick ${account.email} again and tick every box.`);
      throw err;
    }
  },
  header: (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value,
  tools: {
    gmail_search: {
      label: 'Search Gmail', desc: 'Search the user\'s Gmail with Gmail query syntax (e.g. "is:unread newer_than:2d", "from:alex subject:invoice"). Without `account` it searches every connected inbox; each message says which account it came from. Returns { messages, skipped } — `skipped` lists inboxes that couldn\'t be searched and why (don\'t retry those).',
      params: obj({ query: S('Gmail search query'), max: N('Max messages per account (default 10)'), account: ACCOUNT }, ['query']),
      run: async (env, a) => {
        const accounts = a.account ? [await pickAccount(env, a.account)] : await googleAccounts(env);
        if (!accounts.length) throw new ToolError('Gmail is not connected — use Settings → Connections → Connect Gmail.');
        // One inbox failing (e.g. an account with no Gmail) must not sink the search of the others.
        const settled = await Promise.allSettled(accounts.map(async (acct) => {
          const list = await gmail.api(env, acct, `/messages?q=${encodeURIComponent(a.query)}&maxResults=${Math.min(a.max || 10, 25)}`);
          return Promise.all((list.messages || []).map(async ({ id }) => {
            const m = await gmail.api(env, acct, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
            return { account: acct.email, id, threadId: m.threadId, from: gmail.header(m, 'From'), subject: gmail.header(m, 'Subject'), date: gmail.header(m, 'Date'), snippet: clip(m.snippet, 200), unread: m.labelIds?.includes('UNREAD'), _t: Number(m.internalDate) || 0 };
          }));
        }));
        const skipped = settled.map((r, i) => r.status === 'rejected' && { account: accounts[i].email, reason: r.reason instanceof ToolError ? r.reason.message : clip(r.reason?.message, 300) }).filter(Boolean);
        if (skipped.length === accounts.length) throw settled[0].reason; // nothing searched: surface the (first) real error
        const messages = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((x, y) => y._t - x._t).map(({ _t, ...r }) => r);
        return skipped.length ? { messages, skipped } : { messages };
      },
    },
    gmail_read: {
      label: 'Read an email', desc: 'Read one email in full. Pass the `account` it came from (from gmail_search).',
      params: obj({ id: S('Message id'), account: ACCOUNT }, ['id']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        const m = await gmail.api(env, acct, `/messages/${a.id}?format=full`);
        return { account: acct.email, id: m.id, threadId: m.threadId, messageId: gmail.header(m, 'Message-ID'), from: gmail.header(m, 'From'), to: gmail.header(m, 'To'), cc: gmail.header(m, 'Cc'), subject: gmail.header(m, 'Subject'), date: gmail.header(m, 'Date'), body: clip(plainBody(m.payload), 15000) };
      },
    },
    gmail_draft: {
      label: 'Save Gmail draft', desc: 'Save an email as a draft in Gmail (does not send). For replies use the account the original came from, and pass threadId and in_reply_to (the original Message-ID).',
      params: obj({ account: ACCOUNT, to: S('Recipient(s)'), cc: S('Cc (optional)'), subject: S('Subject'), body: S('Plain-text body'), threadId: S('Thread id for replies (optional)'), in_reply_to: S('Original Message-ID for replies (optional)') }, ['to', 'subject', 'body']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        const d = await gmail.api(env, acct, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: rfc822({ ...a, inReplyTo: a.in_reply_to }), ...(a.threadId ? { threadId: a.threadId } : {}) } }) });
        return { account: acct.email, draftId: d.id, saved: true };
      },
    },
    gmail_send: {
      write: true, label: 'Send email', desc: 'Send an email from one of the user\'s Gmail accounts. For replies use the account the original came from, and pass threadId and in_reply_to.',
      params: obj({ account: ACCOUNT, to: S('Recipient(s)'), cc: S('Cc (optional)'), subject: S('Subject'), body: S('Plain-text body'), threadId: S('Thread id for replies (optional)'), in_reply_to: S('Original Message-ID for replies (optional)') }, ['to', 'subject', 'body']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        const m = await gmail.api(env, acct, '/messages/send', { method: 'POST', body: JSON.stringify({ raw: rfc822({ ...a, inReplyTo: a.in_reply_to }), ...(a.threadId ? { threadId: a.threadId } : {}) }) });
        return { sent: true, from: acct.email, id: m.id };
      },
    },
  },
};

const gapi = async (env, acct, url, init = {}, label = 'Google') => {
  try {
    return await callJson(url, { ...init, headers: { authorization: `Bearer ${await googleAccessToken(env, acct)}`, ...(init.headers || {}), ...(init.body && !init.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}) } }, `${label} (${acct.email})`);
  } catch (err) {
    console.warn('google api error', acct.email, label, err.message.slice(0, 400));
    if (/ 403: .*(insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT)/i.test(err.message)) throw new ToolError(`${acct.email} hasn’t granted ${label} access — in Settings → Connections tap “+ Add account” and pick ${acct.email} again, and tick every box.`);
    if (/ 403: .*(has not been used|is disabled|not been enabled)/i.test(err.message)) throw new ToolError(`The ${label} API isn’t enabled in your Google Cloud project — enable it under APIs & Services → Library.`);
    throw err;
  }
};
const GACCT = S('Which connected Google account (email) to use (omit for all / the default)');
async function googleTargets(env, wanted) { return wanted ? [await pickAccount(env, wanted)] : await googleAccounts(env); }
const eventOut = (acct, e) => ({ account: acct.email, id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location, attendees: (e.attendees || []).slice(0, 12).map((x) => x.email), meet: e.hangoutLink, link: e.htmlLink, status: e.status });

// ───────────────────────── Google Calendar ─────────────────────────
const gcal = {
  ready: async (env) => gmail.ready(env) && (await googleAccounts(env)).length > 0,
  tools: {
    calendar_events: {
      label: 'Calendar events', desc: 'List events from the user\'s Google Calendars (primary calendar of each connected Google account unless one is named). Defaults to the next 7 days. Times are ISO 8601.',
      params: obj({ from: S('Start (ISO 8601, default now)'), to: S('End (ISO 8601, default +7 days)'), query: S('Free-text filter (optional)'), max: N('Max events per account (default 25)'), account: GACCT }),
      run: async (env, a) => {
        const from = a.from || new Date().toISOString();
        const to = a.to || new Date(Date.now() + 7 * 864e5).toISOString();
        const per = await Promise.allSettled((await googleTargets(env, a.account)).map(async (acct) => {
          needsScope(acct, 'calendar', 'Calendar');
          const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(a.max || 25, 100)), ...(a.query ? { q: a.query } : {}) });
          const j = await gapi(env, acct, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, {}, 'Calendar');
          return (j.items || []).map((e) => eventOut(acct, e));
        }));
        const ok = per.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
        if (!ok.length && per.some((r) => r.status === 'rejected')) throw per.find((r) => r.status === 'rejected').reason;
        return ok.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      },
    },
    calendar_create: {
      write: true, label: 'Create calendar event', desc: 'Create an event on a Google Calendar. Use ISO 8601 date-times with the user\'s UTC offset (or YYYY-MM-DD for all-day). Adding attendees emails them invitations.',
      params: obj({ account: GACCT, title: S('Event title'), start: S('Start (ISO 8601 or YYYY-MM-DD)'), end: S('End (ISO 8601 or YYYY-MM-DD)'), time_zone: S('IANA time zone, e.g. America/Chicago (optional)'), description: S('Notes (optional)'), location: S('Location (optional)'), attendees: { type: 'array', items: { type: 'string' }, description: 'Guest emails (optional)' }, meet: { type: 'boolean', description: 'Add a Google Meet link' } }, ['title', 'start', 'end']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        needsScope(acct, 'calendar', 'Calendar');
        const when = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, ...(a.time_zone ? { timeZone: a.time_zone } : {}) });
        const body = { summary: a.title, description: a.description, location: a.location, start: when(a.start), end: when(a.end),
          ...(a.attendees?.length ? { attendees: a.attendees.map((email) => ({ email })) } : {}),
          ...(a.meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}) };
        const q = `sendUpdates=${a.attendees?.length ? 'all' : 'none'}${a.meet ? '&conferenceDataVersion=1' : ''}`;
        return eventOut(acct, await gapi(env, acct, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { method: 'POST', body: JSON.stringify(body) }, 'Calendar'));
      },
    },
    calendar_delete: {
      write: true, label: 'Delete calendar event', desc: 'Delete an event (use the id and account from calendar_events).',
      params: obj({ account: GACCT, event_id: S('Event id') }, ['event_id']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        await gapi(env, acct, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(a.event_id)}?sendUpdates=all`, { method: 'DELETE' }, 'Calendar');
        return { deleted: true, account: acct.email };
      },
    },
  },
};

// ───────────────────────── Google Drive ─────────────────────────
const EXPORTS = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
const gdrive = {
  ready: async (env) => gmail.ready(env) && (await googleAccounts(env)).length > 0,
  tools: {
    drive_search: {
      label: 'Search Drive', desc: 'Search Google Drive by file name and contents across connected Google accounts (newest first).',
      params: obj({ query: S('Words to search for'), max: N('Max files per account (default 10)'), account: GACCT }, ['query']),
      run: async (env, a) => {
        const term = a.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const q = `(name contains '${term}' or fullText contains '${term}') and trashed = false`;
        const per = await Promise.allSettled((await googleTargets(env, a.account)).map(async (acct) => {
          needsScope(acct, 'drive', 'Drive');
          const p = new URLSearchParams({ q, pageSize: String(Math.min(a.max || 10, 30)), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))' });
          const j = await gapi(env, acct, `https://www.googleapis.com/drive/v3/files?${p}`, {}, 'Drive');
          return (j.files || []).map((f) => ({ account: acct.email, id: f.id, name: f.name, type: f.mimeType.replace('application/vnd.google-apps.', 'google-'), modified: f.modifiedTime, owner: f.owners?.[0]?.displayName, link: f.webViewLink }));
        }));
        const ok = per.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
        if (!ok.length && per.some((r) => r.status === 'rejected')) throw per.find((r) => r.status === 'rejected').reason;
        return ok.sort((x, y) => String(y.modified).localeCompare(String(x.modified)));
      },
    },
    drive_read: {
      label: 'Read a Drive file', desc: 'Read a Drive file as text (Docs → text, Sheets → CSV, Slides → text, plain text files). Pass the id and account from drive_search.',
      params: obj({ file_id: S('File id'), account: GACCT }, ['file_id']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        const meta = await gapi(env, acct, `https://www.googleapis.com/drive/v3/files/${a.file_id}?fields=id,name,mimeType,size,webViewLink`, {}, 'Drive');
        const exp = EXPORTS[meta.mimeType];
        const url = exp ? `https://www.googleapis.com/drive/v3/files/${a.file_id}/export?mimeType=${encodeURIComponent(exp)}`
          : /^(text\/|application\/(json|xml|csv))/.test(meta.mimeType) ? `https://www.googleapis.com/drive/v3/files/${a.file_id}?alt=media` : null;
        if (!url) return { name: meta.name, type: meta.mimeType, link: meta.webViewLink, note: 'This file type can’t be read as text here — open the link.' };
        const r = await fetch(url, { headers: { authorization: `Bearer ${await googleAccessToken(env, acct)}` } });
        if (!r.ok) throw new ToolError(`Drive (${acct.email}) ${r.status}: couldn’t read ${meta.name}`);
        return { name: meta.name, type: meta.mimeType, link: meta.webViewLink, content: clip(await r.text(), 20000) };
      },
    },
    drive_create_doc: {
      write: true, label: 'Create Google Doc', desc: 'Create a new Google Doc with the given text in the user\'s Drive.',
      params: obj({ account: GACCT, title: S('Document title'), content: S('Document text (plain text / simple Markdown)') }, ['title', 'content']),
      run: async (env, a) => {
        const acct = await pickAccount(env, a.account);
        const boundary = 'atelier' + crypto.randomUUID().replace(/-/g, '');
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: a.title, mimeType: 'application/vnd.google-apps.document' })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.content}\r\n--${boundary}--`;
        const f = await gapi(env, acct, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', body, headers: { 'content-type': `multipart/related; boundary=${boundary}` } }, 'Drive');
        return { account: acct.email, id: f.id, name: f.name, link: f.webViewLink };
      },
    },
  },
};

// ───────────────────────── Canva (OAuth 2.0 + PKCE) ─────────────────────────
// Canva REST APIs (formerly the Connect API): https://www.canva.dev/docs/apps/rest-apis/
// Accounts live in KV as canva_accounts = [{ id, label, team, refresh, scope, connectedAt }], keyed by the Canva
// user id; access tokens are cached separately as canva_access:<id>. Canva refresh tokens are single-use: every
// refresh returns a new one, and replaying an old one revokes the whole sign-in. So concurrent callers in one
// isolate share a single refresh, a short KV lock guards against other isolates, and the rotated refresh token
// is saved before the new access token is used.
export const CANVA_SCOPES = ['design:meta:read', 'design:content:read', 'design:content:write', 'asset:read', 'asset:write', 'profile:read'].join(' ');
const CANVA_API = 'https://api.canva.com/rest/v1';
const CANVA_AUTHORIZE = 'https://www.canva.com/api/oauth/authorize';
// Token + revoke as documented on the reference pages (Canva's OpenAPI spec also lists https://api.canva.com/auth/v1/oauth).
const CANVA_OAUTH = 'https://api.canva.com/rest/v1/oauth';
export const CANVA_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const CANVA_MAX_IMAGE = 25 * 1024 * 1024; // decoded bytes
const CANVA_RECONNECT = 'Reconnect Canva in Settings → Connections.';
// Job polling and the cross-isolate refresh lock, in ms (tests shrink these).
export const CANVA_TIMING = { pollFirst: 500, pollMax: 4000, pollTotal: 60_000, lockPoll: 250, lockWait: 10_000 };

// A ToolError with the HTTP status the /api/canva routes should answer with.
export class CanvaError extends ToolError {
  constructor(message, status = 502, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const canvaConfigured = (env) => Boolean(env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET);
const canvaBasic = (env) => `Basic ${btoa(`${String(env.CANVA_CLIENT_ID).trim()}:${String(env.CANVA_CLIENT_SECRET).trim()}`)}`;
const canvaAccessKey = (id) => `canva_access:${id}`;
const canvaAccessTtl = (seconds) => Math.max(60, (Number(seconds) || 14400) - 60);
const b64std = (bytes) => btoa(String.fromCharCode(...bytes));
// Single-line text without control characters, at most `max` characters.
const oneLine = (s, max) => {
  const t = Array.from(String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
  return t.length > max ? t.slice(0, max - 1).join('') + '…' : t.join('');
};
const unixIso = (s) => (s ? new Date(s * 1000).toISOString() : null);
const jsonPost = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// PKCE (RFC 7636, S256): an 86-character random verifier and its base64url SHA-256 challenge.
export const pkceVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(64)));
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

// Consent URL; the single-use state holds the PKCE verifier for 10 minutes (the verifier never reaches the browser).
export async function canvaAuthUrl(env, redirectUri) {
  if (!canvaConfigured(env)) throw new CanvaError('Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET first.', 400);
  const verifier = pkceVerifier();
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.ATELIER_KV.put(`oauth:canva:${state}`, JSON.stringify({ verifier }), { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: String(env.CANVA_CLIENT_ID).trim(), redirect_uri: redirectUri, response_type: 'code', scope: CANVA_SCOPES,
    code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', state,
  });
  return `${CANVA_AUTHORIZE}?${q.toString().replace(/\+/g, '%20')}`;
}
// Callback: look up and burn the state. Returns { verifier } or null when unknown / expired.
export async function canvaTakeState(env, state) {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(state || '')) return null;
  const key = `oauth:canva:${state}`;
  const rec = await env.ATELIER_KV.get(key, 'json').catch(() => null);
  if (!rec) return null;
  await env.ATELIER_KV.delete(key);
  return typeof rec.verifier === 'string' ? rec : null;
}

async function canvaToken(env, form) {
  let r;
  try {
    r = await fetch(`${CANVA_OAUTH}/token`, {
      method: 'POST', headers: { authorization: canvaBasic(env), 'content-type': 'application/x-www-form-urlencoded' },
      // Bounded so a refresh always ends well inside the 60 s cross-isolate lock (see canvaRefresh).
      body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new CanvaError('Canva sign-in is unreachable right now — try again.', 502); }
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) return j;
  const code = String(j.error || j.code || '');
  console.warn('canva token error', r.status, code); // status + code only, never the request or response body
  // invalid_grant / unauthorized_user are about the user's sign-in, not the app's secrets: ask for a reconnect.
  if (code === 'invalid_grant' || code === 'unauthorized_user') throw new CanvaError(`Canva sign-in expired or was revoked. ${CANVA_RECONNECT}`, 401);
  if (code === 'invalid_client' || r.status === 401) throw new CanvaError('Canva rejected the app credentials — check CANVA_CLIENT_ID and CANVA_CLIENT_SECRET.', 502);
  if (r.status === 429) throw new CanvaError('Canva is limiting sign-in requests — wait a minute and try again.', 429);
  throw new CanvaError(`Canva sign-in failed: ${oneLine(j.error_description || j.message || code || `HTTP ${r.status}`, 160)}`, 502);
}
// Best effort: revoking a refresh token ends that sign-in (and its access tokens) at Canva.
async function canvaRevoke(env, token) {
  if (!token || !canvaConfigured(env)) return;
  try {
    await fetch(`${CANVA_OAUTH}/revoke`, {
      method: 'POST', headers: { authorization: canvaBasic(env), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

// KV read errors propagate on purpose: treating a failed read as "no accounts" would let the next write drop them all.
async function canvaAccounts(env) {
  const list = await env.ATELIER_KV.get('canva_accounts', 'json');
  return Array.isArray(list) ? list.filter((a) => a && CANVA_ID.test(a.id || '') && a.refresh) : [];
}
export async function canvaAccountList(env) { return (await canvaAccounts(env)).map(({ id, label }) => ({ id, label })); }
async function kvPutRetry(env, key, value, opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await env.ATELIER_KV.put(key, value, opts); } catch (err) { if (attempt >= 2) throw err; await sleep(150 * (attempt + 1)); }
  }
}
// Update one account, re-reading the list right before the write so other accounts' changes survive.
async function patchCanvaAccount(env, id, patch) {
  const list = await canvaAccounts(env);
  const hit = list.find((a) => a.id === id);
  if (!hit) return false;
  Object.assign(hit, patch);
  await kvPutRetry(env, 'canva_accounts', JSON.stringify(list));
  return true;
}

// OAuth callback: trade the code (+ PKCE verifier) for tokens, identify the Canva user, upsert the account → its label.
export async function canvaCompleteAuth(env, code, verifier, redirectUri) {
  const j = await canvaToken(env, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  if (!j.refresh_token) throw new CanvaError('Canva returned no refresh token', 502);
  let id = null;
  try {
    const me = await canvaRead(await canvaSend(j.access_token, '/users/me'), 'Canva');
    id = me.team_user?.user_id;
    const team = me.team_user?.team_id;
    if (!CANVA_ID.test(id || '')) throw new CanvaError('Canva returned an unexpected user id', 502);
    let name = '';
    try { name = (await canvaRead(await canvaSend(j.access_token, '/users/me/profile'), 'Canva')).profile?.display_name || ''; } catch {}
    const list = (await canvaAccounts(env)).filter((a) => a.id !== id);
    let label = oneLine(name, 80) || `Canva …${id.slice(-4)}`;
    if (list.some((a) => a.label === label)) label = `${label} (…${id.slice(-4)})`;
    list.push({ id, label, ...(CANVA_ID.test(team || '') ? { team } : {}), refresh: j.refresh_token, scope: j.scope || '', connectedAt: Date.now() });
    await kvPutRetry(env, 'canva_accounts', JSON.stringify(list));
    // Only a cache (a missing entry just means one refresh later), so it never fails the connect.
    await env.ATELIER_KV.put(canvaAccessKey(id), j.access_token, { expirationTtl: canvaAccessTtl(j.expires_in) }).catch(() => {});
    return label;
  } catch (err) {
    // Revoking a refresh token also revokes the user's consent at Canva, which would break a stored connection
    // for this same Canva user (or one just saved). So revoke only a certain orphan; otherwise leave it unused.
    const stored = await canvaAccounts(env).catch(() => null);
    const orphan = stored && (CANVA_ID.test(id || '') ? !stored.some((a) => a.id === id) : stored.length === 0);
    if (orphan) await canvaRevoke(env, j.refresh_token);
    throw err;
  }
}

// Disconnect one account (or all without an id): forget its tokens, then revoke the sign-in at Canva.
export async function removeCanvaAccount(env, id) {
  const list = await canvaAccounts(env);
  const gone = id ? list.filter((a) => a.id === id) : list;
  const keep = list.filter((a) => !gone.includes(a));
  await env.ATELIER_KV.put('canva_accounts', JSON.stringify(keep));
  for (const a of gone) {
    await Promise.all([env.ATELIER_KV.delete(canvaAccessKey(a.id)), env.ATELIER_KV.delete(`canva_lock:${a.id}`)]);
    await canvaRevoke(env, a.refresh);
  }
  return keep.length;
}

// Access token for an account: the cached one unless it is `stale` (just rejected by Canva), else a refresh.
const canvaInflight = new Map(); // account id → { p, at }: the refresh running in this isolate
const JOIN_TIMEOUT = Symbol('join timeout');
async function canvaAccessToken(env, acct, stale) {
  const cached = await env.ATELIER_KV.get(canvaAccessKey(acct.id));
  if (cached && cached !== stale) return cached;
  const running = canvaInflight.get(acct.id);
  if (running && Date.now() - running.at < CANVA_TIMING.lockWait * 3) {
    // Share the refresh another request started, without hanging on it if that request was cancelled.
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, CANVA_TIMING.lockWait, JOIN_TIMEOUT); });
    const got = await Promise.race([running.p, late]).finally(() => clearTimeout(timer));
    if (got !== JOIN_TIMEOUT) return got;
  }
  const entry = { at: Date.now() };
  entry.p = canvaRefresh(env, acct.id, stale).finally(() => { if (canvaInflight.get(acct.id) === entry) canvaInflight.delete(acct.id); });
  canvaInflight.set(acct.id, entry);
  // Once Canva has spent the old refresh token, the rotated one must reach KV even if the browser disconnects
  // (closed tab, backgrounded PWA): keep the whole critical section alive past the request.
  try { waitUntil(entry.p.catch(() => {})); } catch {}
  return entry.p;
}
async function canvaRefresh(env, id, stale) {
  const kv = env.ATELIER_KV;
  const lockKey = `canva_lock:${id}`;
  const nonce = crypto.randomUUID();
  const fresh = async () => { const t = await kv.get(canvaAccessKey(id)); return t && t !== stale ? t : null; };
  // Another isolate may be refreshing this account right now: wait for its token instead of spending ours.
  const deadline = Date.now() + CANVA_TIMING.lockWait;
  for (;;) {
    if (!(await kv.get(lockKey))) {
      await kv.put(lockKey, nonce, { expirationTtl: 60 });
      if ((await kv.get(lockKey)) === nonce) break;
    }
    if (Date.now() >= deadline) throw new CanvaError('Canva is finishing a sign-in refresh — try again in a few seconds.', 429);
    await sleep(CANVA_TIMING.lockPoll);
    const t = await fresh();
    if (t) return t;
  }
  try {
    const t = await fresh();
    if (t) return t;
    const acct = (await canvaAccounts(env)).find((a) => a.id === id); // the latest (possibly just rotated) refresh token
    if (!acct) throw new CanvaError(`That Canva account is no longer connected. ${CANVA_RECONNECT}`, 401);
    let j;
    try {
      j = await canvaToken(env, { grant_type: 'refresh_token', refresh_token: acct.refresh });
    } catch (err) {
      if (err.status === 401) await kv.delete(canvaAccessKey(id));
      throw err;
    }
    // The old refresh token is spent: persist its replacement before anything else.
    const saved = await patchCanvaAccount(env, id, { refresh: j.refresh_token || acct.refresh, ...(j.scope ? { scope: j.scope } : {}) });
    // Disconnected while we refreshed (its revoke also ends the new token's lineage at Canva).
    if (!saved) throw new CanvaError(`That Canva account is no longer connected. ${CANVA_RECONNECT}`, 401);
    await kv.put(canvaAccessKey(id), j.access_token, { expirationTtl: canvaAccessTtl(j.expires_in) });
    return j.access_token;
  } finally {
    if ((await kv.get(lockKey).catch(() => null)) === nonce) await kv.delete(lockKey).catch(() => {});
  }
}

function canvaFailure(status, j, label) {
  const code = String(j.code || j.error || '');
  const msg = oneLine(j.message || j.error_description || code || `HTTP ${status}`, 200);
  console.warn('canva api error', status, code);
  if (status === 401 || /^(invalid_access_token|revoked_access_token|invalid_grant)$/.test(code)) return new CanvaError(`${label}: sign-in expired or was revoked. ${CANVA_RECONNECT}`, 401);
  if (status === 403 && code === 'missing_scope') return new CanvaError(`${label}: this connection is missing a Canva permission. ${CANVA_RECONNECT}`, 403, { code });
  if (status === 403) return new CanvaError(`${label}: ${msg}`, 403, { code });
  if (status === 429) return new CanvaError(`${label}: Canva's rate limit was reached (${msg}) — wait a minute and try again.`, 429);
  if (status >= 500) return new CanvaError(`${label}: Canva had a problem (${status}) — try again shortly.`, 502);
  return new CanvaError(`${label}: ${msg}`, status === 404 ? 404 : 400, { code });
}
async function canvaSend(token, path, init = {}) {
  try {
    return await fetch(`${CANVA_API}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
  } catch { throw new CanvaError('Canva is unreachable right now — try again.', 502); }
}
async function canvaRead(r, label) {
  const text = await r.text().catch(() => '');
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) throw canvaFailure(r.status, j, label);
  return j;
}
// Authenticated Canva call; a 401 gets one retry with a refreshed token.
async function canvaApi(env, acct, path, init = {}, what = 'Canva') {
  let token = await canvaAccessToken(env, acct);
  let r = await canvaSend(token, path, init);
  if (r.status === 401) {
    await r.body?.cancel().catch(() => {});
    token = await canvaAccessToken(env, acct, token);
    r = await canvaSend(token, path, init);
  }
  return canvaRead(r, `${what} (${acct.label})`);
}
// Poll an async Canva job ({ job: { id, status } }) with backoff until success / failure / the time limit.
async function canvaJob(first, poll, what, { total = CANVA_TIMING.pollTotal, onTimeout } = {}) {
  let job = first?.job;
  const start = Date.now();
  let delay = CANVA_TIMING.pollFirst;
  while (job?.status === 'in_progress' && job.id) {
    if (Date.now() - start + delay > total) {
      throw new CanvaError(onTimeout ? onTimeout(job.id) : `${what} is still running at Canva after ${Math.round(total / 1000)}s — try again shortly.`, 502, { timeout: true });
    }
    await sleep(delay);
    let next;
    try {
      next = await poll(encodeURIComponent(job.id));
    } catch (err) {
      if (!(err instanceof CanvaError) || err.status !== 429) throw err;
      // Rate-limited while polling: back off harder and keep the same job (it is still running at Canva);
      // if time runs out, the check above reports the job id so it can be resumed rather than restarted.
      delay = Math.min(delay * 2, CANVA_TIMING.pollMax);
      continue;
    }
    delay = Math.min(Math.round(delay * 1.6), CANVA_TIMING.pollMax);
    job = next.job;
  }
  if (job?.status === 'success') return job;
  if (job?.status === 'failed') {
    const code = String(job.error?.code || '');
    throw new CanvaError(`${what} failed at Canva: ${oneLine(job.error?.message || code || 'unknown error', 200)}`, code === 'license_required' || code === 'approval_required' ? 403 : 502, { code });
  }
  throw new CanvaError(`${what}: unexpected reply from Canva.`, 502);
}

async function pickCanvaAccount(env, wanted) {
  const list = await canvaAccounts(env);
  if (!list.length) throw new CanvaError(`Canva isn’t connected. ${CANVA_RECONNECT}`, 401);
  if (wanted == null || wanted === '') return list[0];
  const raw = String(wanted).trim();
  const w = raw.toLowerCase();
  const hit = list.find((a) => a.id === raw) || list.find((a) => a.label.toLowerCase() === w) || list.find((a) => a.label.toLowerCase().includes(w));
  if (!hit) throw new CanvaError(`No connected Canva account matches "${oneLine(raw, 60)}". Connected: ${list.map((a) => a.label).join(', ')}`, 400);
  return hit;
}
async function canvaTargets(env, wanted) {
  if (wanted) return [await pickCanvaAccount(env, wanted)];
  const list = await canvaAccounts(env);
  if (!list.length) throw new CanvaError(`Canva isn’t connected. ${CANVA_RECONNECT}`, 401);
  return list;
}
// First account that can see the thing; only "no access / not found" moves on to the next account. A 403 that
// means "this account sees it but may not do that" (license_required, approval_required, missing_scope…) is final:
// its message is the useful one, and trying the next account would start (and bill) a second job.
async function canvaFirst(accounts, fn) {
  let last;
  for (const acct of accounts) {
    try { return { account: acct.label, ...(await fn(acct)) }; } catch (err) {
      const noAccess = err instanceof CanvaError && !err.timeout
        && (err.status === 404 || (err.status === 403 && (!err.code || err.code === 'permission_denied')));
      if (!noAccess) throw err;
      last = err;
    }
  }
  throw last;
}
const canvaDesignId = (v) => {
  const s = String(v ?? '').trim();
  const id = s.match(/canva\.com\/design\/([A-Za-z0-9_-]+)/)?.[1] || s; // also accept a design link
  if (!CANVA_ID.test(id)) throw new CanvaError('design_id must be a Canva design id (e.g. from canva_designs).', 400);
  return id;
};
const designOut = (acct, d) => ({
  account: acct.label, id: d.id, title: d.title || '(untitled)', edit_url: d.urls?.edit_url || null, view_url: d.urls?.view_url || null,
  thumbnail: d.thumbnail?.url || null, updated: unixIso(d.updated_at),
});

// Images: sniff the real type from the bytes (a data URL's declared type is not always right).
function sniffImage(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 6 && String.fromCharCode(...b.subarray(0, 4)) === 'GIF8') return 'image/gif';
  return null;
}
function base64Bytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// data:image/(png|jpeg|webp);base64,… → { bytes, mime } (≤ 25 MB decoded), or a 400 CanvaError.
export function parseImageDataUrl(input) {
  const bad = (msg) => new CanvaError(msg, 400);
  if (typeof input !== 'string') throw bad('image must be a data: URL (PNG, JPEG or WebP).');
  const comma = input.indexOf(',');
  if (comma < 0 || comma > 100 || !/^data:image\/(png|jpeg|webp);base64$/i.test(input.slice(0, comma))) {
    throw bad('image must be a base64 data: URL of type image/png, image/jpeg or image/webp.');
  }
  let b64 = input.slice(comma + 1);
  if (/\s/.test(b64)) b64 = b64.replace(/\s+/g, '');
  if (Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) > CANVA_MAX_IMAGE) throw bad('Image is too large for Canva (max 25 MB).');
  if (!b64.length || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('image data is not valid base64.');
  let bytes;
  try { bytes = base64Bytes(b64); } catch { throw bad('image data is not valid base64.'); }
  const mime = sniffImage(bytes);
  if (!mime || mime === 'image/gif') throw bad('image data is not a PNG, JPEG or WebP picture.');
  return { bytes, mime };
}

// Upload raw image bytes as a Canva asset (binary asset upload job) → the finished asset.
async function canvaUploadBytes(env, acct, bytes, name) {
  const meta = JSON.stringify({ name_base64: b64std(new TextEncoder().encode(oneLine(name, 50) || 'Atelier image')) });
  const first = await canvaApi(env, acct, '/asset-uploads', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'asset-upload-metadata': meta }, body: bytes }, 'Canva upload');
  const job = await canvaJob(first, (jid) => canvaApi(env, acct, `/asset-uploads/${jid}`, {}, 'Canva upload'), 'Canva upload');
  if (!job.asset?.id) throw new CanvaError('Canva finished the upload but returned no asset.', 502);
  return job.asset;
}

// POST /api/canva/send-image: upload an Atelier image and open it as a new Canva design.
export async function canvaSendImage(env, body) {
  if (!canvaConfigured(env)) throw new CanvaError('Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET first.', 400);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CanvaError('Send { image, title?, account? }.', 400);
  const { bytes } = parseImageDataUrl(body.image);
  if (body.title != null && typeof body.title !== 'string') throw new CanvaError('title must be a string.', 400);
  if (body.account != null && typeof body.account !== 'string') throw new CanvaError('account must be a Canva account id or name.', 400);
  const title = oneLine(body.title, 120) || 'Atelier image'; // longer titles (e.g. whole prompts) are shortened, not refused
  const acct = await pickCanvaAccount(env, body.account || undefined);
  const asset = await canvaUploadBytes(env, acct, bytes, title);
  const d = (await canvaApi(env, acct, '/designs', jsonPost({ asset_id: asset.id, title }), 'Canva')).design;
  if (!d?.id) throw new CanvaError('Canva created no design.', 502);
  return { design_id: d.id, title: d.title || title, edit_url: d.urls?.edit_url || null, view_url: d.urls?.view_url || null };
}

// Links the Worker itself may download (canva_upload_image fallback): public https hosts only.
export function checkPublicUrl(raw) {
  const bad = (msg) => new CanvaError(msg, 400);
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw bad('url must be a full https:// link.'); }
  if (u.protocol !== 'https:') throw bad('Only https:// image links can be uploaded.');
  if (u.href.length > 2048) throw bad('That link is too long (max 2048 characters).');
  if (u.username || u.password) throw bad('Links with a username or password are not allowed.');
  if (u.port && u.port !== '443') throw bad('Only links on the standard https port are allowed.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) throw bad('IP-address links are not allowed — use the image’s public web address.');
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateV4 = v4 && (v4[0] === 0 || v4[0] === 10 || v4[0] === 127 || v4[0] >= 224 || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127)
    || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168)
    || (v4[0] === 192 && v4[1] === 0 && v4[2] === 0) || (v4[0] === 198 && (v4[1] === 18 || v4[1] === 19)));
  if (!host.includes('.') || privateV4 || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) {
    throw bad('That link points to a private address.');
  }
  return u;
}
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/tiff'];
async function fetchPublicImage(start) {
  let u = start;
  for (let hop = 0; hop < 4; hop++) {
    let r;
    try { r = await fetch(u.href, { redirect: 'manual', headers: { accept: 'image/*' }, signal: AbortSignal.timeout(20_000) }); } catch {
      throw new CanvaError(`Couldn’t download the image from ${u.hostname}.`, 400);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel().catch(() => {});
      if (!loc) throw new CanvaError('The image link redirected nowhere.', 400);
      u = checkPublicUrl(new URL(loc, u).href); // every hop must be public https too
      continue;
    }
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const fail = async (msg) => { await r.body?.cancel().catch(() => {}); return new CanvaError(msg, 400); };
    if (!r.ok) throw await fail(`Downloading the image failed (${r.status}).`);
    if (!UPLOAD_TYPES.includes(type)) throw await fail(`That link is not a PNG, JPEG, WebP, GIF, HEIC or TIFF image (${oneLine(type || 'unknown type', 60)}).`);
    if (Number(r.headers.get('content-length') || 0) > CANVA_MAX_IMAGE || !r.body) throw await fail(r.body ? 'The image is larger than 25 MB.' : 'The image link returned nothing.');
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CANVA_MAX_IMAGE) { await reader.cancel().catch(() => {}); throw new CanvaError('The image is larger than 25 MB.', 400); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    // PNG / JPEG / WebP / GIF must really be pictures (servers mislabel formats, so any of the four is fine).
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type) && !sniffImage(bytes)) throw new CanvaError('The downloaded file isn’t a valid image.', 400);
    return bytes;
  }
  throw new CanvaError('The image link redirected too many times.', 400);
}

const CACCT = S('Which connected Canva account (name or id) to use (omit for all / the default)');
const DESIGN_SORTS = ['relevance', 'modified_descending', 'modified_ascending', 'title_descending', 'title_ascending'];
const EXPORT_FORMATS = ['png', 'jpg', 'pdf', 'mp4', 'gif', 'pptx', 'csv', 'html_bundle', 'html_standalone'];
const MP4_QUALITIES = ['horizontal_480p', 'horizontal_720p', 'horizontal_1080p', 'horizontal_4k', 'vertical_480p', 'vertical_720p', 'vertical_1080p', 'vertical_4k'];
const intArg = (v, name, lo, hi) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new CanvaError(`${name} must be a whole number from ${lo} to ${hi}.`, 400);
  return n;
};
// canva_export arguments → Canva's export `format` object (only the options each format supports).
function canvaExportFormat(a) {
  const type = String(a.format || '').toLowerCase();
  if (!EXPORT_FORMATS.includes(type)) throw new CanvaError(`format must be one of ${EXPORT_FORMATS.join(', ')}.`, 400);
  const f = { type };
  if (Array.isArray(a.pages) && a.pages.length) f.pages = [...new Set(a.pages.map((p) => intArg(p, 'Each page number', 1, 500)))].sort((x, y) => x - y);
  if (type.startsWith('html_') && f.pages?.length > 1) throw new CanvaError('html_bundle and html_standalone export one page at a time; give a single page number.', 400);
  if (a.export_quality != null && a.export_quality !== '') {
    if (!['regular', 'pro'].includes(a.export_quality)) throw new CanvaError('export_quality must be regular or pro.', 400);
    if (['pdf', 'jpg', 'png', 'gif', 'mp4'].includes(type)) f.export_quality = a.export_quality; // pptx, csv and html_* take none
  }
  if (['png', 'jpg', 'gif'].includes(type)) for (const k of ['width', 'height']) if (a[k] != null) f[k] = intArg(a[k], k, 40, 25000);
  if (type === 'jpg') f.quality = a.jpg_quality == null ? 90 : intArg(a.jpg_quality, 'jpg_quality', 1, 100);
  if (type === 'mp4') {
    if (a.video_quality != null && !MP4_QUALITIES.includes(a.video_quality)) throw new CanvaError(`video_quality must be one of ${MP4_QUALITIES.join(', ')}.`, 400);
    f.quality = a.video_quality || 'horizontal_1080p';
  }
  if (type === 'png') {
    if (a.transparent_background != null) f.transparent_background = Boolean(a.transparent_background);
    if (a.as_single_image != null) f.as_single_image = Boolean(a.as_single_image);
  }
  if (type === 'pdf' && a.pdf_size) {
    if (!['a4', 'a3', 'letter', 'legal'].includes(a.pdf_size)) throw new CanvaError('pdf_size must be a4, a3, letter or legal.', 400);
    f.size = a.pdf_size;
  }
  return f;
}

const canva = {
  ready: async (env) => canvaConfigured(env) && (await canvaAccounts(env)).length > 0,
  tools: {
    canva_designs: {
      label: 'Search Canva designs', desc: 'Search or list the user\'s Canva designs (owned and shared) across connected Canva accounts. Without a query it lists the most recently edited. Thumbnail links expire after 15 minutes.',
      params: obj({
        query: S('Search words (omit to list recent designs)'), limit: N('Max designs per account (default 10, max 25)'),
        ownership: S('any (default), owned or shared', { enum: ['any', 'owned', 'shared'] }),
        sort: S('Sort order (default: relevance with a query, else modified_descending)', { enum: DESIGN_SORTS }), account: CACCT,
      }),
      run: async (env, a) => {
        const q = new URLSearchParams({ limit: String(Math.min(Math.max(Number.parseInt(a.limit, 10) || 10, 1), 25)) });
        if (a.query) q.set('query', String(a.query).slice(0, 255));
        if (['any', 'owned', 'shared'].includes(a.ownership)) q.set('ownership', a.ownership);
        q.set('sort_by', DESIGN_SORTS.includes(a.sort) ? a.sort : a.query ? 'relevance' : 'modified_descending');
        const per = await Promise.allSettled((await canvaTargets(env, a.account)).map(async (acct) =>
          ((await canvaApi(env, acct, `/designs?${q}`, {}, 'Canva')).items || []).map((d) => designOut(acct, d))));
        const ok = per.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
        if (!ok.length && per.some((r) => r.status === 'rejected')) throw per.find((r) => r.status === 'rejected').reason;
        return ok;
      },
    },
    canva_design: {
      label: 'Canva design details', desc: 'Details of one Canva design: title, page count, edit/view links, thumbnail and the formats it can be exported to.',
      params: obj({ design_id: S('Design id (from canva_designs) or a canva.com/design/… link'), account: CACCT }, ['design_id']),
      run: async (env, a) => {
        const id = canvaDesignId(a.design_id);
        return canvaFirst(await canvaTargets(env, a.account), async (acct) => {
          const d = (await canvaApi(env, acct, `/designs/${id}`, {}, 'Canva')).design || {};
          // Only formats canva_export can produce (Canva also lists e.g. svg, which its export API can't make).
          const formats = await canvaApi(env, acct, `/designs/${id}/export-formats`, {}, 'Canva').then((j) => Object.keys(j.formats || {}).filter((k) => EXPORT_FORMATS.includes(k)), () => undefined);
          const { account, ...out } = designOut(acct, d);
          return { ...out, page_count: d.page_count ?? null, design_types: d.design_types, created: unixIso(d.created_at), export_formats: formats,
            note: 'edit_url and view_url only work for this Canva user and expire after 30 days; the thumbnail link expires after 15 minutes.' };
        });
      },
    },
    canva_export: {
      label: 'Export a Canva design', desc: 'Export a Canva design as png, jpg, pdf, mp4, gif, pptx, csv, html_bundle or html_standalone and return download links (they expire after 24 hours). Docs export only as pdf, Sheets only as csv, emails as pdf, html_bundle or html_standalone (html_* one page at a time); check canva_design\'s export_formats if unsure. Exporting does not change the design.',
      params: obj({
        design_id: S('Design id (from canva_designs) or a canva.com/design/… link'), format: S('Export format', { enum: EXPORT_FORMATS }),
        pages: { type: 'array', items: { type: 'integer' }, description: 'Page numbers to export, starting at 1 (omit for all pages; html_bundle/html_standalone take at most one)' },
        jpg_quality: N('JPG quality 1-100 (default 90)'), video_quality: S('MP4 resolution (default horizontal_1080p)', { enum: MP4_QUALITIES }),
        width: N('Output width in px, 40-25000 (png/jpg/gif; one side keeps the aspect ratio)'), height: N('Output height in px, 40-25000 (png/jpg/gif)'),
        transparent_background: { type: 'boolean', description: 'PNG only; needs a paid Canva plan' },
        as_single_image: { type: 'boolean', description: 'PNG only: merge all pages into one image' },
        export_quality: S('regular (default) or pro (pro may need a paid plan)', { enum: ['regular', 'pro'] }),
        pdf_size: S('PDF paper size (Canva Docs only)', { enum: ['a4', 'a3', 'letter', 'legal'] }),
        export_id: S('Only to keep waiting on an export that timed out earlier: the export_id from that error'),
        account: CACCT,
      }, ['design_id', 'format']),
      run: async (env, a) => {
        const id = canvaDesignId(a.design_id);
        const format = canvaExportFormat(a);
        if (a.export_id != null && !CANVA_ID.test(String(a.export_id))) throw new CanvaError('export_id is not valid.', 400);
        const total = ['mp4', 'gif'].includes(format.type) ? CANVA_TIMING.pollTotal * 2.5 : CANVA_TIMING.pollTotal;
        return canvaFirst(await canvaTargets(env, a.account), async (acct) => {
          const first = a.export_id ? { job: { id: String(a.export_id), status: 'in_progress' } }
            : await canvaApi(env, acct, '/exports', jsonPost({ design_id: id, format }), 'Canva export');
          const job = await canvaJob(first, (jid) => canvaApi(env, acct, `/exports/${jid}`, {}, 'Canva export'), 'Canva export', {
            total, onTimeout: (jid) => `Canva is still rendering this export — call canva_export again with export_id "${jid}" to keep waiting.`,
          });
          return { design_id: id, format: format.type, urls: job.urls || [], note: 'Download links expire after 24 hours — save the files if they need to be kept.' };
        });
      },
    },
    canva_create_design: {
      write: true, label: 'Create Canva design', desc: 'Create a new Canva design: a preset type (doc, whiteboard or presentation) or a custom width × height in px, optionally starting with an uploaded image (asset_id from canva_upload_image). Returns links to edit it.',
      params: obj({
        title: S('Design title'), design_type: S('Preset type (or give width + height instead)', { enum: ['doc', 'whiteboard', 'presentation'] }),
        width: N('Custom width in px, 40-8000'), height: N('Custom height in px, 40-8000 (width × height at most 25,000,000)'),
        asset_id: S('Image asset id to place in the design (optional)'), account: CACCT,
      }, ['title']),
      run: async (env, a) => {
        const body = { title: oneLine(a.title, 255) || 'Untitled design' };
        const custom = a.width != null || a.height != null;
        if (a.design_type && custom) throw new CanvaError('Give either design_type or width + height, not both.', 400);
        if (a.design_type) {
          if (!['doc', 'whiteboard', 'presentation'].includes(a.design_type)) throw new CanvaError('design_type must be doc, whiteboard or presentation.', 400);
          body.design_type = { type: 'preset', name: a.design_type };
        } else if (custom) {
          const width = intArg(a.width, 'width', 40, 8000);
          const height = intArg(a.height, 'height', 40, 8000);
          if (width * height > 25_000_000) throw new CanvaError('width × height must be at most 25,000,000 pixels.', 400);
          body.design_type = { type: 'custom', width, height };
        }
        if (a.asset_id) {
          if (!CANVA_ID.test(String(a.asset_id))) throw new CanvaError('asset_id is not a valid Canva asset id.', 400);
          body.asset_id = String(a.asset_id);
        }
        if (!body.design_type && !body.asset_id) throw new CanvaError('Give a design_type, a width + height, or an asset_id.', 400);
        const acct = await pickCanvaAccount(env, a.account);
        const d = (await canvaApi(env, acct, '/designs', jsonPost(body), 'Canva')).design;
        if (!d?.id) throw new CanvaError('Canva created no design.', 502);
        return { account: acct.label, id: d.id, title: d.title || body.title, edit_url: d.urls?.edit_url || null, view_url: d.urls?.view_url || null,
          ...(body.asset_id ? {} : { note: 'Canva deletes blank API-created designs that aren\'t edited within 7 days.' }) };
      },
    },
    canva_upload_image: {
      write: true, label: 'Upload image to Canva', desc: 'Upload an image from a public https link into the user\'s Canva uploads. Returns an asset_id to use with canva_create_design.',
      params: obj({ url: S('Public https:// link to a PNG, JPEG, WebP, GIF, HEIC or TIFF image'), name: S('Name for the image in Canva (optional)'), account: CACCT }, ['url']),
      run: async (env, a) => {
        const u = checkPublicUrl(a.url);
        const acct = await pickCanvaAccount(env, a.account);
        let fromPath = '';
        try { fromPath = decodeURIComponent(u.pathname.split('/').pop() || ''); } catch {}
        const name = oneLine(a.name || fromPath, 255) || 'Atelier image';
        // Canva fetches the link itself (URL asset upload — a preview API). If Canva can't or won't, the Worker
        // downloads it (public https only, ≤ 25 MB, image types) and uses the regular binary upload instead.
        try {
          const first = await canvaApi(env, acct, '/url-asset-uploads', jsonPost({ name, url: u.href }), 'Canva upload');
          const job = await canvaJob(first, (jid) => canvaApi(env, acct, `/url-asset-uploads/${jid}`, {}, 'Canva upload'), 'Canva upload');
          if (job.asset?.id) return { account: acct.label, asset_id: job.asset.id, name: job.asset.name || name };
        } catch (err) {
          if (!(err instanceof CanvaError) || err.timeout || err.status === 401 || err.status === 429 || err.message.includes(CANVA_RECONNECT)) throw err;
          console.warn('canva url upload failed, uploading from the worker instead', err.status);
        }
        const asset = await canvaUploadBytes(env, acct, await fetchPublicImage(u), name);
        return { account: acct.label, asset_id: asset.id, name: asset.name || oneLine(name, 50) };
      },
    },
  },
};

// ───────────────────────── Canva → Atelier Library (browse, import, file proxy) ─────────────────────────
// The Library's "From Canva" view: list one account's designs, check which formats a design exports to, export it
// as PNG pages or one MP4, and hand the browser same-origin links to the files. Canva's export download links are
// presigned, expire after 24 hours and aren't meant for browser CORS fetches, so the Worker streams them — but only
// from the export host the Canva docs show, never following a redirect anywhere else, and never with a Canva token.
export const CANVA_EXPORT_HOSTS = Object.freeze(['export-download.canva.com']);
export const CANVA_FILE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'video/mp4']);
// maxBytes: largest file the proxy streams; headerWait: ms to wait for the export host to answer (tests shrink both).
export const CANVA_FILE_LIMITS = { maxBytes: 100 * 1024 * 1024, headerWait: 30_000 };
export const CANVA_IMPORT_MAX_FILES = 10;
const CANVA_LIBRARY_PAGE = 24;
// Continuation tokens are opaque; Canva's documented example contains ':' as well as base64-style characters.
export const CANVA_CONTINUATION = /^[A-Za-z0-9_=+/.:-]{1,2048}$/;
const CANVA_FILE_URL_MAX = 8192;

const httpsHref = (v) => {
  if (typeof v !== 'string' || !v) return null;
  try { const u = new URL(v); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
};
const canvaReady = (env) => { if (!canvaConfigured(env)) throw new CanvaError('Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET first.', 400); };
const optText = (v, name) => {
  if (v != null && typeof v !== 'string') throw new CanvaError(`${name} must be a string.`, 400);
  return v ? v.trim() : '';
};
const libraryDesignId = (v) => {
  if (typeof v !== 'string' || !CANVA_ID.test(v)) throw new CanvaError('design_id must be a Canva design id.', 400);
  return v;
};
const libraryDesign = (d) => {
  const at = Number(d.updated_at ?? d.created_at);
  return {
    id: d.id,
    title: oneLine(d.title, 255) || 'Untitled design',
    thumbnail: httpsHref(d.thumbnail?.url), // expires 15 minutes after the listing
    updated: Number.isFinite(at) && at > 0 ? Math.floor(at) : null,
    page_count: Number.isInteger(d.page_count) && d.page_count >= 0 ? d.page_count : null,
    types: Array.isArray(d.design_types) ? d.design_types.filter((t) => typeof t === 'string' && t).slice(0, 10).map((t) => oneLine(t, 40)) : [],
    edit_url: httpsHref(d.urls?.edit_url),
  };
};

// GET /api/canva/designs: one page of one account's designs (the named one, else the first connected) —
// best matches for a query, otherwise the most recently edited.
export async function canvaListDesigns(env, { query, continuation, account } = {}) {
  canvaReady(env);
  const q = optText(query, 'query').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if ([...q].length > 255) throw new CanvaError('Search words can be at most 255 characters.', 400);
  const cont = optText(continuation, 'continuation');
  if (cont && !CANVA_CONTINUATION.test(cont)) throw new CanvaError('That “Load more” token isn’t valid — search again.', 400);
  const acct = await pickCanvaAccount(env, optText(account, 'account') || undefined);
  const params = new URLSearchParams({ limit: String(CANVA_LIBRARY_PAGE), sort_by: q ? 'relevance' : 'modified_descending' });
  if (q) params.set('query', q);
  if (cont) params.set('continuation', cont);
  const j = await canvaApi(env, acct, `/designs?${params}`, {}, 'Canva');
  const items = (Array.isArray(j.items) ? j.items : []).filter((d) => d && typeof d.id === 'string' && CANVA_ID.test(d.id)).map(libraryDesign);
  let next = typeof j.continuation === 'string' && j.continuation ? j.continuation : null;
  if (next && !CANVA_CONTINUATION.test(next)) {
    // Never hand out a token this route would refuse; the list just ends here.
    console.warn('canva continuation has an unexpected shape', next.length);
    next = null;
  }
  return { account: { id: acct.id, label: acct.label }, items, continuation: next };
}

// GET /api/canva/designs/<id>/formats: title, page count and the export formats the design supports.
export async function canvaDesignFormats(env, designId, account) {
  canvaReady(env);
  const id = libraryDesignId(designId);
  const { account: _, ...out } = await canvaFirst(await canvaTargets(env, optText(account, 'account') || undefined), async (acct) => {
    const [d, f] = await Promise.all([
      canvaApi(env, acct, `/designs/${id}`, {}, 'Canva').then((j) => j.design || {}),
      canvaApi(env, acct, `/designs/${id}/export-formats`, {}, 'Canva'),
    ]);
    const formats = [...new Set(Object.keys(f.formats && typeof f.formats === 'object' ? f.formats : {}).map((k) => k.toLowerCase()))]
      .filter((k) => EXPORT_FORMATS.includes(k));
    return { title: oneLine(d.title, 255) || 'Untitled design', page_count: Number.isInteger(d.page_count) && d.page_count >= 0 ? d.page_count : null, formats };
  });
  return out;
}

function importPages(v) {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length > CANVA_IMPORT_MAX_FILES) throw new CanvaError(`pages must be a list of at most ${CANVA_IMPORT_MAX_FILES} page numbers.`, 400);
  const seen = new Set();
  for (const p of v) {
    if (!Number.isInteger(p) || p < 1 || p > 500) throw new CanvaError('Each page number must be a whole number from 1 to 500.', 400);
    if (seen.has(p)) throw new CanvaError('Each page number can appear only once.', 400);
    seen.add(p);
  }
  return seen.size ? [...seen].sort((a, b) => a - b) : null; // [] means every page, like leaving pages out
}
// Canva's plan / approval / format refusals, in words that say what to do next.
function canvaImportError(err, format) {
  if (!(err instanceof CanvaError)) return err;
  const code = String(err.code || '');
  if (code === 'license_required') {
    return new CanvaError('This design uses premium Canva elements your plan doesn’t cover — license or remove them in Canva, then import again.', 403, { code });
  }
  if (code === 'approval_required') {
    return new CanvaError('This design needs approval in Canva before it can be exported — get it approved there, then import again.', 403, { code });
  }
  if (/not[ _]supported|unsupported/i.test(`${code} ${err.message}`)) {
    return new CanvaError(`Canva can’t export this design as ${format === 'mp4' ? 'a video (MP4)' : 'an image (PNG)'}.`, 400, { code });
  }
  return err;
}
// Canva export URL → the same-origin proxy link the browser downloads it through.
export const canvaFileLink = (u) => `/api/canva/file?u=${encodeURIComponent(u)}`;

// POST /api/canva/import: export a design as PNG (one file per page, at most 10) or as one MP4, wait for Canva,
// and return proxy links to the files in page order.
export async function canvaImport(env, body) {
  canvaReady(env);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CanvaError('Send { design_id, format, pages?, account? }.', 400);
  const id = libraryDesignId(body.design_id);
  const format = body.format;
  if (format !== 'png' && format !== 'mp4') throw new CanvaError('format must be "png" or "mp4".', 400);
  const pages = importPages(body.pages);
  const targets = await canvaTargets(env, optText(body.account, 'account') || undefined);
  const total = format === 'mp4' ? CANVA_TIMING.pollTotal * 2.5 : CANVA_TIMING.pollTotal;
  try {
    const { account: _, ...out } = await canvaFirst(targets, async (acct) => {
      const d = (await canvaApi(env, acct, `/designs/${id}`, {}, 'Canva')).design || {};
      const pageCount = Number.isInteger(d.page_count) && d.page_count > 0 ? d.page_count : null;
      const f = { type: format };
      let truncated = false;
      if (pages) f.pages = pages;
      else if (format === 'png' && pageCount > CANVA_IMPORT_MAX_FILES) {
        // Render only the pages Atelier will keep (each page is one PNG).
        f.pages = Array.from({ length: CANVA_IMPORT_MAX_FILES }, (_, i) => i + 1);
        truncated = true;
      }
      if (format === 'mp4') {
        // PNG keeps Canva's defaults (lossless, which the Free plan requires). MP4 needs a quality: portrait when the thumbnail is.
        const t = d.thumbnail;
        f.quality = t && Number(t.height) > Number(t.width) ? 'vertical_1080p' : 'horizontal_1080p';
      }
      const first = await canvaApi(env, acct, '/exports', jsonPost({ design_id: id, format: f }), 'Canva export');
      const job = await canvaJob(first, (jid) => canvaApi(env, acct, `/exports/${jid}`, {}, 'Canva export'), 'Canva export', {
        total, onTimeout: () => 'Canva is still rendering this design — try the import again in a minute.',
      });
      const urls = (Array.isArray(job.urls) ? job.urls : []).filter((u) => typeof u === 'string' && u);
      if (!urls.length) throw new CanvaError('Canva finished the export but sent no files — try again.', 502);
      if (urls.length > CANVA_IMPORT_MAX_FILES) truncated = true;
      const keep = urls.slice(0, CANVA_IMPORT_MAX_FILES);
      for (const u of keep) {
        try { checkCanvaFileUrl(u); } catch {
          let host = '?';
          try { host = new URL(u).hostname; } catch {}
          console.warn('canva export link on an unexpected host', host.slice(0, 100));
          throw new CanvaError('Canva sent a download link Atelier doesn’t recognise — try again later.', 502);
        }
      }
      return { design_id: id, title: oneLine(d.title, 255) || 'Untitled design', format, files: keep.map(canvaFileLink), truncated };
    });
    return out;
  } catch (err) { throw canvaImportError(err, format); }
}

// Only https links on the Canva export host(s): no userinfo, no other port, no lookalike or sub-domains.
export function checkCanvaFileUrl(raw) {
  const bad = () => new CanvaError('That isn’t a Canva download link.', 400);
  const s = typeof raw === 'string' ? raw : '';
  if (!s || s.length > CANVA_FILE_URL_MAX) throw bad();
  let u;
  try { u = new URL(s); } catch { throw bad(); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !CANVA_EXPORT_HOSTS.includes(u.hostname)) throw bad();
  return u;
}
// Real file type from the first bytes, for an export host that labels a file generically.
function sniffCanvaFile(b) {
  const img = sniffImage(b);
  if (img === 'image/png' || img === 'image/jpeg') return img;
  if (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp') return 'video/mp4';
  return null;
}
// GET /api/canva/file?u=…: stream one export file (PNG, JPEG or MP4, ≤ CANVA_FILE_LIMITS.maxBytes) to the browser.
export async function canvaFetchFile(raw) {
  let u = checkCanvaFileUrl(raw);
  const max = CANVA_FILE_LIMITS.maxBytes;
  for (let hop = 0; hop < 3; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CANVA_FILE_LIMITS.headerWait); // only until the headers arrive
    let r;
    try {
      // No credentials of any kind: the link itself is the (presigned) authorization.
      r = await fetch(u.href, { redirect: 'manual', signal: ctl.signal, headers: { accept: CANVA_FILE_TYPES.join(', ') } });
    } catch {
      throw new CanvaError('Couldn’t download the file from Canva — try again.', 502);
    } finally { clearTimeout(timer); }
    const fail = async (msg) => { await r.body?.cancel().catch(() => {}); return new CanvaError(msg, 502); };
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      const err = await fail('Canva’s download link pointed somewhere else — import the design again.');
      if (!loc) throw err;
      try { u = checkCanvaFileUrl(new URL(loc, u).href); } catch { throw err; } // a hop may only stay on the export host
      continue;
    }
    if (!r.ok) {
      throw await fail([401, 403, 404, 410].includes(r.status) ? 'The Canva download link has expired — import the design again.' : `Downloading from Canva failed (${r.status}) — try again.`);
    }
    if (!r.body) throw await fail('Canva sent an empty file.');
    const lenHeader = r.headers.get('content-length');
    const declared = lenHeader != null && /^\d+$/.test(lenHeader.trim()) ? Number(lenHeader) : null;
    if (declared === 0) throw await fail('Canva sent an empty file.');
    if (declared != null && declared > max) throw await fail(`The file from Canva is larger than ${Math.round(max / 1048576)} MB.`);
    let type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const reader = r.body.getReader();
    let head = new Uint8Array(0);
    if (!CANVA_FILE_TYPES.includes(type)) {
      if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
        await reader.cancel().catch(() => {});
        throw new CanvaError('Canva sent a file that isn’t a PNG, JPEG or MP4.', 502);
      }
      // Generic label: look at the first bytes instead.
      while (head.length < 12) {
        const { done, value } = await reader.read();
        if (done) break;
        const joined = new Uint8Array(head.length + value.byteLength);
        joined.set(head); joined.set(value, head.length);
        head = joined;
      }
      type = sniffCanvaFile(head);
      if (!type || head.length > max) {
        await reader.cancel().catch(() => {});
        throw new CanvaError(type ? `The file from Canva is larger than ${Math.round(max / 1048576)} MB.` : 'Canva sent a file that isn’t a PNG, JPEG or MP4.', 502);
      }
    }
    // Pass the bytes through, stopping the download as soon as it goes past the size limit.
    let size = head.length;
    const body = new ReadableStream({
      start(c) { if (head.length) c.enqueue(head); },
      async pull(c) {
        let step;
        try { step = await reader.read(); } catch (err) { c.error(err); return; }
        if (step.done) { if (size) c.close(); else c.error(new CanvaError('Canva sent an empty file.', 502)); return; } // headers are already out: the client rejects the empty body too
        size += step.value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => {});
          c.error(new CanvaError(`The file from Canva is larger than ${Math.round(max / 1048576)} MB.`, 502));
          return;
        }
        c.enqueue(step.value);
      },
      cancel(reason) { return reader.cancel(reason).catch(() => {}); },
    });
    const headers = { 'content-type': type, 'cache-control': 'private, no-store' };
    if (declared != null) headers['content-length'] = String(declared);
    return new Response(body, { status: 200, headers });
  }
  throw new CanvaError('Canva’s download link redirected too many times.', 502);
}

const SERVICES = { gmail, gcal, gdrive, canva, slack, github, stripe, cloudflare, railway };

export async function toolStatus(env) {
  const services = {};
  for (const [name, svc] of Object.entries(SERVICES)) services[name] = Boolean(await svc.ready(env));
  services.gmailConfigured = gmail.ready(env);
  services.gmailAccounts = services.gmailConfigured ? (await googleAccounts(env)).map((a) => a.email) : [];
  if (services.gmail) services.gmail = services.gmailAccounts.length > 0;
  services.canvaConfigured = canvaConfigured(env);
  services.canvaAccounts = services.canvaConfigured ? await canvaAccountList(env) : [];
  services.githubAccounts = services.github ? (await tokenAccounts(env, 'github')).map(({ id, label, source }) => ({ id, label, source })) : [];
  services.cloudflareAccounts = services.cloudflare ? (await tokenAccounts(env, 'cloudflare')).map(({ id, label, source }) => ({ id, label, source })) : [];
  return services;
}

export async function toolList(env) {
  const status = await toolStatus(env);
  const list = [];
  for (const [name, svc] of Object.entries(SERVICES)) {
    if (!status[name]) continue;
    const note = ['gmail', 'gcal', 'gdrive'].includes(name) ? ` Connected Google accounts: ${status.gmailAccounts.join(', ')} (default: ${status.gmailAccounts[0]}).`
      : name === 'canva' ? ` Connected Canva accounts: ${status.canvaAccounts.map((x) => x.label).join(', ')} (default: ${status.canvaAccounts[0]?.label}).`
      : name === 'github' ? ` Connected GitHub accounts: ${status.githubAccounts.map((x) => x.label).join(', ')}.`
      : name === 'cloudflare' ? ` Connected Cloudflare accounts: ${status.cloudflareAccounts.map((x) => x.label).join(', ')}.` : '';
    for (const [tool, t] of Object.entries(svc.tools)) {
      list.push({
        type: 'function',
        function: { name: tool, description: (t.write ? `${t.desc} [needs the user's approval]` : t.desc) + note, parameters: t.params },
        'x-write': Boolean(t.write), 'x-label': t.label, 'x-service': name,
      });
    }
  }
  return { services: status, list };
}

export async function runTool(env, name, args, approved) {
  for (const [svcName, svc] of Object.entries(SERVICES)) {
    const t = svc.tools[name];
    if (!t) continue;
    if (!(await svc.ready(env))) return { ok: false, error: `${svcName} is not connected.` };
    if (t.write && approved !== true) return { ok: false, error: 'This action needs the user\'s approval in the app.' };
    try {
      return { ok: true, result: await t.run(env, args || {}) };
    } catch (err) {
      return { ok: false, error: err instanceof ToolError ? err.message : `${name} failed: ${err.message}` };
    }
  }
  return { ok: false, error: `Unknown tool ${name}` };
}

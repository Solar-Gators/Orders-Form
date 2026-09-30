/**
 * send-notifications — delivers queued messages from notification_outbox.
 *
 * The database queues a message whenever a request moves through the workflow
 * (see migration 010). The website calls this function right after each action,
 * and Admin → Notifications has a "Send now" button; each run sends everything
 * that's waiting and retries earlier failures (up to 5 tries).
 *
 * Secrets (Supabase → Edge Functions → Secrets). Set what you use:
 *   FLOW_URL     Power Automate "When a Teams webhook request is received" URL.
 *                Used for Teams messages, and for email too when SMTP isn't set
 *                (the flow sends it from Outlook).
 *   SMTP_USER    Gmail address that sends the emails, e.g. solargators.orders@gmail.com
 *   SMTP_PASS    That account's 16-letter Google "app password".
 *   SMTP_HOST / SMTP_PORT / SMTP_FROM_NAME   optional (smtp.gmail.com / 465 / team name).
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
 *
 * Deploy: see docs/MAINTAINING.md → "Email & Teams notifications".
 * This file has no imports at the top so it can also be loaded by the Node tests.
 */

type Row = {
  id: number;
  event: string;
  request_id: string | null;
  email: string;
  channel: 'email' | 'teams';
  payload: Record<string, unknown>;
};
type Template = { subject: string; body: string };
export type Message = { subject: string; lines: string[]; link: string; linkLabel: string; facts: [string, string][] };

const FALLBACK: Record<string, Template> = {
  submitted: { subject: '{request_number} needs your approval', body: '{requester} submitted "{title}": {total} from {vendor}.' },
  approved: { subject: '{request_number} was approved', body: '"{title}" was approved by {approver}.' },
  ready_to_order: { subject: '{request_number} is ready to order', body: '"{title}" ({total} from {vendor}) is ready to order.' },
  changes_requested: { subject: '{request_number}: changes requested', body: '{approver} asked for changes to "{title}":\n{comment}' },
  rejected: { subject: '{request_number} was rejected', body: '{approver} rejected "{title}":\n{comment}' },
  ordered: { subject: '{request_number} has been ordered', body: '"{title}" has been ordered.\nOrder / ticket number: {ticket}' },
  received: { subject: '{request_number} has arrived', body: '"{title}" was marked received.' },
  test: {
    subject: 'Test message from the order form',
    body: 'Hi {first_name}, notifications are working. You will get messages like this when requests need you or change status.',
  },
};

const money = (n: unknown) =>
  Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';

/** Placeholder values for a queued message. */
export function placeholders(payload: Record<string, unknown>, siteUrl: string): Record<string, string> {
  const s = (k: string) => (payload[k] == null ? '' : String(payload[k]).trim());
  const base = siteUrl ? siteUrl.replace(/#.*$/, '').replace(/\/?$/, '/') : '';
  return {
    request_number: s('request_number'),
    title: s('title'),
    requester: s('requester'),
    status: s('status'),
    season: s('season'),
    total: payload.total == null ? '' : money(payload.total),
    vendor: s('vendor'),
    comment: s('comment'),
    approver: s('approver'),
    ticket: s('ticket'),
    rule: s('rule'),
    recipient_name: s('recipient_name'),
    first_name: s('recipient_name').split(/\s+/)[0] || 'there',
    link: base && s('request_number') ? `${base}#/requests/${encodeURIComponent(s('request_number'))}` : base,
  };
}

/**
 * Fill {placeholders}. A line whose placeholders all came out empty is dropped
 * (so "Comment: {comment}" disappears when there's no comment).
 */
export function fill(template: string, values: Record<string, string>): string {
  return String(template || '')
    .split('\n')
    .filter((line) => {
      const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k in values);
      return !keys.length || keys.some((k) => values[k] !== '');
    })
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)))
    .join('\n')
    .trim();
}

export function render(row: Pick<Row, 'event' | 'payload'>, settings: Record<string, any>): Message {
  const values = placeholders(row.payload || {}, settings?.siteUrl || '');
  const t: Template = { ...FALLBACK[row.event], ...(settings?.templates?.[row.event] || {}) };
  const facts: [string, string][] = (
    [
      ['Request', values.request_number],
      ['Title', values.title],
      ['Requester', values.requester],
      ['Total', values.total],
      ['Vendor', values.vendor],
      ['Status', values.status],
    ] as [string, string][]
  ).filter(([, v]) => v);
  return {
    subject: fill(t.subject || '{request_number}', values).split('\n')[0] || 'Order form',
    lines: fill(t.body || '', values).split('\n').filter(Boolean),
    link: values.link,
    linkLabel: values.request_number ? `Open ${values.request_number}` : 'Open the order form',
    facts: row.event === 'test' ? [] : facts,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function emailHtml(m: Message, teamName = 'Solar Gators'): string {
  const facts = m.facts
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2937;max-width:560px">
${m.lines.map((l) => `<p style="margin:0 0 10px">${escapeHtml(l)}</p>`).join('\n')}
${facts ? `<table style="border-collapse:collapse;margin:12px 0;font-size:14px">${facts}</table>` : ''}
${m.link ? `<p style="margin:18px 0"><a href="${escapeHtml(m.link)}" style="background:#f26b1d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(m.linkLabel)}</a></p>` : ''}
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">${escapeHtml(teamName)} order form. You can turn these messages off on your Account page.</p>
</div>`;
}

export function emailText(m: Message): string {
  return [...m.lines, '', ...m.facts.map(([k, v]) => `${k}: ${v}`), '', m.link ? `${m.linkLabel}: ${m.link}` : '']
    .join('\n')
    .trim();
}

/** Adaptive card for Teams. */
export function teamsCard(m: Message) {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: m.subject, weight: 'Bolder', size: 'Medium', wrap: true },
      ...m.lines.map((text) => ({ type: 'TextBlock', text, wrap: true, spacing: 'Small' })),
      ...(m.facts.length ? [{ type: 'FactSet', facts: m.facts.map(([title, value]) => ({ title, value })) }] : []),
    ],
    actions: m.link ? [{ type: 'Action.OpenUrl', title: m.linkLabel, url: m.link }] : [],
  };
}

/**
 * What's POSTed to the Power Automate flow. `type`/`attachments` is the shape
 * Teams webhook flows expect; the rest is for the "who / which channel" steps.
 */
export function flowPayload(row: Pick<Row, 'email' | 'channel'>, m: Message, teamName = 'Solar Gators') {
  const card = teamsCard(m);
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
    channel: row.channel,
    recipient: row.email,
    subject: m.subject,
    text: emailText(m),
    html: emailHtml(m, teamName),
    link: m.link,
    card: JSON.stringify(card),
  };
}

// ---------------------------------------------------------------------------

async function sendViaFlow(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Power Automate answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

let transport: any = null;
async function sendViaSmtp(env: (k: string) => string | undefined, to: string, m: Message, teamName: string) {
  if (!transport) {
    const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
    const port = Number(env('SMTP_PORT') || 465);
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST') || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: (env('SMTP_PASS') || '').replace(/\s+/g, '') },
    });
  }
  await transport.sendMail({
    from: { name: env('SMTP_FROM_NAME') || `${teamName} Orders`, address: env('SMTP_USER')! },
    to,
    subject: m.subject,
    text: emailText(m),
    html: emailHtml(m, teamName),
  });
}

async function handle(req: Request): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // @ts-ignore Deno global
  const env = (k: string): string | undefined => Deno.env.get(k);
  const url = env('SUPABASE_URL')!;
  const key = env('SUPABASE_SERVICE_ROLE_KEY')!;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rest = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

  const [[notif], [general]] = await Promise.all([
    rest('app_settings?key=eq.notifications&select=value'),
    rest('app_settings?key=eq.general&select=value'),
  ]);
  const settings = notif?.value || {};
  const teamName = general?.value?.teamName || 'Solar Gators';
  const flowUrl = env('FLOW_URL');
  const smtp = env('SMTP_USER') && env('SMTP_PASS');

  const results = { sent: 0, failed: 0, errors: [] as string[] };
  for (let round = 0; round < 10; round++) {
    const rows: Row[] = await rest('rpc/claim_notifications', { method: 'POST', body: JSON.stringify({ p_limit: 25 }) });
    if (!rows.length) break;
    for (const row of rows) {
      let error = '';
      try {
        const m = render(row, settings);
        if (row.channel === 'email' && smtp) await sendViaSmtp(env, row.email, m, teamName);
        else if (flowUrl) await sendViaFlow(flowUrl, flowPayload(row, m, teamName));
        else throw new Error(row.channel === 'email' ? 'Email isn\'t set up: add SMTP_USER and SMTP_PASS (or FLOW_URL).' : 'Teams isn\'t set up: add FLOW_URL.');
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await rest('rpc/finish_notification', { method: 'POST', body: JSON.stringify({ p_id: row.id, p_ok: !error, p_error: error }) });
      if (error) {
        results.failed++;
        if (!results.errors.includes(error)) results.errors.push(error);
      } else results.sent++;
    }
  }
  return new Response(JSON.stringify(results), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// @ts-ignore Deno global (absent when the tests import this file in Node)
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req).catch((err) =>
  new Response(JSON.stringify({ error: String(err?.message || err) }), {
    status: 500,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  })));

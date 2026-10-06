/**
 * Approval rules and budgets (Admin → Workflow), shared by the pages that show
 * who needs to approve and how much budget is left. The database enforces the
 * same rules (migration 010); this module only explains them.
 */
import { auth } from './auth.js';
import { STATUS } from './ui.js';

export const RULE_TYPES = [
  { key: 'any', label: 'Any Chief Engineer', hint: 'Anyone with "Approve requests".' },
  { key: 'people', label: 'Specific people', hint: 'Only the people you pick (Admins can step in).' },
  { key: 'auto', label: 'Approve automatically', hint: 'Skips review. Budgets that block still apply.' },
];

/** Notification events, who gets them, and the placeholders their templates can use. */
export const EVENTS = [
  { key: 'submitted', label: 'Submitted', who: 'Whoever needs to approve it' },
  { key: 'approved', label: 'Approved', who: 'The requester' },
  { key: 'ready_to_order', label: 'Ready to order', who: 'Everyone with "Order & receive"' },
  { key: 'changes_requested', label: 'Changes requested', who: 'The requester' },
  { key: 'rejected', label: 'Rejected', who: 'The requester' },
  { key: 'ordered', label: 'Ordered', who: 'The requester' },
  { key: 'received', label: 'Received', who: 'The requester' },
  { key: 'request_update', label: 'Watched request changed', who: 'People watching the request (not the requester)' },
  { key: 'sponsor_update', label: 'Sponsor card updated', who: 'People watching the card (Sponsors board)' },
];
export const PLACEHOLDERS = [
  ['request_number', 'e.g. SG26-014'],
  ['title', 'Request title'],
  ['requester', 'Who asked for it'],
  ['first_name', "Recipient's first name"],
  ['total', 'Total with shipping'],
  ['vendor', 'Vendor'],
  ['approver', 'Who approved / reviewed'],
  ['comment', "Reviewer's comment"],
  ['ticket', 'Order / ticket number'],
  ['status', 'New status'],
  ['rule', 'Approval rule used'],
  ['link', 'Link to the request (or sponsor card)'],
  ['sponsor', 'Sponsors board: the sponsor\'s name'],
  ['stage', 'Sponsors board: the card\'s stage'],
  ['what', 'Sponsors board: what happened, e.g. "moved from In talks to Committed"'],
  ['actor', 'Sponsors board: who did it'],
];

export const workflowSettings = (config) => ({
  rules: Array.isArray(config.workflow?.rules) ? config.workflow.rules : [],
  budgets: { field: '', amounts: {}, block: false, ...(config.workflow?.budgets || {}) },
});

/**
 * Where a Submitted request stands:
 *   { type, rule, people, needAll, approvedBy: [ids], waitingOn: [ids] | null (= any CE) }
 */
export function approvalState(request) {
  const plan = request.approval_plan || { type: 'any' };
  const since = plan.submitted_at || '';
  const approvedBy = [
    ...new Set(
      (request.approvals || []).filter((a) => a.decision === 'approve' && a.approver_id && (!since || a.created_at >= since)).map((a) => a.approver_id)
    ),
  ];
  const people = plan.type === 'people' ? plan.people || [] : [];
  return {
    type: plan.type || 'any',
    rule: plan.rule || '',
    people,
    needAll: !!plan.needAll,
    approvedBy,
    waitingOn: plan.type === 'people' ? (plan.needAll ? people.filter((p) => !approvedBy.includes(p)) : people) : null,
  };
}

/** Can the signed-in person approve / reject this request? (The database checks too.) */
export function canReview(request) {
  const s = approvalState(request);
  if (s.type === 'people') return s.people.includes(auth.user?.id) || auth.can('workflow.edit');
  return auth.can('request.review');
}

/** Is this Submitted request waiting on the signed-in person? */
export function waitingOnMe(request) {
  if (request.status !== STATUS.SUBMITTED) return false;
  const s = approvalState(request);
  if (s.type === 'people') return s.waitingOn.includes(auth.user?.id);
  return auth.can('request.review');
}

/** A request's answer to a field: built-in at the top level, custom in `data`. */
const answer = (r, key) => String(r?.[key] ?? r?.data?.[key] ?? '').trim();

/**
 * Budget use for the current season: one row per budgeted value,
 * { value, amount, used, pending, remaining, over }. `used` counts Approved,
 * Ordered and Received requests, plus purchases the Treasurer logged on their own
 * (Finances → Purchases; cancelled ones don't count); `pending` is what's waiting
 * for approval. Same rule as the database's over-budget check.
 */
export function budgetSummary(config, requests, purchases = []) {
  const { field, amounts } = workflowSettings(config).budgets;
  if (!field) return [];
  const spent = [STATUS.APPROVED, STATUS.ORDERED, STATUS.RECEIVED];
  const inSeason = requests.filter((r) => !r.season || !config.season || r.season === config.season);
  return Object.entries(amounts || {})
    .filter(([, amount]) => amount !== '' && Number.isFinite(Number(amount)))
    .map(([value, amount]) => {
      const mine = inSeason.filter((r) => answer(r, field).toLowerCase() === value.toLowerCase());
      const sum = (rows) => rows.reduce((s, r) => s + (r.total || 0), 0);
      const own = (purchases || []).filter(
        (p) => !p.request_id && p.dept_status !== 'cancelled' && (!config.season || p.season === config.season)
          && String(p.category || '').trim().toLowerCase() === value.toLowerCase()
      );
      const used = sum(mine.filter((r) => spent.includes(r.status))) + own.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const pending = sum(mine.filter((r) => r.status === STATUS.SUBMITTED));
      return { value, amount: Number(amount), used, pending, remaining: Number(amount) - used, over: used > Number(amount) };
    });
}

/** The budget row this request counts against, or null. */
export function budgetFor(config, request, summary) {
  const { field } = workflowSettings(config).budgets;
  if (!field) return null;
  const v = answer(request, field).toLowerCase();
  return summary.find((b) => b.value.toLowerCase() === v) || null;
}

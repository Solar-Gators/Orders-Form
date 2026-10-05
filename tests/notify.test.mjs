/**
 * Message rendering for the send-notifications Edge Function (email + Teams).
 * Node runs the TypeScript file directly (type stripping, Node 22.18+).
 */
import assert from 'node:assert/strict';
import { fill, render, emailHtml, emailText, flowPayload, placeholders } from '../supabase/functions/send-notifications/index.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

const payload = {
  request_number: 'SG26-014', title: 'Steering hardware', requester: 'Austin Stang', total: 1234.5,
  vendor: 'McMaster-Carr', comment: '', approver: 'Griffin York', ticket: '', recipient_name: 'Mia Member', status: 'Approved',
};
const settings = {
  siteUrl: 'https://solar-gators.github.io/Orders-Form/',
  templates: { approved: { subject: '{request_number} was approved', body: 'Hi {first_name}, "{title}" was approved by {approver}.\nComment: {comment}' } },
};

console.log('Notifications');

test('placeholders: money, first name, link to the request', () => {
  const v = placeholders(payload, 'https://solar-gators.github.io/Orders-Form');
  assert.equal(v.total, '$1,234.50');
  assert.equal(v.first_name, 'Mia');
  assert.equal(v.link, 'https://solar-gators.github.io/Orders-Form/#/requests/SG26-014');
  assert.equal(placeholders({}, '').link, '');
});

test('lines whose placeholders are all empty are dropped; unknown ones are left alone', () => {
  const v = placeholders(payload, '');
  assert.equal(fill('A {title}\nComment: {comment}\n{nope}', v), 'A Steering hardware\n{nope}');
  assert.equal(fill('Ticket {ticket}, total {total}', v), 'Ticket , total $1,234.50'); // one filled → kept
});

test('render uses the saved template, falling back to the built-in one', () => {
  const m = render({ event: 'approved', payload }, settings);
  assert.equal(m.subject, 'SG26-014 was approved');
  assert.deepEqual(m.lines, ['Hi Mia, "Steering hardware" was approved by Griffin York.']);
  assert.equal(m.linkLabel, 'Open SG26-014');
  assert.deepEqual(m.facts.find(([k]) => k === 'Total'), ['Total', '$1,234.50']);
  const fallback = render({ event: 'ordered', payload: { ...payload, ticket: 'PO-9' } }, {});
  assert.equal(fallback.subject, 'SG26-014 has been ordered');
  assert.match(fallback.lines.join('\n'), /PO-9/);
  assert.equal(render({ event: 'test', payload: { recipient_name: 'Ada Admin' } }, {}).facts.length, 0);
});

test('email HTML escapes what people typed', () => {
  const m = render({ event: 'approved', payload: { ...payload, title: '<script>x</script> & bolts' } }, settings);
  const html = emailHtml(m);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; &amp; bolts/);
  assert.match(html, /href="https:\/\/solar-gators\.github\.io\/Orders-Form\/#\/requests\/SG26-014"/);
  assert.match(emailText(m), /Open SG26-014: https:/);
});

test('Power Automate payload: recipient, channel and an adaptive card', () => {
  const body = flowPayload({ email: 'member@ufl.edu', channel: 'teams' }, render({ event: 'approved', payload }, settings));
  assert.equal(body.recipient, 'member@ufl.edu');
  assert.equal(body.channel, 'teams');
  assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const card = body.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.actions[0].url, 'https://solar-gators.github.io/Orders-Form/#/requests/SG26-014');
  assert.deepEqual(JSON.parse(body.card), card);
});

test('Sponsors board messages link to the card and list sponsor facts', () => {
  const m = render(
    { event: 'sponsor_update', payload: { sponsor: 'Acme Aerospace', stage: 'Committed', what: 'moved from In talks to Committed', actor: 'Cora Coordinator', kind: 'Sponsorship', amount: 2500, path: '/sponsors/abc-123' } },
    settings
  );
  assert.equal(m.subject, 'Acme Aerospace: moved from In talks to Committed');
  assert.equal(m.link, 'https://solar-gators.github.io/Orders-Form/#/sponsors/abc-123');
  assert.equal(m.linkLabel, 'Open on the Sponsors board');
  assert.deepEqual(m.facts, [['Sponsor', 'Acme Aerospace'], ['Stage', 'Committed'], ['Type', 'Sponsorship'], ['Amount', '$2,500.00']]);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

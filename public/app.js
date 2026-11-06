// Plain JS, no framework. Every piece of text goes through textContent, never innerHTML,
// because issue titles, plans and emails can contain vendor-written text.

const view = document.getElementById('view');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const TYPE_LABEL = {
  duplicate_invoice: 'Duplicate invoice',
  match_exception: 'Match exception',
  discount_expiring: 'Discount expiring',
  bank_change_request: 'Bank-detail change',
  suspicious_message: 'Suspicious email',
};
const TRANSPORT_LABEL = { 'claude-code': 'Claude Code', 'messages-api': 'Messages API', replay: 'replay' };
const OUTCOME_LABEL = { act: 'Act', hold_and_ask: 'Hold and ask', no_action: 'No action' };

const fields = (pairs) => h('dl', { class: 'fields' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

function table(head, rows, numeric = []) {
  return h('table', {},
    h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { class: numeric.includes(i) ? 'num' : '' }, c)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : '' }, c))))));
}

// ---- header ---------------------------------------------------------------

async function refreshHeader() {
  const [{ data: state }, { data: approvals }] = await Promise.all([api('/api/state'), api('/api/approvals')]);
  document.getElementById('context').textContent = `Quillfeather Provisions · payment run ${state.business_date} · next run ${state.next_run_date}`;
  document.getElementById('pending-count').textContent = approvals.pending.length || '';
  const banner = document.getElementById('banner');
  const notes = [];
  notes.push(state.mode === 'live' ? 'Live mode: issues without a recording are investigated in the background.' : 'Replay mode: recorded agent runs are re-checked with current code. No API key needed.');
  if (state.investigating.length) notes.push(`Investigating ${state.investigating.length} issue(s)…`);
  if (state.extraction_missing.length) notes.push(`${state.extraction_missing.length} email(s) have no extraction yet.`);
  banner.textContent = notes.join(' ');
  banner.hidden = false;
  return state;
}

// ---- queue ----------------------------------------------------------------

async function renderQueue() {
  const { data: issues } = await api('/api/issues');
  view.replaceChildren(
    h('h1', {}, 'Issues before this payment run'),
    h('p', { class: 'muted' }, 'Found by deterministic rules, ranked by money at risk, deadline and trust flags. Open one to see the copilot’s decision.'),
    h('div', { class: 'panel' },
      h('table', {},
        h('thead', {}, h('tr', {}, ['Score', 'Type', 'Issue', 'At risk', 'Deadline', 'Status'].map((c, i) => h('th', { class: [0, 3].includes(i) ? 'num' : '' }, c)))),
        h('tbody', {}, issues.map((i) =>
          h('tr', { class: 'row', onclick: () => (location.hash = `#/issues/${i.issue_id}`) },
            h('td', { class: 'num', title: i.ranking.explanation }, i.ranking.score.toFixed(1)),
            h('td', {}, h('span', { class: 'chip' }, TYPE_LABEL[i.type])),
            h('td', {}, h('a', { href: `#/issues/${i.issue_id}` }, i.title), h('div', { class: 'ranking' }, i.ranking.explanation)),
            h('td', { class: 'num' }, i.money_at_risk),
            h('td', { class: 'nowrap' }, i.deadline),
            h('td', {}, h('span', { class: `chip ${i.status === 'run failed' ? 'failed' : i.status}` }, OUTCOME_LABEL[i.status] ?? i.status),
              i.pending_actions ? h('div', { class: 'small muted' }, `${i.pending_actions} action(s) to review`) : null)))))));
}

// ---- issue ----------------------------------------------------------------

function documentCard(a, onDone) {
  const notice = h('div', { class: 'notice' });
  const decide = async (kind) => {
    const body = { payload_hash: a.payload_hash };
    if (kind === 'reject') body.reason = 'Rejected in review';
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    const { ok, data } = await api(`/api/actions/${a.action_id}/${kind}`, body);
    if (ok) return onDone();
    notice.className = 'notice bad';
    notice.replaceChildren(`Refused: ${data.refused ?? data.error}`, data.problems ? h('ul', { class: 'plain' }, data.problems.map((p) => h('li', {}, p))) : '');
    for (const b of card.querySelectorAll('button')) b.disabled = false;
  };
  const card = h('div', { class: 'panel' },
    h('h3', {}, a.document.title, ' ', h('span', { class: `chip ${a.status}` }, a.status)),
    fields(a.document.fields),
    a.document.body ? h('pre', {}, a.document.body) : null,
    h('div', { class: 'hash', title: 'Approving sends this hash; the server refuses it if the stored payload differs.' }, `payload ${a.payload_hash.slice(0, 16)}…`),
    a.status === 'proposed'
      ? h('div', { class: 'actions-row' },
          h('button', { class: 'primary', onclick: () => decide('approve') }, 'Approve and send'),
          h('button', { onclick: () => decide('reject') }, 'Reject'))
      : null,
    notice);
  return card;
}

function evidenceCard(c) {
  return h('div', { class: 'panel' },
    h('h3', {}, c.title),
    c.flags && c.flags.length ? h('div', {}, c.flags.map((f) => h('span', { class: 'chip flag', title: f.detail }, f.flag))) : null,
    fields(c.fields),
    c.table ? table(c.table.head, c.table.rows) : null,
    c.text ? h('pre', { class: 'untrusted', title: 'Untrusted email text' }, c.text) : null);
}

async function renderIssue(id) {
  const { ok, data } = await api(`/api/issues/${encodeURIComponent(id)}`);
  if (!ok) return view.replaceChildren(h('p', {}, 'No such issue. ', h('a', { href: '#/' }, 'Back to the queue')));
  const { issue, run, plan, actions, evidence } = data;

  const decision = !run
    ? h('div', { class: 'panel muted' }, 'Not investigated yet. Recorded runs replay without a key; with ANTHROPIC_API_KEY set, the copilot investigates live.')
    : run.status === 'failed'
      ? h('div', { class: 'panel' }, h('span', { class: 'chip failed' }, 'Run failed'), h('p', {}, run.failure))
      : h('div', { class: 'panel' },
          h('span', { class: `chip ${plan.outcome}` }, OUTCOME_LABEL[plan.outcome]),
          h('p', {}, plan.summary),
          h('p', { class: 'muted' }, plan.rationale),
          plan.open_questions.length ? h('div', {}, h('h3', {}, 'Open questions'), h('ul', { class: 'plain' }, plan.open_questions.map((q) => h('li', {}, q)))) : null);

  view.replaceChildren(
    h('p', { class: 'small' }, h('a', { href: '#/' }, '← Queue')),
    h('h1', {}, issue.title),
    h('p', { class: 'muted' }, `${TYPE_LABEL[issue.type]} · ${issue.vendor} · ${issue.money_at_risk} at risk · deadline ${issue.deadline}`),
    h('p', { class: 'ranking' }, `Why it ranks here: ${issue.ranking.explanation}`),

    h('h2', {}, 'Decision'), decision,

    plan ? h('h2', {}, 'Options compared') : null,
    plan ? h('div', { class: 'grid two' }, plan.options.map((o) =>
      h('div', { class: `option ${o.chosen ? 'chosen' : ''}` }, h('h3', {}, o.description, o.chosen ? ' · chosen' : ''), h('div', { class: 'small muted' }, o.consequences)))) : null,

    actions.length ? h('h2', {}, 'Actions to approve (exact documents)') : null,
    actions.length ? h('div', { class: 'grid' }, actions.map((a) => documentCard(a, () => route()))) : null,

    h('h2', {}, 'Evidence'),
    h('div', { class: 'grid two' }, evidence.map(evidenceCard)),

    run ? h('h2', {}, 'How the copilot got here') : null,
    run ? h('p', { class: 'small muted' }, [
      run.mode === 'replay' ? 'Replayed recording' : 'Live run',
      `${run.model} via ${TRANSPORT_LABEL[run.transport] ?? run.transport}`,
      `${run.tool_calls} tool calls`,
      run.cost_usd === null ? 'cost n/a' : `${run.cost_estimated ? 'est. ' : ''}$${run.cost_usd.toFixed(4)}`,
      `${(run.duration_ms / 1000).toFixed(1)} s`,
    ].join(' · ')) : null,
    run ? h('div', { class: 'panel trail' }, table(['#', 'Tool', 'Input', 'Result'], run.trail.map((t, i) => [String(i + 1), t.tool, h('code', {}, t.input), t.result]))) : null,
  );
}

// ---- approvals ------------------------------------------------------------

async function renderApprovals() {
  const { data } = await api('/api/approvals');
  view.replaceChildren(
    h('h1', {}, 'Approvals'),
    h('p', { class: 'muted' }, 'Each action is approved on its own, against the exact payload shown. Sending is simulated: approved actions land in the outbox below and nothing leaves this machine.'),
    h('h2', {}, `Waiting for review (${data.pending.length})`),
    data.pending.length
      ? h('div', { class: 'grid' }, data.pending.map((a) => h('div', {}, h('div', { class: 'small' }, h('a', { href: `#/issues/${a.issue_id}` }, a.issue_title)), documentCard(a, () => route()))))
      : h('p', { class: 'muted' }, 'Nothing waiting.'),
    h('h2', {}, `Outbox (${data.outbox.length})`),
    data.outbox.length
      ? h('div', { class: 'grid' }, data.outbox.map((o) => h('div', { class: 'panel' }, h('h3', {}, o.document.title), h('div', { class: 'small muted' }, `${o.kind} · ${o.at} · ${o.action_id}`), fields(o.document.fields), o.document.body ? h('pre', {}, o.document.body) : null)))
      : h('p', { class: 'muted' }, 'Empty.'),
    h('h2', {}, 'Activity'),
    h('div', { class: 'panel' }, table(['When', 'Who', 'Event', 'Detail'], data.activity.map((a) => [a.at.slice(0, 19).replace('T', ' '), a.actor.replace(/^session:(.{8}).*/, 'reviewer $1'), a.event, h('code', {}, a.detail)]))),
  );
}

// ---- routing --------------------------------------------------------------

async function route() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', (a.dataset.nav === 'approvals') === hash.startsWith('#/approvals'));
  const state = await refreshHeader();
  const m = /^#\/issues\/(.+)$/.exec(hash);
  if (m) await renderIssue(decodeURIComponent(m[1]));
  else if (hash.startsWith('#/approvals')) await renderApprovals();
  else await renderQueue();
  if (state.investigating.length) setTimeout(route, 4000);
}

window.addEventListener('hashchange', route);
route();

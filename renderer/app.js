'use strict';

const el = (id) => document.getElementById(id);
const FREESPACE_COLOR = 'var(--track)';

function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

const LABELS = {
  fixedOverhead: '固定开销',
  messages: 'Messages',
  mcpTools: 'MCP tools',
  systemPrompt: 'System prompt',
  skills: 'Skills',
  customAgents: 'Custom agents',
  memoryFiles: 'Memory files',
  attachments: 'Attachments',
};

function makeRow({ label, value, share, color, hollow }) {
  const row = document.createElement('div');
  row.className = 'row';

  const dot = document.createElement('span');
  dot.className = hollow ? 'dot hollow' : 'dot';
  if (!hollow) dot.style.background = color;

  const name = document.createElement('span');
  name.className = 'label';
  name.textContent = label;
  name.title = label;

  const val = document.createElement('span');
  val.className = hollow ? 'value muted' : 'value';
  val.textContent = value;

  const pct = document.createElement('span');
  pct.className = 'share';
  pct.textContent = share;

  row.append(dot, name, val, pct);
  return row;
}

function renderBar(categories, freeSpace, total, limit) {
  const bar = el('bar');
  bar.textContent = '';
  const denominator = limit || total;
  for (const c of categories) {
    const seg = document.createElement('span');
    seg.style.width = `${(c.tokens / denominator) * 100}%`;
    seg.style.background = c.color;
    seg.title = `${LABELS[c.key] || c.key}: ${formatTokens(c.tokens)}`;
    bar.append(seg);
  }
  if (freeSpace > 0) {
    const seg = document.createElement('span');
    seg.style.width = `${(freeSpace / denominator) * 100}%`;
    seg.style.background = FREESPACE_COLOR;
    bar.append(seg);
  }
}

function renderSpark(series, limit) {
  const line = el('sparkLine');
  const area = el('sparkArea');
  if (!series || series.length < 2) {
    line.setAttribute('d', '');
    area.setAttribute('d', '');
    return;
  }
  const w = 240;
  const h = 28;
  const top = limit || Math.max(...series);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const points = series.map((v, i) => {
    const x = i * step;
    const y = h - (Math.min(v, top) / top) * (h - 3) - 1.5;
    return [x, y];
  });
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  line.setAttribute('d', d);
  area.setAttribute('d', `${d} L${w} ${h} L0 ${h} Z`);
}

function render(payload) {
  const empty = el('empty');

  if (!payload || payload.status !== 'ok') {
    empty.hidden = false;
    el('emptyText').textContent = (payload && payload.detail) || '等待 Antigravity 会话…';
    return;
  }
  empty.hidden = true;

  el('used').textContent = formatTokens(payload.total);
  el('limit').textContent = payload.limit ? formatTokens(payload.limit) : '?';

  const pctEl = el('pct');
  pctEl.textContent = payload.percent != null ? `${payload.percent.toFixed(1)}%` : '';
  pctEl.className = 'pct';
  if (payload.percent != null) {
    if (payload.percent >= 95) pctEl.classList.add('danger');
    else if (payload.percent >= 85) pctEl.classList.add('warn');
  }

  renderBar(payload.categories, payload.freeSpace, payload.total, payload.limit);

  const rows = el('rows');
  rows.textContent = '';
  for (const c of payload.categories) {
    rows.append(
      makeRow({
        label: LABELS[c.key] || c.key,
        value: formatTokens(c.tokens),
        share: `${c.percent.toFixed(1)}%`,
        color: c.color,
      })
    );
  }
  const pinned = el('pinned');
  pinned.textContent = '';
  if (payload.overBy > 0) {
    const row = makeRow({
      label: '已超出上限',
      value: `+${formatTokens(payload.overBy)}`,
      share: '等待压缩',
      color: '#d64545',
    });
    row.style.color = '#d64545';
    pinned.append(row);
  } else if (payload.freeSpace != null) {
    pinned.append(
      makeRow({
        label: 'Free space',
        value: formatTokens(payload.freeSpace),
        share: payload.limit ? `${((payload.freeSpace / payload.limit) * 100).toFixed(1)}%` : '',
        hollow: true,
      })
    );
  }

  renderSpark(payload.series, payload.limit);

  el('model').textContent = payload.model || '—';
  const parts = [];
  if (payload.compactionCount) parts.push(`已压缩 ${payload.compactionCount} 次`);
  parts.push('分项为估算');
  el('note').textContent = parts.join(' · ');
}

el('refresh').addEventListener('click', () => window.monitor.refresh());
el('hide').addEventListener('click', () => window.monitor.hide());
el('quit').addEventListener('click', () => window.monitor.quit());

window.monitor.onUpdate(render);

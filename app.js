/* daed-board — zashboard 风格的 daed 仪表盘
 * 纯原生 JS，无依赖。数据源：
 *  - daed GraphQL（地址在登录页/设置页配置，如 http://192.168.1.1:2023/graphql，daed 的 CORS 为全开放）
 *  - 出口记录：/cgi-bin/daed-board-log（路由器 uhttpd CGI，tail daed 日志）
 * 组实际出口以连接日志 dialer= 为真值；托管/钉选均带快照可一键还原。
 */
'use strict';

/* ================= 工具 ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtRate(bytesPerSec) {
  const bit = (Number(bytesPerSec) || 0) * 8;
  if (bit < 1000) return bit.toFixed(0) + ' bps';
  if (bit < 1e6) return (bit / 1e3).toFixed(1) + ' Kbps';
  if (bit < 1e9) return (bit / 1e6).toFixed(1) + ' Mbps';
  return (bit / 1e9).toFixed(2) + ' Gbps';
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000) | 0;
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return (s / 60 | 0) + ' 分前';
  if (s < 86400) return (s / 3600 | 0) + ' 时前';
  return (s / 86400 | 0) + ' 天前';
}
function hhmm(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function parseTime(tstr) {
  if (!tstr) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tstr)) return new Date(tstr.replace(' ', 'T')).getTime();
  const t = Date.parse(tstr);
  return isNaN(t) ? null : t;
}
async function fetchTimeout(url, opt = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, type === 'err' ? 5200 : 3200);
}

/* ================= 配置 / 状态 ================= */
const CFG_KEY = 'db.cfg', TOKEN_KEY = 'db.token', HIST_KEY = 'db.hist', MEMHIST_KEY = 'db.memhist';
const DEFAULT_CFG = {
  backend: '',   // 首次使用在登录页填写，如 http://192.168.1.1:2023（保存在浏览器）
  user: '', pass: '', remember: true,
  lowMs: 150, midMs: 350,
  groupSec: 30, logSec: 3, retestSec: 90,
  hideUnavail: false, sort: 'default',
  filterMult: 0.2, filterKw: '剩余,到期,过期,官网,官址,重置,套餐,流量,有效', showJunk: false,
};
function loadCfg() {
  try { return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY)) || {}) }; }
  catch { return { ...DEFAULT_CFG }; }
}
const S = {
  cfg: loadCfg(),
  token: localStorage.getItem(TOKEN_KEY) || '',
  groups: [],
  lat: new Map(),        // id -> {latencyMs, alive, testedAt, message}
  hist: new Map(),       // id -> [ms,...] 最近≤10 次测速值（面板自采样）
  histTs: new Map(),     // id -> 上次已入史的 testedAt
  general: null,
  ovBuf: [],             // [{ts, up, down}] 合并后的速率采样序列
  logEntries: [],
  recent: new Map(),     // outbound组 -> {raw, ts, entry}
  page: 'proxies',
  testing: new Set(),
  testingGroups: new Set(),
  subs: [], nodesAll: [],
  closedGroups: new Set(JSON.parse(localStorage.getItem('db.closed') || '[]')),
  filter: '', logFilter: '', logOb: '', nodeFilter: '', nodeSub: '', memAvailKB: null,
  lastTs: {}, inflight: new Set(),
  logCur: { inode: null, off: 0 },   // 3.2 出口记录增量游标：只放内存（多标签页天然隔离，重开页面走一次回填）
  authed: false,
};
function saveCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(S.cfg)); }
function saveHist() {
  const o = {};
  S.hist.forEach((v, k) => { o[k] = v.slice(-10); });
  localStorage.setItem(HIST_KEY, JSON.stringify(o));
}
(function loadHist() {
  try {
    const o = JSON.parse(localStorage.getItem(HIST_KEY)) || {};
    for (const k in o) if (Array.isArray(o[k])) S.hist.set(k, o[k].slice(-10));
  } catch {}
})();

/* ================= GraphQL ================= */
class AuthError extends Error {}
function jwtExp(tok) {
  try {
    const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (p.exp || 0) * 1000;
  } catch { return 0; }
}
function gqlUrl() { return S.cfg.backend.replace(/\/+$/, '') + '/graphql'; }
function setBanner(html) { const b = $('#banner'); if (!b) return; if (html) { b.innerHTML = html; b.hidden = false; } else b.hidden = true; }

async function gql(query, variables, timeoutMs = 30000) {
  if (!S.token) throw new AuthError('未登录');
  let r;
  try {
    r = await fetchTimeout(gqlUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': S.token },
      body: JSON.stringify({ query, variables }),
    }, timeoutMs);
  } catch (e) {
    setBanner('无法连接 daed 后端（' + esc(gqlUrl()) + '）：' + esc(e.name === 'AbortError' ? '超时' : e.message));
    throw e;
  }
  setBanner('');
  let j;
  try { j = await r.json(); } catch { throw new Error('后端响应不是 JSON（HTTP ' + r.status + '）'); }
  if (j.errors) {
    const msg = j.errors.map(e => e.message).join('; ');
    if (/permission denied|unauthorized|token/i.test(msg)) throw new AuthError(msg);
    throw new Error(msg);
  }
  return j.data;
}
async function login(user, pass) {
  const r = await fetchTimeout(gqlUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `{ token(username: ${JSON.stringify(user)}, password: ${JSON.stringify(pass)}) }` }),
  }, 10000);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  if (!j.data || !j.data.token) throw new Error('后端未返回 token');
  S.token = j.data.token;
  localStorage.setItem(TOKEN_KEY, S.token);
  S.authed = true;
  return S.token;
}

/* ---------- API（已在 api 层拆掉 GraphQL data 信封） ---------- */
/* 1.10 轮询合并：把 groups / nodeLatencies 的字段集抽出来，供概览页批量查询复用 */
const GROUPS_Q = `groups { id name policy policyParams { key val }
      nodes { id name address protocol tag subscriptionID }
      subscriptions { subscription { id tag } nameFilterRegex matchedCount matchedNodes { id name address protocol tag subscriptionID } } }`;
const LATS_Q = `nodeLatencies { id latencyMs alive testedAt message }`;

const api = {
  groups: async () => (await gql(`query { ${GROUPS_Q} }`)).groups,
  latencies: async ids => (await gql(`query($ids:[ID!]) { nodeLatencies(ids:$ids) { id latencyMs alive testedAt message } }`, { ids })).nodeLatencies,
  test: async ids => (await gql(`mutation($ids:[ID!]) { testNodeLatencies(ids:$ids) { id latencyMs alive testedAt message } }`, { ids }, 300000)).testNodeLatencies,
  /* 1.2 自适应窗口：缓冲不足时回填 10 分钟（240 点 ≈2.75s/点），
   * 稳态只取 2 分钟（60 点 ≈2.25s/点）——比改动前的固定 600/120（5.25s/点、10.4KB）更密且更省。
   * 1.10 withLatency=true 时把 groups + 全量 nodeLatencies 并进同一条查询（概览页每 30s 触发一次），
   * 于是"速率 / 分组 / 延迟"在同一个往返里原子返回，省一次 POST 与一次 CORS 预检。 */
  overview: async ({ backfill = false, withLatency = false } = {}) => {
    const win = backfill ? 600 : 120, mp = backfill ? 240 : 60;
    return gql(`query { general { dae { running modified version }
      interfaces { name flag { up } ip }
      runtimeOverview(windowSec: ${win}, maxPoints: ${mp}) { updatedAt uploadRate downloadRate uploadTotal downloadTotal activeConnections udpSessions samples { timestamp uploadRate downloadRate } } } ${withLatency ? GROUPS_Q + ' ' + LATS_Q : ''} }`);
  },
  general: async () => (await api.overview({ backfill: true })).general,
  nodesPage: () => gql(`query { nodes(first: 999) { totalCount edges { id name address protocol tag subscriptionID } }
      subscriptions { id tag link updatedAt status info cronExp cronEnable nodes(first: 999) { totalCount edges { id name address protocol tag subscriptionID } } } }`, null, 60000),
  selectedCfg: async () => (await gql(`query { configs(selected: true) { name global { dialMode checkInterval checkTolerance sniffingTimeout tcpCheckUrl logLevel } } }`)).configs,
  // 区域托管（组收缩/还原）
  delNodes: (id, ids) => gql(`mutation($id:ID!,$ids:[ID!]!){ groupDelNodes(id:$id, nodeIDs:$ids) }`, { id, ids }),
  addNodes: (id, ids) => gql(`mutation($id:ID!,$ids:[ID!]!){ groupAddNodes(id:$id, nodeIDs:$ids) }`, { id, ids }),
  delSubs: (id, ids) => gql(`mutation($id:ID!,$ids:[ID!]!){ groupDelSubscriptions(id:$id, subscriptionIDs:$ids) }`, { id, ids }),
  addSubs: (id, ids, regex) => gql(`mutation($id:ID!,$ids:[ID!]!,$re:String){ groupAddSubscriptions(id:$id, subscriptionIDs:$ids, nameFilterRegex:$re) }`, { id, ids, re: regex }),
  run: () => gql(`mutation { run(dry: false) }`),
  getStorage: async paths => (await gql(`query($p:[String!]){ jsonStorage(paths:$p) }`, { p: paths })).jsonStorage,
  setStorage: (paths, values) => gql(`mutation($p:[String!]!,$v:[String!]!){ setJsonStorage(paths:$p, values:$v) }`, { p: paths, v: values }),
  // 订阅/节点管理（P1）—— 均已在 api 层拆掉 GraphQL data 信封
  // 注意：SubscriptionImportResult 无顶层 error 字段（拉取失败走 GraphQL errors）；
  // NodeImportResult 才有 error。写错会 import 必败。
  importSub: async (link, tag) => (await gql(`mutation($rb:Boolean!,$arg:ImportArgument!){ importSubscription(rollbackError:$rb, arg:$arg){
      link sub { id tag status updatedAt info cronExp cronEnable nodes { totalCount } }
      nodeImportResult { link error node { id name } } } }`, { rb: false, arg: { link, tag } }, 120000)).importSubscription,
  updateSub: async id => (await gql(`mutation($id:ID!){ updateSubscription(id:$id){ id tag status updatedAt info nodes { totalCount } } }`, { id }, 120000)).updateSubscription,
  updateSubLink: async (id, link) => (await gql(`mutation($id:ID!,$link:String!){ updateSubscriptionLink(id:$id, link:$link){ id tag } }`, { id, link })).updateSubscriptionLink,
  updateSubCron: async (id, cronExp, cronEnable) => (await gql(`mutation($id:ID!,$e:String!,$en:Boolean!){ updateSubscriptionCron(id:$id, cronExp:$e, cronEnable:$en){ id cronExp cronEnable } }`, { id, e: cronExp, en: cronEnable })).updateSubscriptionCron,
  tagSub: async (id, tag) => (await gql(`mutation($id:ID!,$tag:String!){ tagSubscription(id:$id, tag:$tag) }`, { id, tag })).tagSubscription,
  removeSubs: async ids => (await gql(`mutation($ids:[ID!]!){ removeSubscriptions(ids:$ids) }`, { ids })).removeSubscriptions,
  importNodesBatch: async items => (await gql(`mutation($rb:Boolean!,$args:[ImportArgument!]!){ importNodes(rollbackError:$rb, args:$args){ link error node { id name } } }`, { rb: false, args: items }, 180000)).importNodes,
  removeNodesBatch: async ids => (await gql(`mutation($ids:[ID!]!){ removeNodes(ids:$ids) }`, { ids })).removeNodes,
  setPolicy: async (id, policy, policyParams) => (await gql(`mutation($id:ID!,$p:Policy!,$pp:[PolicyParam!]){ groupSetPolicy(id:$id, policy:$p, policyParams:$pp) }`, { id, p: policy, pp: policyParams })).groupSetPolicy,
  // 配置/DNS/路由（P2+P3）
  dnss: async () => (await gql(`query { dnss { id name selected dns { string } } }`)).dnss,
  routings: async () => (await gql(`query { routings { id name selected routing { string } } }`)).routings,
  parsedDns: async raw => (await gql(`query($raw:String!){ parsedDns(raw:$raw){ upstream { key val } } }`, { raw })).parsedDns,
  parsedRouting: async raw => (await gql(`query($raw:String!){ parsedRouting(raw:$raw){ rules { conditions { and { name not params { key val } } } } } }`, { raw })).parsedRouting,
  updateDns: async (id, dns) => (await gql(`mutation($id:ID!,$dns:String!){ updateDns(id:$id, dns:$dns){ id } }`, { id, dns })).updateDns,
  createDns: async (name, dns) => (await gql(`mutation($name:String,$dns:String!){ createDns(name:$name, dns:$dns){ id name } }`, { name, dns })).createDns,
  removeDns: async id => (await gql(`mutation($id:ID!){ removeDns(id:$id) }`, { id })).removeDns,
  selectDns: async id => (await gql(`mutation($id:ID!){ selectDns(id:$id) }`, { id })).selectDns,
  updateRouting: async (id, routing) => (await gql(`mutation($id:ID!,$routing:String!){ updateRouting(id:$id, routing:$routing){ id } }`, { id, routing })).updateRouting,
  createRouting: async (name, routing) => (await gql(`mutation($name:String,$routing:String!){ createRouting(name:$name, routing:$routing){ id name } }`, { name, routing })).createRouting,
  removeRouting: async id => (await gql(`mutation($id:ID!){ removeRouting(id:$id) }`, { id })).removeRouting,
  selectRouting: async id => (await gql(`mutation($id:ID!){ selectRouting(id:$id) }`, { id })).selectRouting,
  selectConfig: async id => (await gql(`mutation($id:ID!){ selectConfig(id:$id) }`, { id })).selectConfig,
  configsAll: async () => (await gql(`query { configs { id name selected global { ${GLOBAL_FIELDS.map(f => f[0]).join(' ')} } } }`)).configs,
  updateConfig: async (id, global) => (await gql(`mutation($id:ID!,$g:globalInput!){ updateConfig(id:$id, global:$g){ id } }`, { id, g: global })).updateConfig,
};

/* ================= 日志解析 =================
 * 示例行（已脱敏）：
 * [2026-09-06 12:00:00]  INFO 192.168.1.23:39978 <-> www.example.com:443 dialer=3.🇯🇵 节点A dscp=0 ip=74.125.137.188:443 mac=72:6c:60:1f:ee:60 network=tcp4 outbound=proxy pname= policy=min_avg10 sniffed=www.example.com
 * 已知怪癖：IPv6 源端口写作 "…:c562: :37918"；UDP 行含 pid=0；dialer 名含空格与 emoji。
 */
function parseKV(s) {
  const out = {};
  const re = /([a-z]+)=/g;
  const marks = [];
  let m;
  while ((m = re.exec(s))) marks.push({ k: m[1], vs: m.index + m[0].length, ks: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].ks : s.length;
    out[marks[i].k] = s.slice(marks[i].vs, end).trim();
  }
  return out;
}
function parseLogLine(line) {
  const h = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+(\w+)\s+([\s\S]*)$/.exec(line);
  if (!h) return null;
  const [, ts, level, rest] = h;
  if (level !== 'INFO' || !rest.includes('<->')) return null;
  const sep = rest.search(/\s[a-z]+=/);
  if (sep === -1) return null;
  const addrPart = rest.slice(0, sep);
  const kv = parseKV(rest.slice(sep + 1));
  if (!kv.outbound) return null;
  const ai = addrPart.indexOf('<->');
  return {
    ts: parseTime(ts), level,
    src: addrPart.slice(0, ai).trim(),
    dst: addrPart.slice(ai + 3).trim(),
    ...kv,
  };
}
const logSeen = new Set(); // 常驻去重集合：避免每次 5s 轮询全量重建 1200 条的 Set
function ingestLog(text) {
  const lines = text.split('\n').filter(Boolean);
  const entries = [];
  for (const ln of lines) { const e = parseLogLine(ln); if (e) entries.push(e); }
  entries.reverse(); // 文件为正序 → 倒序后最新在前
  const key = e => [e.ts, e.src, e.dst, e.network, e.ip, e.mac, e.outbound, e.dialer].join('|');
  const merged = [...S.logEntries];
  for (const e of entries) { const k = key(e); if (!logSeen.has(k)) { logSeen.add(k); merged.push(e); } }
  merged.sort((a, b) => b.ts - a.ts);
  S.logEntries = merged.slice(0, 1200);
  const rec = new Map();
  for (const e of S.logEntries) if (!rec.has(e.outbound)) rec.set(e.outbound, { raw: e.dialer || '', ts: e.ts, entry: e });
  S.recent = rec;
}
/* 1.7 DNS 上游失败 → 通知中心。
 * parseLogLine 只收 INFO 行，WARN 被整段丢弃，于是"某次网站打不开"只留在日志里没人看见。
 * 同一域名在一轮里只出一条，hard（真的发了 SERVFAIL）优先。 */
function qnameFromDohB64(b64) {
  try {
    const bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
    const out = [];
    let i = 12;                                  // 跳过 DNS 报文头
    while (i < bin.length) {
      const len = bin.charCodeAt(i++);
      if (!len) break;
      out.push(bin.slice(i, i + len));
      i += len;
    }
    return out.length ? out.join('.') : null;
  } catch { return null; }
}
function dnsWarnEvents(text) {
  const byWho = new Map();
  for (const ln of String(text).split('\n')) {
    const hard = ln.includes('DNS ingress fast path failed');
    const fwd = ln.includes('DNS forward to upstream failed');
    if (!hard && !fwd) continue;
    const kind = ln.includes('http3:') ? 'HTTP/3 超时'
      : ln.includes('TLS handshake timeout') ? 'TLS 握手超时'
      : /timeout|timed out/.test(ln) ? '上游超时' : '上游失败';
    const q = /question=\[\{Name:([^}\s\]]+)/.exec(ln);
    const b64 = /\?dns=([A-Za-z0-9_-]+)/.exec(ln);
    const who = (q && q[1]) || (b64 && qnameFromDohB64(b64[1])) || '未知域名';
    const prev = byWho.get(who);
    if (prev && !(prev.lv === 'warn' && hard)) continue;
    byWho.set(who, {
      lv: hard ? 'err' : 'warn',
      b: `DNS ${hard ? '解析失败（客户端收到 SERVFAIL）' : '上游转发失败'} · ${kind}`,
      p: hard ? `${who} —— 该查询直接失败，表现为「网站打不开」；可到出口记录页核对`
              : `${who} —— 上游转发失败，将尝试备用上游`,
    });
  }
  return [...byWho.values()];
}
function dialerMatchesNode(rawDialer, nodeName) {
  if (!rawDialer || !nodeName) return false;
  const stripped = rawDialer.replace(/^\d+\./, '');
  return rawDialer === nodeName || stripped === nodeName || rawDialer.endsWith(nodeName) || stripped.endsWith(nodeName);
}
function recentFor(group) {
  const r = S.recent.get(group.name);
  if (!r) return null;
  const node = (group.pool || group.nodes).find(n => dialerMatchesNode(r.raw, n.name));
  return { ...r, nodeId: node ? node.id : null, name: node ? node.name : r.raw };
}

/* ================= 延迟 ================= */
let histDirty = false;
function applyLatencies(list) {
  for (const it of list || []) {
    S.lat.set(it.id, it);
    const lastTs = S.histTs.get(it.id);
    if (it.latencyMs != null && it.testedAt && it.testedAt !== lastTs) {
      S.histTs.set(it.id, it.testedAt);
      const arr = S.hist.get(it.id) || [];
      arr.push(it.latencyMs);
      S.hist.set(it.id, arr.slice(-10));
      histDirty = true;
    }
  }
  if (histDirty) { saveHist(); histDirty = false; }
}
function latClass(ms) {
  if (ms == null) return '';
  if (ms > S.cfg.midMs) return 'l1';
  if (ms > S.cfg.lowMs) return 'l2';
  return 'l3';
}
function latPill(id) {
  const l = S.lat.get(id);
  if (S.testing.has(id)) return `<span class="lat testing" data-lat="${id}">…</span>`;
  if (!l || l.latencyMs == null) {
    const dead = l && !l.alive;
    return `<span class="lat" data-lat="${id}" title="${esc((l && l.message) || '无数据，点击测速')}">${dead ? '超时' : '--'}</span>`;
  }
  return `<span class="lat ${latClass(l.latencyMs)}" data-lat="${id}" title="点击重测${l.message ? '｜' + esc(l.message) : ''}｜更新于 ${ago(parseTime(l.testedAt))}">${l.latencyMs}ms</span>`;
}
// min_avg10 近似：面板自采样最近≤10 次延迟均值（非 dae 内部精确值，真值看日志 dialer）
function predictFor(group) {
  let best = null;
  for (const n of poolEff(group)) {
    const l = S.lat.get(n.id);
    if (!l || !l.alive) continue;
    const h = (S.hist.get(n.id) || []).slice(-10).filter(v => v != null);
    const avg = h.length >= 3 ? h.reduce((a, b) => a + b, 0) / h.length : (l.latencyMs != null ? l.latencyMs : Infinity);
    if (!best || avg < best.avg) best = { node: n, avg, samples: h.length };
  }
  return best;
}
function fixedNodeFor(group) {
  const pv = (group.policyParams || []).find(p => (p.key || '') === '');
  const idx = Number(pv && pv.val) || 0;
  return group.nodes[idx] || group.nodes[0] || null;
}

/* ================= 区域分类 / 垃圾节点过滤 ================= */
const REGIONS = [
  { id: 'HK', name: '香港', re: /🇭🇰|香港|\bHK\b|Hong ?Kong/i },
  { id: 'TW', name: '台湾', re: /🇹🇼|台湾|臺灣|\bTW\b|Taiwan/i },
  { id: 'JP', name: '日本', re: /🇯🇵|日本|\bJP\b|Japan|东京|東京|Tokyo|大阪|Osaka/i },
  { id: 'SG', name: '新加坡', re: /🇸🇬|新加坡|狮城|獅城|\bSG\b|Singapore/i },
  { id: 'US', name: '美国', re: /🇺🇸|美国|美國|\bUS\b|\bUSA\b|United ?States|洛杉矶|洛杉磯|Los ?Angeles|圣何塞|聖何塞|San ?Jose|西雅图|Seattle|美西|美东/i },
];
function regionOf(node) {
  const s = (node.name || '') + ' ' + (node.tag || '');
  for (const r of REGIONS) if (r.re.test(s)) return r.id;
  return 'OT';
}
function regionName(id) { return id === 'OT' ? '其他' : (REGIONS.find(r => r.id === id) || {}).name || id; }
const MULT_RE = /([0-9]+(?:\.[0-9]+)?)\s*(?:[xX×](?![a-zA-Z])|倍(?:率)?)/;
function isJunk(node) {
  const s = ((node.name || '') + ' ' + (node.tag || '')).toLowerCase();
  const m = MULT_RE.exec(s);
  if (m && S.cfg.filterMult > 0 && parseFloat(m[1]) <= S.cfg.filterMult) return true;
  const kws = (S.cfg.filterKw || '').split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean);
  return kws.some(k => s.includes(k));
}
function poolEff(g) { return (g.pool || g.nodes || []).filter(n => !isJunk(n)); }
function regionBest(nodes) {
  let best = Infinity;
  for (const n of nodes) { const l = S.lat.get(n.id); if (l && l.alive && l.latencyMs != null && l.latencyMs < best) best = l.latencyMs; }
  return best === Infinity ? null : best;
}
function regionsOfPool(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const r = regionOf(n);
    if (!map.has(r)) map.set(r, []);
    map.get(r).push(n);
  }
  return map;
}

/* ================= 确认 / 表单弹窗 ================= */
let modalResolve = null;
// showModal({title, fields}) → Promise<values|null>；showConfirm(html) → Promise<bool>
function showModal(opts) {
  $('#modal-text').innerHTML = opts.title || '';
  const card = document.querySelector('#modal .modal-card');
  if (card) card.classList.toggle('modal-wide', !!opts.wide);
  const fb = $('#modal-fields');
  if (opts.fields && opts.fields.length) {
    fb.innerHTML = opts.fields.map(f => {
      if (f.type === 'html') return f.html;
      if (f.type === 'textarea')
        return `<label>${esc(f.label)}<textarea class="modal-input" data-key="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}</label>`;
      if (f.type === 'select')
        return `<label>${esc(f.label)}<select class="modal-input" data-key="${esc(f.key)}">${(f.options || []).map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}</label>`;
      if (f.type === 'checkbox')
        return `<label class="fcheck"><input class="modal-input" data-key="${esc(f.key)}" type="checkbox" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
      return `<label>${esc(f.label)}<input class="modal-input" data-key="${esc(f.key)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">${f.hint ? `<span class="fhint">${esc(f.hint)}</span>` : ''}</label>`;
    }).join('');
    fb.hidden = false;
  } else { fb.innerHTML = ''; fb.hidden = true; }
  $('#modal').hidden = false;
  return new Promise(res => { modalResolve = res; });
}
function showConfirm(html) { return showModal({ title: html }); }
function closeModal(v) {
  const card = document.querySelector('#modal .modal-card');
  if (card) card.classList.remove('modal-wide');
  const fb = $('#modal-fields');
  let out = v;
  if (v && !fb.hidden) {
    out = {};
    $$('#modal-fields .modal-input').forEach(inp => {
      out[inp.dataset.key] = inp.type === 'checkbox' ? inp.checked : inp.value;
    });
  }
  $('#modal').hidden = true;
  if (modalResolve) { modalResolve(out); modalResolve = null; }
}
$('#modal-ok').addEventListener('click', () => closeModal(true));
$('#modal-cancel').addEventListener('click', () => closeModal(false));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(false); });

/* ================= 区域托管（组收缩 / 还原） =================
 * dae 无区域选点参数；选定区域的实现 = 把组临时收缩为该区域节点：
 *   删多余显式节点 → 解除订阅匹配 → 添加区域节点为显式成员 → run
 * 恢复全局 = 按快照精确还原（快照存 daed jsonStorage，跨设备可用）。
 * 托管期间订阅自动更新不会影响组；若托管节点因订阅更新丢失，面板自动补齐。
 */
const STEER_KEY = 'daed-board/steer';
let steerBusy = false;
function steerLoadAll() {
  try { return JSON.parse(localStorage.getItem('db.steer') || '{}'); } catch { return {}; }
}
function steerSaveAll(all) { localStorage.setItem('db.steer', JSON.stringify(all)); }
async function steerPersist(all) {
  steerSaveAll(all);
  try { await api.setStorage([STEER_KEY], [JSON.stringify(all)]); } catch {}
}
async function steerSyncFromServer() {
  try {
    const vals = await api.getStorage([STEER_KEY]);
    const v = vals && vals[0];
    if (v) { const all = JSON.parse(v); steerSaveAll(all); return all; }
  } catch {}
  return steerLoadAll();
}
function steerGet(gid) { return steerLoadAll()[gid] || null; }

function snapshotGroup(g) {
  return {
    explicitIds: g.nodes.map(n => n.id),
    explicitNodes: g.nodes.map(n => ({ id: n.id, name: n.name, protocol: n.protocol || '', tag: n.tag || '', address: n.address || '' })),
    subs: (g.subscriptions || []).map(s => ({ id: s.subscription.id, nameFilterRegex: s.nameFilterRegex || null })),
    pool: (g.pool || g.nodes).map(n => ({ id: n.id, name: n.name, protocol: n.protocol || '', tag: n.tag || '' })),
    at: Date.now(),
  };
}

const dedupe = a => [...new Set(a)];

// 把组收敛到 targetIds（以组"当前"成员为准计算增量，与快照旧 id 无关；不含 run，由调用方在追加操作后统一 run）
async function applyGroupShape(g, targetIds) {
  const tset = new Set(targetIds);
  const delIds = g.nodes.map(n => n.id).filter(id => !tset.has(id));
  if (delIds.length) await api.delNodes(g.id, delIds);
  const curSubIds = (g.subscriptions || []).map(s => s.subscription && s.subscription.id).filter(Boolean);
  if (curSubIds.length) await api.delSubs(g.id, curSubIds);
  const addIds = targetIds.filter(id => !g.nodes.some(n => n.id === id));
  if (addIds.length) await api.addNodes(g.id, addIds);
}

async function steerRestore(g, silent) {
  const all = steerLoadAll();
  const st = all[g.id];
  if (!st) return false;
  try {
    // 快照 id 按名称重映射到当前 id（订阅更新会"删旧建新"重建 id）
    const idx = await nodeIndex();
    const remap = idx.mk(st.backup);
    const origIds = dedupe((st.backup.explicitIds || []).map(remap).filter(Boolean));
    if (!origIds.length) {
      // 退化快照（钉选前组内没有显式成员可恢复）：仅清除钉选状态，组结构保持现状
      delete all[g.id];
      await steerPersist(all);
      await refreshGroups(false);
      if (!silent) toast('已清除「' + g.name + '」的钉选状态（原快照无可恢复成员，组保持现有成员）', 'ok');
      return true;
    }
    await applyGroupShape(g, origIds);
    for (const s of st.backup.subs) {
      await api.addSubs(g.id, [s.id], s.nameFilterRegex);
    }
    if (st.savedPolicy && st.savedPolicy !== g.policy) {
      await api.setPolicy(g.id, st.savedPolicy, st.savedPolicy === 'fixed' ? [{ key: '', val: '0' }] : []);
    }
    await api.run();
    delete all[g.id];
    await steerPersist(all);
    await refreshGroups(false);
    if (!silent) toast('已恢复「' + g.name + '」组的原始成员与订阅匹配', 'ok');
    return true;
  } catch (e) {
    toast('恢复失败：' + e.message + '（组结构可能不完整，可在官方面板重新挂订阅/补节点）', 'err');
    return false;
  }
}

// 钉选节点：组收缩为仅此一个节点 + 策略 fixed（dae 的 fixed 语义 = 组内唯一节点）。
// 恢复点（原成员+原策略）存快照，点「全局」还原。AI 组换节点、proxy 组钉死单节点都走这条路径。
async function pinToNode(g, node, opts) {
  const silent = opts && opts.silent;
  if (steerBusy) { if (!silent) toast('上一个切换还在执行…'); return false; }
  steerBusy = true;
  try {
    const all = steerLoadAll();
    let st = all[g.id];
    if (!st) st = { backup: snapshotGroup(g), savedPolicy: g.policy };
    if (!st.savedPolicy) st.savedPolicy = g.policy;
    if (st.mode === 'node' && st.targetIds && st.targetIds[0] === node.id) {
      if (!silent) toast('该节点已是钉选状态');
      return false;
    }
    const idx = await nodeIndex();
    const targetId = idx.alive.has(node.id) ? node.id : idx.byName.get(node.name);
    if (!targetId) { if (!silent) toast('该节点已不存在于 daed', 'err'); return false; }
    if (!silent) {
      const ok = await showConfirm(
        `将把「<b>${esc(g.name)}</b>」组收缩为仅含「<b>${esc(node.name)}</b>」一个节点，策略切换为 <b>fixed</b>，并重载 daed —— <b>代理连接会瞬断 1-2 秒</b>。<br>` +
        `恢复点已保存：点「全局」恢复原成员与原策略（${esc(st.savedPolicy)}）。确定继续？`);
      if (!ok) return false;
    }
    await applyGroupShape(g, [targetId]);
    await api.setPolicy(g.id, 'fixed', [{ key: '', val: '0' }]);
    await api.run();
    all[g.id] = {
      mode: 'node', region: null, pinnedName: node.name,
      targetIds: [targetId], backup: st.backup,
      addedIds: [targetId], savedPolicy: st.savedPolicy,
      lastAuto: st.lastAuto || 0,
    };
    await steerPersist(all);
    await refreshGroups(false);
    if (!silent) toast(`「${g.name}」已钉选到「${node.name}」（fixed）`, 'ok');
    testNodes([targetId], g).catch(() => {});
    return true;
  } catch (e) {
    toast('钉选失败：' + e.message + '（组结构可能不完整，请点「全局」恢复）', 'err');
    return false;
  } finally { steerBusy = false; }
}

async function steerTo(g, regionId, opts) {
  const silent = opts && opts.silent;
  if (steerBusy) { if (!silent) toast('上一个区域切换还在执行…'); return false; }
  steerBusy = true;
  try {
    const all = steerLoadAll();
    let st = all[g.id];
    if (!st) st = { backup: snapshotGroup(g), savedPolicy: g.policy };
    if (!st.savedPolicy) st.savedPolicy = g.policy;
    const backup = st.backup;
    // 快照 id 按名称重映射（订阅更新可能已"删旧建新"），得到当前真实存在的候选池
    const idx = await nodeIndex();
    const remap = idx.mk(backup);
    const sourcePool = dedupe((backup.pool || []).map(p => remap(p.id)).filter(Boolean)).map(id => {
      const b = (backup.pool || []).find(p => p.id === id) || {};
      const c = (g.pool || g.nodes || []).find(n => n.id === id) || {};
      return { id, name: c.name || b.name || '', tag: c.tag || b.tag || '', protocol: c.protocol || b.protocol || '' };
    }).filter(n => n.name);
    const target = sourcePool.filter(n => regionOf(n) === regionId && !isJunk({ name: n.name, tag: n.tag }));
    if (!target.length) { if (!silent) toast('该区域没有可用节点', 'err'); return false; }
    const targetIds = dedupe(target.map(n => n.id));
    if (!silent) {
      const ok = await showConfirm(
        `将把 <b>${esc(g.name)}</b> 组临时收缩为仅含 <b>${esc(regionName(regionId))}</b> 区域的 <b>${targetIds.length}</b> 个节点（面板托管），并重载 daed —— <b>代理连接会瞬断 1-2 秒</b>。<br>` +
        `托管期间订阅匹配暂时解除；该区域节点全部失效时面板会自动切换到其他最优区域；点「全局」随时还原。<br>确定继续？`);
      if (!ok) return false;
    }
    await applyGroupShape(g, targetIds);
    // 从"钉选节点"切回区域模式时，恢复钉选前的原策略（fixed 单节点与多节点区域不兼容）
    if (st.savedPolicy && g.policy !== st.savedPolicy) {
      await api.setPolicy(g.id, st.savedPolicy, st.savedPolicy === 'fixed' ? [{ key: '', val: '0' }] : []);
    }
    await api.run();
    all[g.id] = {
      mode: 'region', region: regionId, pinnedName: undefined, targetIds,
      backup,
      addedIds: targetIds.filter(id => !backup.explicitIds.includes(id)),
      savedPolicy: st.savedPolicy,
      lastAuto: st.lastAuto || 0,
    };
    await steerPersist(all);
    await refreshGroups(false);
    if (!silent) toast(`已切换「${g.name}」→ ${regionName(regionId)}（${targetIds.length} 节点），正在测速…`, 'ok');
    testNodes(targetIds, g).catch(() => {}); // 立即出区域延迟
    return true;
  } catch (e) {
    toast('区域切换失败：' + e.message + '（组结构可能不完整，请点「全局」恢复或去官方面板检查）', 'err');
    return false;
  } finally { steerBusy = false; }
}

// fixed 组换节点：列出 daed 全部节点（按延迟升序、存活优先）供选择（AI 组这类单节点 fixed 组的换节点入口）
async function swapNode(g) {
  try {
    const idx = await nodeIndex();
    const cur = g.nodes[0];
    const opts = [...idx.byName.entries()].map(([name, id]) => ({ id, name }));
    let latMap = new Map();
    try {
      const lat = await api.latencies(opts.map(o => o.id)) || [];
      latMap = new Map((lat || []).map(l => [l.id, l]));
    } catch {}
    opts.forEach(o => { const l = latMap.get(o.id); o.ms = l && l.alive && l.latencyMs != null ? l.latencyMs : null; });
    opts.sort((a, b) => ((b.ms != null) - (a.ms != null)) || ((a.ms ?? 1e9) - (b.ms ?? 1e9)) || a.name.localeCompare(b.name, 'zh'));
    const v = await showModal({
      title: `更换「${esc(g.name)}」（fixed）的节点`,
      fields: [
        { key: 'nid', label: '选择节点（当前：' + (cur ? esc(cur.name) : '—') + '）· 按延迟排序', type: 'select', value: cur ? cur.id : '', options: opts.map(o => ({ value: o.id, label: o.name + (o.ms != null ? ' · ' + o.ms + 'ms' : '') })) },
      ],
    });
    if (!v || !v.nid) return;
    let name = v.nid;
    for (const [n, id] of idx.byName.entries()) if (id === v.nid) { name = n; break; }
    await pinToNode(g, { id: v.nid, name });
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('打开换节点失败：' + e.message, 'err');
  }
}
// 订阅更新会"删旧建新"重建节点 id（名称不变）。这里建立 节点名称→当前id 索引，
// 用于把托管快照里的旧 id 映射回当前 id；旧 id 仍存活则优先保留。
async function nodeIndex() {
  const alive = new Set(), byName = new Map();
  // 顶层 nodes 只含独立节点，订阅节点必须逐订阅取。
  // 此索引用于托管恢复时的成员映射——失败必须抛错（静默降级会静默丢弃组员）。
  const d = await gql(`query { nodes(first: 999) { edges { id name } } subscriptions { nodes(first: 999) { edges { id name } } } }`);
  for (const e of (d.nodes.edges || [])) { alive.add(e.id); if (!byName.has(e.name)) byName.set(e.name, e.id); }
  for (const s of (d.subscriptions || [])) for (const e of (s.nodes.edges || [])) { alive.add(e.id); if (!byName.has(e.name)) byName.set(e.name, e.id); }
  for (const g of S.groups) for (const n of (g.pool || g.nodes || [])) { alive.add(n.id); if (!byName.has(n.name)) byName.set(n.name, n.id); }
  const mk = backup => id => {
    if (alive.has(id)) return id;
    const b = (backup.pool || []).find(p => p.id === id) || (backup.explicitNodes || []).find(x => x.id === id);
    return (b && byName.get(b.name)) || null;
  };
  return { alive, byName, mk };
}

async function steerAudit() {
  if (steerBusy) return;
  // 1.5 只读本地快照：跨设备同步改在启动时做一次
  //（改动前每轮审计都 await steerSyncFromServer()，即每 30s 多读一次 ~47KB jsonStorage）
  const all = steerLoadAll();
  const gids = Object.keys(all);
  if (!gids.length) return;
  if (!S.groups.length) return; // 组列表未就绪时绝不审计（防止误撤销托管状态）
  let changed = false;
  let idx = null;
  try { idx = await nodeIndex(); } catch { return; }
  const remapOf = st => idx.mk(st.backup);
  for (const gid of gids) {
    const g = S.groups.find(x => x.id === gid);
    if (!g) { delete all[gid]; changed = true; continue; } // 组已被删除
    const st = all[gid];
    const linked = (g.subscriptions || []).length > 0;
    if (linked && (st.backup.subs || []).length) {
      // 订阅还挂着 → 托管从未生效（中断）→ 直接撤销快照
      delete all[gid]; changed = true;
      toast('检测到未完成的区域托管，已撤销', 'ok');
      continue;
    }
    // 快照 id 自愈：订阅更新重建 id 后按名称找回。
    // 1.6 重映射是幂等的 → 先记原值，只有真的变了才标脏写回
    //（改动前这里无条件 changed = true，于是每 30s 把整份托管快照 ~47KB 重写一次 jsonStorage）
    const snapOf = x => JSON.stringify([x.backup.explicitIds, x.backup.pool, x.targetIds, x.addedIds]);
    const before = snapOf(st);
    const remap = remapOf(st);
    const dedupe = a => [...new Set(a)];
    st.backup.explicitIds = dedupe((st.backup.explicitIds || []).map(remap).filter(Boolean));
    st.backup.pool = (st.backup.pool || []).map(p => ({ ...p, id: remap(p.id) || p.id }));
    st.targetIds = dedupe((st.targetIds || []).map(remap).filter(Boolean));
    st.addedIds = dedupe((st.addedIds || []).map(remap).filter(Boolean));
    if (snapOf(st) !== before) changed = true;
    // 掉员修复：托管目标节点被订阅更新等移除时补回
    const curIds = new Set(g.nodes.map(n => n.id));
    const missing = st.targetIds.filter(id => !curIds.has(id));
    if (missing.length) {
      try { await api.addNodes(gid, missing); await api.run(); toast(`「${g.name}」托管节点缺失 ${missing.length} 个，已自动补齐`, 'ok'); } catch {}
    }
  }
  if (changed) await steerPersist(all);
}

// 托管组健康巡检：区域内全失效 → 复测确认 → 从全池测速选最优存活区域自动切换
async function checkSteerHealth() {
  const all = steerLoadAll();
  for (const gid of Object.keys(all)) {
    const st = all[gid];
    const g = S.groups.find(x => x.id === gid);
    if (!g || steerBusy) continue;
    if (st.mode === 'node') continue; // 手动钉选的单节点是用户明确意图，不做自动切换
    const members = poolEff(g);
    if (!members.length || members.some(n => { const l = S.lat.get(n.id); return l && l.alive; })) continue;
    if (Date.now() - (st.lastAuto || 0) < 10 * 60 * 1000) continue; // 防抖
    // 复测确认当前区域真的全挂
    let res = [];
    try { res = await api.test(members.map(n => n.id)) || []; } catch { continue; }
    applyLatencies(res);
    if (res.some(l => l.alive)) continue;
    // 从快照全池按区域挑最优存活区域
    const cand = st.backup.pool.filter(n => regionOf(n) !== st.region && !isJunk({ name: n.name, tag: n.tag }));
    let freshest;
    try { freshest = await api.test(cand.map(n => n.id)) || []; } catch { continue; }
    applyLatencies(freshest);
    const byRegion = regionsOfPool(cand);
    let best = null;
    for (const [rid, nodes] of byRegion) {
      const alive = nodes.filter(n => { const l = S.lat.get(n.id); return l && l.alive && l.latencyMs != null; });
      if (!alive.length) continue;
      const b = Math.min(...alive.map(n => S.lat.get(n.id).latencyMs));
      if (!best || b < best.ms) best = { rid, ms: b };
    }
    if (!best) { toast(`「${g.name}」托管区域已全部失效，且其他区域也没有存活节点`, 'err'); continue; }
    st.lastAuto = Date.now();
    await steerPersist(all);
    toast(`「${g.name}」${regionName(st.region)} 全部失效，自动切换到 ${regionName(best.rid)}（${best.ms}ms）`, 'ok');
    await steerTo(g, best.rid, { silent: true });
  }
}

/* ================= 内存采样（供 KPI 卡 sparkline） =================
 * 采样来自出口记录 CGI 附带的 #MEM 行；≥30 分钟记一个点，保留 8 天。
 * 搭 poll:logbg 的车，零额外请求；守卫动作走通知中心，不在此渲染大图。
 */
function memHistLoad() {
  try { return JSON.parse(localStorage.getItem(MEMHIST_KEY)) || []; } catch { return []; }
}
function memHistSample() {
  if (!S.memAvailKB) return;
  const arr = memHistLoad();
  const now = Date.now();
  if (arr.length && now - arr[arr.length - 1].t < 30 * 60 * 1000) return;
  arr.push({ t: now, kb: S.memAvailKB });
  while (arr.length && now - arr[0].t > 8 * 24 * 3600 * 1000) arr.shift();
  try { localStorage.setItem(MEMHIST_KEY, JSON.stringify(arr)); } catch {}
}
/* ================= 图标 / 页面定义 ================= */
const ICONS = {
  proxies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 15 8 15 11 7 14 18 17 12 21 12"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></svg>',
  nodes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>',
};
const PAGES = [
  { id: 'proxies', name: '代理', icon: 'proxies' },
  { id: 'overview', name: '概览', icon: 'overview' },
  { id: 'logs', name: '出口记录', icon: 'logs' },
  { id: 'nodes', name: '节点订阅', icon: 'nodes' },
  { id: 'config', name: '配置', icon: 'config' },
  { id: 'settings', name: '设置', icon: 'settings' },
];
const NAV_GROUPS = [
  { label: '监控', ids: ['overview', 'proxies', 'logs'] },
  { label: '管理', ids: ['nodes', 'config'] },
  { label: '系统', ids: ['settings'] },
];
const PAGE_META = {
  overview: { t: '概览', d: '核心状态、流量与内存一览 · 自动刷新' },
  proxies: { t: '代理', d: '分组选点 · 实际出口来自连接日志 dialer 真值' },
  logs: { t: '出口记录', d: '连接日志 · 点击行复制原始记录' },
  nodes: { t: '节点订阅', d: '订阅管理与全量节点 · 支持导入/更新/删除' },
  config: { t: '配置', d: '路由 / DNS 多版本与全局字段 · 改动需 run 生效' },
  settings: { t: '设置', d: '连接 · 显示 · 场景预设 · 关于' },
};

/* ================= 路由 ================= */
function navCounts(id) {
  if (id === 'proxies') { const n = S.groups.reduce((a, g) => a + (g.pool || g.nodes || []).length, 0); return n ? String(n) : ''; }
  if (id === 'nodes') return S.nodesAll.length ? String(S.nodesAll.length) : '';
  return '';
}
function renderNav() {
  const mk = p => `<div class="nav-item ${S.page === p.id ? 'on' : ''}" data-page="${p.id}" title="${p.name}">${ICONS[p.icon]}<span>${p.name}</span>${navCounts(p.id) ? `<span class="cnt">${navCounts(p.id)}</span>` : ''}</div>`;
  $('#nav-list').innerHTML = NAV_GROUPS.map(grp =>
    `<div class="nav-group">${grp.label}</div>` + grp.ids.map(id => mk(PAGES.find(x => x.id === id))).join('')
  ).join('');
  $('#tabbar').innerHTML = PAGES.map(mk).join('');
}
for (const host of ['#nav-list', '#tabbar']) {
  $(host).addEventListener('click', e => {
    const item = e.target.closest('[data-page]');
    if (item) location.hash = '#/' + item.dataset.page;
  });
}
window.addEventListener('hashchange', onRoute);
// 通用 data-nav 跳转（概览卡/任务卡的页面直达按钮）
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { location.hash = '#/' + nav.dataset.nav; }
});
function onRoute() {
  const p = (location.hash || '#/proxies').replace(/^#\//, '') || 'proxies';
  S.page = PAGES.some(x => x.id === p) ? p : 'proxies';
  renderNav();
  const meta = PAGE_META[S.page];
  const tb = $('#tb-title'), td = $('#tb-desc');
  if (tb) tb.textContent = meta.t;
  if (td) td.textContent = meta.d;
  document.title = meta.t + ' · daed-board';
  topChips();
  renderPage();
}
function renderPage() {
  const el = $('#page');
  el.innerHTML = '';
  ({ proxies: pageProxies, overview: pageOverview, logs: pageLogs, nodes: pageNodes, config: pageConfig, settings: pageSettings })[S.page](el);
}

/* ================= 顶栏状态 chips ================= */
function topChips() {
  const box = $('#tb-chips');
  if (!box) return;
  const C = [];
  const run = S.general && S.general.dae;
  C.push(run ? `<span class="chip ${run.running ? 'ok' : 'warn'}"><span class="dot ${run.running ? 'on' : 'off'}"></span>核心${run.running ? '运行中' : '已停止'}</span>` : '');
  if (run && run.modified) C.push(`<span class="chip warn">⚠ 有改动未应用</span>`);
  else if (run) C.push(`<span class="chip ok">✓ 配置已应用</span>`);
  if (S.cfgGlobal && S.cfgGlobal.global && S.cfgGlobal.global.logLevel) C.push(`<span class="chip mono">日志 <b>${esc(S.cfgGlobal.global.logLevel)}</b></span>`);
  const d = new Date();
  C.push(`<span class="chip mono">刷新 <b id="tick">${[d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':')}</b></span>`);
  box.innerHTML = C.join('');
}
setInterval(() => {
  const t = $('#tick');
  if (t) { const d = new Date(); t.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':'); }
}, 1000);

/* ================= 页面：代理 ================= */
function pageProxies(el) {
  el.innerHTML = `
    <div class="toolbar">
      <span class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="search" id="px-search" placeholder="搜索节点 / 协议 / 标签…" value="${esc(S.filter)}"></span>
      <select class="select" id="px-sort">
        <option value="default">默认排序</option>
        <option value="lat">延迟 ↑</option>
        <option value="latdesc">延迟 ↓</option>
        <option value="name">名称</option>
      </select>
      <label class="check"><input type="checkbox" id="px-hide" ${S.cfg.hideUnavail ? 'checked' : ''}> 隐藏不可用</label>
      <label class="check"><input type="checkbox" id="px-junk" ${S.cfg.showJunk ? 'checked' : ''}> 显示无用节点</label>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="px-testall">⚡ 测速全部</button>
      <button class="btn btn-sm" id="px-refresh" title="刷新">⟳ 刷新</button>
    </div>
    <div id="px-groups"><div class="empty">加载中…</div></div>`;
  $('#px-sort').value = S.cfg.sort;
  $('#px-search').addEventListener('input', e => { S.filter = e.target.value.trim().toLowerCase(); renderGroups(); });
  $('#px-sort').addEventListener('change', e => { S.cfg.sort = e.target.value; saveCfg(); renderGroups(); });
  $('#px-hide').addEventListener('change', e => { S.cfg.hideUnavail = e.target.checked; saveCfg(); renderGroups(); });
  $('#px-junk').addEventListener('change', e => { S.cfg.showJunk = e.target.checked; saveCfg(); renderGroups(); });
  $('#px-testall').addEventListener('click', () => testNodes([...new Set(S.groups.flatMap(g => poolEff(g).map(n => n.id)))]));
  $('#px-refresh').addEventListener('click', () => refreshGroups(true));
  $('#px-groups').addEventListener('click', onGroupsClick);
  $('#px-groups').addEventListener('change', onPolicyChange);
  refreshGroups(false);
}

// 组选点策略切换：groupSetPolicy → run；run 失败自动回退原策略（groupSetPolicy 成功但
// run 失败时配置处于"已改动未生效"状态，必须回退，否则官方面板会提示 modified）
async function onPolicyChange(e) {
  const sel = e.target.closest('.policy-select');
  if (!sel) return;
  const g = S.groups.find(x => x.id === sel.dataset.g);
  if (!g) return;
  const policy = sel.value;
  if (policy === g.policy) return;
  const ok = await showConfirm(
    `将把「<b>${esc(g.name)}</b>」选点策略从 <b>${esc(g.policy)}</b> 切换为 <b>${esc(policy)}</b>，并重载 daed —— <b>代理连接会瞬断 1-2 秒</b>。<br>` +
    (policy === 'fixed' ? '<span style="color:var(--yellow)">fixed 策略要求组内只有一个节点，多节点组会被 daed 拒绝并自动回退。</span><br>' : '') +
    '确定继续？');
  if (!ok) { renderGroups(); return; }
  const apply = (p) => api.setPolicy(g.id, p, p === 'fixed' ? [{ key: '', val: '0' }] : []).then(() => api.run());
  try {
    await apply(policy);
    toast(`「${g.name}」策略已切换为 ${policy}`, 'ok');
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(`切换失败：${err.message} —— 已自动回退为 ${g.policy}`, 'err');
    try { await apply(g.policy); } catch (e2) { toast('回退也失败，请到官方面板检查组策略', 'err'); }
  }
  refreshGroups(false);
}
// 运行时节点池 = 显式节点 + 订阅匹配节点（去重；fixed 索引仍以显式 nodes 为准）
function buildPool(g) {
  const seen = new Set(g.nodes.map(n => n.id));
  g.pool = [...g.nodes];
  for (const s of g.subscriptions || []) for (const n of s.matchedNodes || []) {
    if (!seen.has(n.id)) { seen.add(n.id); g.pool.push(n); }
  }
  return g.pool;
}
/* 分组数据落地 + 连带刷新。lats 可以是全量 nodeLatencies（1.10 批量查询会带上未入池的节点），
 * 这里按池内 id 过滤：否则会把未入池节点的延迟写进延迟历史。 */
function applyGroupsPayload(groups, lats) {
  S.groups = groups || [];
  for (const g of S.groups) buildPool(g);
  const pool = new Set(S.groups.flatMap(g => g.pool.map(n => n.id)));
  const keep = (lats || []).filter(l => pool.has(l.id));
  if (keep.length) applyLatencies(keep);
  renderGroups();
  steerAudit().catch(() => {});
  if (S.page === 'logs') renderLogPage();
  updateNavState();
}
async function refreshGroups(manual, opts) {
  if (S.inflight.has('groups')) return;
  S.inflight.add('groups');
  const skipLat = !!(opts && opts.skipLat);
  try {
    const gs = (await api.groups()) || [];
    const ids = [...new Set(gs.flatMap(g => buildPool(g).map(n => n.id)))];
    if (skipLat) {
      applyGroupsPayload(gs, []);
      if (ids.length) api.latencies(ids).then(lats => { applyLatencies(lats || []); if (S.page === 'proxies') renderGroups(); }).catch(() => {});
    } else {
      applyGroupsPayload(gs, ids.length ? await api.latencies(ids) : []);
    }
    if (manual) toast('已刷新', 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    const box = $('#px-groups');
    if (box) box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  } finally { S.inflight.delete('groups'); }
}
function nodeVisible(n) {
  if (!S.cfg.showJunk && isJunk(n)) return false;
  if (S.cfg.hideUnavail) { const l = S.lat.get(n.id); if (!l || !l.alive) return false; }
  if (!S.filter) return true;
  return (n.name + ' ' + (n.protocol || '') + ' ' + (n.tag || '')).toLowerCase().includes(S.filter);
}
function nodeCardHtml(g, n, rec, pred, st) {
  const l = S.lat.get(n.id);
  const isNow = rec && rec.nodeId === n.id;
  const isPinned = st && st.mode === 'node' && (st.targetIds || []).includes(n.id);
  const latTxt = l && l.latencyMs != null ? l.latencyMs + 'ms' : (l && !l.alive ? '超时' : '—');
  return `<div class="node-card${isNow ? ' now' : ''}${isPinned ? ' pinned' : ''}${l && !l.alive && l.testedAt ? ' dead' : ''}" data-node="${n.id}" title="点击测速｜📌 钉选为组内唯一节点（fixed）｜🗑 删除节点">
    <div class="r1"><span class="nn" title="${esc(n.name)}">${esc(n.name)}</span><span class="proto">${esc(n.protocol || '')}</span>
      <span class="nbtns"><button class="nbtn pin${isPinned ? ' on' : ''}" data-pin="${g.id}|${n.id}" title="${isPinned ? '当前钉选节点' : '钉选：组内仅保留此节点（fixed）'}" aria-label="钉选节点"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7 2 3H6l2-3 1-7Z"/></svg></button><button class="nbtn" data-del="${n.id}" title="从 daed 删除此节点（组内成员自动同步移除）" aria-label="删除节点"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button></span></div>
    <span class="lat ${latClass(l && l.latencyMs)}" data-lat="${n.id}" title="${isNow ? '当前实际出口 · ' : ''}点击重测${l && l.message ? '｜' + esc(l.message) : ''}">${latTxt}</span>
    ${l && !l.alive && l.message ? `<div class="n-msg" title="${esc(l.message)}">${esc(l.message)}</div>` : ''}
    ${isNow ? '<div class="hint" style="font-size:10.5px">● 当前实际出口</div>' : ''}
  </div>`;
}
function renderGroups() {
  const box = $('#px-groups');
  if (!box) return;
  // 用户正在组卡片内交互（如展开策略下拉）时跳过重渲染，避免下拉被轮询重建打断
  if (document.activeElement && box.contains(document.activeElement) && document.activeElement.classList.contains('policy-select')) return;
  if (!S.groups.length) { box.innerHTML = '<div class="empty">没有分组数据</div>'; return; }
  box.innerHTML = S.groups.map(g => {
    const eff = poolEff(g);
    const pred = g.policy === 'random' ? null : predictFor(g);
    const rec = recentFor(g);
    const visible = eff.filter(nodeVisible);
    const fixed = g.policy === 'fixed' ? fixedNodeFor(g) : null;
    const st = steerGet(g.id);
    const policyOpts = ['random', 'fixed', 'min', 'min_avg10', 'min_moving_avg']
      .map(p => `<option value="${p}" ${g.policy === p ? 'selected' : ''} ${p === 'fixed' && g.nodes.length > 1 ? 'disabled' : ''}>${p}${p === 'fixed' && g.nodes.length > 1 ? '（需单节点组）' : ''}</option>`).join('');
    const head = `
      <div class="g-head" data-head="${g.id}">
        <div class="gn"><span>${esc(g.name)}</span><span class="cnt">${visible.length}/${eff.length}</span></div>
        <span class="tag ${fixed ? 'ok' : 'p'}">${fixed ? '🔒 fixed' : esc(g.policy)}</span>
        ${st && st.mode === 'node' ? '<span class="tag ok">钉选 · ' + esc(st.pinnedName || '') + '</span>' : (st ? '<span class="tag ok">托管 · ' + esc(regionName(st.region)) + '</span>' : '')}
        <span class="spacer"></span>
        ${g.policy === 'fixed' ? `<button class="btn btn-sm" data-swap="${g.id}" title="更换 fixed 组的节点">✎ 换节点</button>` : ''}
        <select class="policy-select" data-g="${g.id}" title="切换选点策略（重载后生效，代理连接瞬断 1-2 秒）">${policyOpts}</select>
        <button class="btn btn-sm" data-gadd="${g.id}" title="添加节点到此分组">＋ 节点</button>
        <button class="btn btn-sm ${S.testingGroups.has(g.id) ? 'btn-primary' : ''}" data-gtest="${g.id}" title="测试本组全部节点">⚡ 测速</button>
      </div>`;
    let exitLine;
    if (fixed) {
      exitLine = `<div class="exit-line">
        <span class="item"><span class="dot on"></span>固定出口 <span class="val" title="${esc(fixed.name)}">${esc(fixed.name)}</span></span>
        ${rec ? `<span class="item">日志核实 <span class="val">${esc(rec.name)}</span><span class="hint">${ago(rec.ts)}</span></span>` : ''}
      </div>`;
    } else {
      const managedLabel = st && st.mode === 'node' ? `钉选 · ${esc(st.pinnedName || '')}` : (st ? `托管 · ${esc(regionName(st.region))}` : '');
      exitLine = `<div class="exit-line">
        ${st ? `<span class="tag ok">${managedLabel}</span>` : ''}
        <span class="item">实际出口 <span class="val" title="来自 daed 连接日志（真值）">${rec ? esc(rec.name) : '—'}</span>${rec ? `<span class="hint">${ago(rec.ts)}</span>` : ''}</span>
        ${g.policy === 'random' ? '' : `<span class="pred">预计 ${pred ? esc(pred.node.name) : '—'}${pred && pred.samples < 3 ? ' ≈' : ''}</span>`}
      </div>`;
    }
    // 区域选择 chips：托管中显示快照全池的区域视图，未托管显示当前池
    let chips = '';
    if (!fixed) {
      const srcNodes = st
        ? st.backup.pool.map(n => ({ id: n.id, name: n.name, tag: n.tag || '', protocol: n.protocol || '' }))
        : eff;
      const byR = regionsOfPool(srcNodes);
      const mk = (rid, nodes) => {
        const on = st && st.mode === 'node' ? rid === 'GL' : (st ? st.region === rid : rid === 'GL');
        const cls = 'chip-btn' + (on ? (st && (st.mode === 'node' || rid !== 'GL') ? ' managed' : ' on') : '');
        const best = regionBest(nodes);
        const tip = st && st.mode === 'node' && rid === 'GL'
          ? '取消钉选：恢复原成员与原策略'
          : (rid === 'GL' ? '使用全部区域（dae 原生选点）' : '把组临时收缩为' + regionName(rid) + '区域节点');
        return `<span class="${cls}" data-chip="${g.id}|${rid}" title="${tip}">
          <b>${rid === 'GL' ? (st && st.mode === 'node' ? '取消钉选' : '全局') : esc(regionName(rid))}</b> ${nodes.length}${best != null ? ' · <span class="lat-mini">' + best + 'ms</span>' : ''}</span>`;
      };
      chips = '<div class="chip-row">' + mk('GL', srcNodes) + REGIONS.map(r => mk(r.id, byR.get(r.id) || [])).join('') + mk('OT', byR.get('OT') || []) + '</div>';
    }
    // 节点池延迟分布预览（前 40）
    const dots = eff.slice(0, 40).map(n => {
      const l = S.lat.get(n.id);
      const cls = l && l.latencyMs != null ? ' ' + latClass(l.latencyMs) : '';
      const isNow = rec && rec.nodeId === n.id;
      return `<i class="${cls}${isNow ? ' now' : ''}" title="${esc(n.name)}${l && l.latencyMs != null ? ' · ' + l.latencyMs + 'ms' : ''}"></i>`;
    }).join('');
    const byRegion = regionsOfPool(visible);
    const sections = [...REGIONS.map(r => r.id), 'OT'].filter(rid => (byRegion.get(rid) || []).length).map(rid => {
      const nodes = sortNodes(byRegion.get(rid));
      const best = regionBest(nodes);
      return `<div class="region-sec">
        <div class="region-head"><span class="rg-name">${esc(regionName(rid))}</span><span>${nodes.length} 节点</span>
          ${best != null ? `<span class="rg-best">最快 ${best}ms</span>` : ''}
          <button class="btn btn-sm btn-ghost" data-rgtest="${g.id}|${rid}" title="测速本区域全部节点">⚡ 测速本区</button>
        </div>
        <div class="node-grid">${nodes.map(n => nodeCardHtml(g, n, rec, pred, st)).join('')}</div>
      </div>`;
    }).join('');
    const open = !S.closedGroups.has(g.id);
    const body = open ? `${exitLine}${chips}<div class="dots">${dots}</div>${sections}
      <div style="padding:0 16px 16px"><div class="node-card add-card" data-gadd="${g.id}" title="添加节点到此分组">＋ 添加节点</div></div>` : '';
    return `<section class="card gcard" data-g="${g.id}">${head}${body}</section>`;
  }).join('');
}
function sortNodes(list) {
  const arr = [...list];
  const ms = id => { const l = S.lat.get(id); return l && l.latencyMs != null ? l.latencyMs : Infinity; };
  if (S.cfg.sort === 'lat') arr.sort((a, b) => ms(a.id) - ms(b.id));
  else if (S.cfg.sort === 'latdesc') arr.sort((a, b) => ms(b.id) - ms(a.id));
  else if (S.cfg.sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return arr;
}
function onGroupsClick(e) {
  const t = e.target;
  if (t.closest('.policy-select')) return; // 下拉框交互不触发折叠/动作
  const pin = t.closest('[data-pin]');
  if (pin) {
    const [gid, nid] = pin.dataset.pin.split('|');
    const g = S.groups.find(x => x.id === gid);
    if (!g) return;
    const node = (g.pool || g.nodes).find(n => n.id === nid);
    if (node) pinToNode(g, node);
    return;
  }
  const swap = t.closest('[data-swap]');
  if (swap) {
    const g = S.groups.find(x => x.id === swap.dataset.swap);
    if (g) swapNode(g);
    return;
  }
  const chip = t.closest('[data-chip]');
  if (chip) {
    const [gid, rid] = chip.dataset.chip.split('|');
    const g = S.groups.find(x => x.id === gid);
    if (!g) return;
    const cur = steerGet(gid);
    if (cur && cur.region === rid) return;
    if (rid === 'GL') { if (cur) steerRestore(g); return; }
    steerTo(g, rid);
    return;
  }
  const rgtest = t.closest('[data-rgtest]');
  if (rgtest) {
    const [gid, rid] = rgtest.dataset.rgtest.split('|');
    const g = S.groups.find(x => x.id === gid);
    if (g) testNodes(poolEff(g).filter(n => regionOf(n) === rid).map(n => n.id), g);
    return;
  }
  const gtest = t.closest('[data-gtest]');
  if (gtest) {
    const g = S.groups.find(x => x.id === gtest.dataset.gtest);
    if (g) testNodes(poolEff(g).map(n => n.id), g);
    return;
  }
  const del = t.closest('[data-del]');
  if (del) { delNodeAction(del.dataset.del); return; }
  const gadd = t.closest('[data-gadd]');
  if (gadd) { addNodesModal(S.groups.find(x => x.id === gadd.dataset.gadd)); return; }
  const pill = t.closest('[data-lat]');
  if (pill) { testNodes([pill.dataset.lat]); return; }
  const card = t.closest('[data-node]');
  if (card) { testNodes([card.dataset.node]); return; }
  const head = t.closest('[data-head]');
  if (head) {
    const gid = head.dataset.head;
    S.closedGroups.has(gid) ? S.closedGroups.delete(gid) : S.closedGroups.add(gid);
    localStorage.setItem('db.closed', JSON.stringify([...S.closedGroups]));
    renderGroups();
  }
}
async function testNodes(ids, group) {
  if (!ids || !ids.length) return;
  const CHUNK = 12; // 分片串行测速：避免 90+ 节点单个长 mutation 一失败全损
  ids.forEach(id => S.testing.add(id));
  if (group) S.testingGroups.add(group.id);
  renderGroups(); renderNodesTable();
  let done = 0;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      if (ids.length > CHUNK) toast(`测速中 ${Math.min(i + CHUNK, ids.length)}/${ids.length}…`);
      const res = await api.test(part);
      applyLatencies(res);
      done += part.length;
      renderGroups(); renderNodesTable();
    }
    toast(`测速完成（${done} 个节点）`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast(`测速失败：${e.message}（已完成 ${done}/${ids.length}）`, 'err');
  } finally {
    ids.forEach(id => S.testing.delete(id));
    if (group) S.testingGroups.delete(group.id);
    renderGroups(); renderNodesTable();
  }
}
async function addNodesModal(g) {
  if (!g) return;
  const st = steerGet(g.id);
  if (st && st.mode === 'region') return toast('该分组处于区域托管状态，请先切回「全局」再手动增删成员', 'err');
  const inPool = new Set((g.pool || g.nodes).map(n => n.id));
  let all = S.nodesAll;
  if (!all || !all.length) {
    const data = await api.nodesPage();
    const byId = new Map();
    for (const s of data.subscriptions || []) for (const n of (s.nodes && s.nodes.edges) || []) byId.set(n.id, { ...n, subTag: s.tag });
    for (const n of (data.nodes && data.nodes.edges) || []) if (!byId.has(n.id)) byId.set(n.id, { ...n, subTag: '' });
    all = [...byId.values()];
    S.nodesAll = all;
  }
  const cands = all.filter(n => !inPool.has(n.id));
  if (!cands.length) return toast('没有可添加的节点（全部已在该分组）', 'err');
  const ms = id => { const l = S.lat.get(id); return l && l.alive ? l.latencyMs + 'ms' : '—'; };
  const fixedNote = g.policy === 'fixed' ? '<span style="color:var(--yellow)">当前策略 fixed 只允许单节点，添加后应用时会自动切换为 min_avg10（想保留 fixed 单节点请用卡片上的 📌）。</span><br>' : '';
  // 按订阅分组 → 标签页 + 双列网格
  const bySub = new Map();
  for (const n of cands) {
    const k = n.subTag || '独立节点';
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(n);
  }
  const tabs = [...bySub.keys()];
  const item = n => `<label class="addnode-item" title="${esc(n.name)}"><input type="checkbox" class="modal-input" data-key="${esc(n.id)}"><span class="nn">${esc(n.name)}</span><span class="pp">${esc((n.protocol || '').toUpperCase())} ${ms(n.id)}</span></label>`;
  const html = `
    <div class="addnode-tabs">${tabs.map((t, i) => `<button type="button" class="addnode-tab${i === 0 ? ' on' : ''}" data-tab="${esc(t)}">${esc(t)} <span class="cnt">${bySub.get(t).length}</span></button>`).join('')}</div>
    ${tabs.map((t, i) => `
    <div class="addnode-pane${i === 0 ? '' : ' hide'}" data-pane="${esc(t)}">
      <div class="addnode-ops"><button type="button" class="addnode-mini" data-selg="${esc(t)}">全选本组</button><button type="button" class="addnode-mini" data-deselg="${esc(t)}">清空本组</button></div>
      <div class="addnode-grid">${bySub.get(t).map(item).join('')}</div>
    </div>`).join('')}
    <div class="addnode-selinfo">已选 <b id="addnode-count">0</b> / ${cands.length} 个</div>`;
  const p = showModal({ title: `添加节点到分组「<b>${esc(g.name)}</b>」${fixedNote}`, wide: true, fields: [{ type: 'html', html }] });
  const fb = $('#modal-fields');
  const onCmd = e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      $$('#modal-fields .addnode-tab').forEach(b => b.classList.toggle('on', b === tabBtn));
      const k = tabBtn.dataset.tab;
      $$('#modal-fields .addnode-pane').forEach(pane => pane.classList.toggle('hide', pane.dataset.pane !== k));
      return;
    }
    const sel = e.target.closest('[data-selg]');
    if (sel) { $$(`#modal-fields .addnode-pane[data-pane="${CSS.escape(sel.dataset.selg)}"] input[type=checkbox]`).forEach(c => { c.checked = true; }); onChg(); }
    const desel = e.target.closest('[data-deselg]');
    if (desel) { $$(`#modal-fields .addnode-pane[data-pane="${CSS.escape(desel.dataset.deselg)}"] input[type=checkbox]`).forEach(c => { c.checked = false; }); onChg(); }
  };
  const onChg = () => {
    const el = document.getElementById('addnode-count');
    if (el) el.textContent = String($$('#modal-fields input[type=checkbox]:checked').length);
  };
  fb.addEventListener('click', onCmd);
  fb.addEventListener('change', onChg);
  let out;
  try { out = await p; } finally { fb.removeEventListener('click', onCmd); fb.removeEventListener('change', onChg); }
  if (!out) return;
  const ids = Object.keys(out).filter(k => out[k]);
  if (!ids.length) return toast('未勾选任何节点', 'err');
  const needPolicy = g.policy === 'fixed';
  // 乐观更新：先把节点并进本地组并重绘
  const byId = new Map((S.nodesAll || []).map(n => [n.id, n]));
  const have = new Set((g.nodes || []).map(n => n.id));
  for (const id of ids) {
    const n = byId.get(id);
    if (n && !have.has(id)) { (g.nodes = g.nodes || []).push(n); have.add(id); }
  }
  if (needPolicy) g.policy = 'min_avg10';
  buildPool(g);
  if (S.page === 'proxies') renderGroups();
  try {
    if (st) { const all = steerLoadAll(); delete all[g.id]; await steerPersist(all); }
    await api.addNodes(g.id, ids);
    if (needPolicy) await api.setPolicy(g.id, 'min_avg10', []);
    api.run().catch(() => toast('run 失败：配置可能未生效，请点顶栏「应用改动」', 'err'));
    toast(`已添加 ${ids.length} 个节点到「${g.name}」${st ? '（已退出钉选）' : ''}${needPolicy ? '，fixed 多节点受限已自动切换 min_avg10' : ''}`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('添加失败：' + e.message, 'err');
    refreshGroups(true);
    return;
  }
  setTimeout(() => refreshGroups(false), 0);
}
async function delNodeAction(nodeId) {
  const n = S.nodesAll.find(x => x.id === nodeId) ||
    S.groups.flatMap(g => (g.pool || g.nodes)).find(x => x.id === nodeId);
  const name = n ? n.name : nodeId;
  if (!(await showConfirm(
    `确定从 daed 删除节点「<b>${esc(name)}</b>」？<br><span style="color:var(--yellow)">所在分组的成员会自动同步移除；订阅里的节点可能被订阅更新重新导入。</span>`))) return;
  // 乐观更新：立刻从本地列表消失，失败再回源回滚
  S.nodesAll = (S.nodesAll || []).filter(x => x.id !== nodeId);
  for (const g of S.groups) {
    if (g.nodes) g.nodes = g.nodes.filter(x => x.id !== nodeId);
    if (g.pool) g.pool = g.pool.filter(x => x.id !== nodeId);
  }
  S.lat.delete(nodeId);
  if (S.page === 'proxies') renderGroups();
  else if (S.page === 'nodes') renderNodesTable();
  try {
    await api.removeNodesBatch([nodeId]);
    toast(`已删除「${name}」`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('删除失败：' + e.message, 'err');
    if (S.page === 'proxies') refreshGroups(true);
    else if (S.page === 'nodes') refreshNodesPage(true);
    return;
  }
  setTimeout(() => {
    if (S.page === 'proxies') refreshGroups(false);
    else if (S.page === 'nodes') refreshNodesPage(false);
  }, 0);
}
function renderNodesTable() {
  if (S.page !== 'nodes') return;
  const box = $('#nd-table');
  if (!box) return;
  if (!S.nodesAll.length) { box.innerHTML = '<div class="empty">无节点</div>'; return; }
  const list = S.nodesAll.filter(nodeTableVisible);
  const groupsOf = n => S.groups.filter(g => (g.pool || g.nodes).some(x => x.id === n.id)).map(g => g.name).join(', ');
  // 轮询重渲染前后保持用户勾选（按节点 id 快照回填）
  const keep = new Set($$('#nd-table tbody input[type=checkbox]:checked').map(i => i.value));
  box.innerHTML = `<table class="tbl"><thead><tr>
      <th style="width:26px"><input type="checkbox" id="nd-chkall"></th><th>节点</th><th>协议</th><th>标签</th><th>来源</th><th>所在分组</th><th>延迟</th><th>状态</th><th>测速时间</th>
    </tr></thead><tbody>
    ${list.map(n => {
      const l = S.lat.get(n.id);
      return `<tr>
        <td><input type="checkbox" value="${n.id}"></td>
        <td>${esc(n.name)}</td>
        <td>${esc((n.protocol || '').toUpperCase())}</td>
        <td class="tag-cell">${esc(n.tag || '')}</td>
        <td class="tag-cell">${esc(n.subTag || '独立节点')}</td>
        <td class="tag-cell">${esc(groupsOf(n) || '—')}</td>
        <td>${latPill(n.id)}</td>
        <td>${l ? (l.alive ? '<span style="color:var(--green)">存活</span>' : `<span style="color:var(--red)" title="${esc(l.message || '')}">不可用</span>`) : '—'}</td>
        <td class="mono tag-cell">${ago(parseTime(l && l.testedAt)) || '—'}</td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
  if (keep.size) $$('#nd-table tbody input[type=checkbox]').forEach(i => { if (keep.has(i.value)) i.checked = true; });
  const chk = $('#nd-chkall');
  if (chk) {
    chk.checked = list.length > 0 && keep.size >= list.length;
    chk.onchange = () => $$('#nd-table tbody input[type=checkbox]').forEach(i => { i.checked = chk.checked; });
  }
}

/* ================= 页面：概览 ================= */
function pageOverview(el) {
  el.innerHTML = `<div id="ov-body"><div class="empty">加载中…</div></div>`;
  refreshGeneral();
}
let ovGroupsTs = 0; // 1.10 上次把 groups/nodeLatencies 并进概览查询的时刻
async function refreshGeneral() {
  if (S.inflight.has('general')) return;
  S.inflight.add('general');
  try {
    const backfill = S.ovBuf.length < 60;                                   // 1.2 缓冲不足 → 回填 10 分钟
    const wantGroups = Date.now() - ovGroupsTs > Math.max(10, S.cfg.groupSec - 5) * 1000;
    if (wantGroups) ovGroupsTs = Date.now();
    const d = await api.overview({ backfill, withLatency: wantGroups && !!S.groups.length });
    S.general = d.general;
    mergeSamples(S.general && S.general.runtimeOverview);
    if (!S.cfgGlobal) { try { S.cfgGlobal = (await api.configsAll()).find(x => x.selected) || null; } catch {} }
    if (!S.subs || !S.subs.length) { try { S.subs = (await api.nodesPage()).subscriptions || []; } catch {} }
    if (d.groups) applyGroupsPayload(d.groups, d.nodeLatencies);            // 1.10 与速率同一往返返回
    renderOverview();
    updateNavState();
    } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
  } finally { S.inflight.delete('general'); }
}
function mergeSamples(ov) {
  if (!ov || !Array.isArray(ov.samples)) return;
  const have = new Set(S.ovBuf.map(s => s.ts));
  for (const s of ov.samples) {
    const ts = parseTime(s.timestamp);
    if (ts == null || have.has(ts)) continue;
    S.ovBuf.push({ ts, up: s.uploadRate || 0, down: s.downloadRate || 0 });
  }
  S.ovBuf.sort((a, b) => a.ts - b.ts);
  if (S.ovBuf.length > 900) S.ovBuf = S.ovBuf.slice(-900);
}
/* 1.3 按**时间戳**取窗口：不要用 slice(-N) 切片——采样密度一变，点数含义就变了
 *（-120 在 5.25s/点时是 10 分钟，在 2.75s/点时只有 5.5 分钟）。 */
function ovWindow(sec) {
  if (!S.ovBuf.length) return [];
  const t1 = S.ovBuf[S.ovBuf.length - 1].ts;
  const from = t1 - sec * 1000;
  const i = S.ovBuf.findIndex(s => s.ts >= from);
  return i <= 0 ? S.ovBuf.slice() : S.ovBuf.slice(i);
}
/* 概览页本轮的全部动态值（结构层与数值层共用，避免两处各算一遍） */
function ovModel() {
  const g = S.general, ov = g.runtimeOverview || {};
  // 1.1 KPI 用最近 2 个采样点均值（≈5.5s 窗口，比改动前的 6 点均值 / 22.5s 快 4 倍）。
  // 瞬时值单独展示：顶层 uploadRate 是 daed 0.25s 网格的最新样本，空闲时实测会直接掉到 0，
  // 拿它当主数字会闪，所以主数字用 2 点均值，瞬时值放刻度行。
  const tail = S.ovBuf.slice(-2);
  const upNow = tail.length ? tail.reduce((a, s) => a + s.up, 0) / tail.length : ov.uploadRate || 0;
  const downNow = tail.length ? tail.reduce((a, s) => a + s.down, 0) / tail.length : ov.downloadRate || 0;
  const upInstant = ov.uploadRate || 0, downInstant = ov.downloadRate || 0;
  const win = ovWindow(600);
  const dlSpark = win.map(s => s.down), ulSpark = win.map(s => s.up);
  const memSpark = memHistLoad().slice(-60).map(p => p.kb / 1024);
  const memMB = S.memAvailKB ? Math.round(S.memAvailKB / 1024) : null;
  let aliveN = 0, totalN = 0;
  for (const gr of S.groups) for (const n of (gr.pool || gr.nodes || [])) { totalN++; const l = S.lat.get(n.id); if (l && l.alive) aliveN++; }
  const peak = Math.max(0, ...win.map(s => Math.max(s.up, s.down)));
  const ax = {
    start: win.length ? hhmm(win[0].ts) : '',
    end: win.length ? hhmm(win[win.length - 1].ts) : '',
    peak: fmtRate(peak),
  };
  const cfg = S.cfgGlobal && S.cfgGlobal.global ? S.cfgGlobal.global : {};
  const guardTail = S.guardLog || [];
  const tasks = [
    ...(S.subs || []).map(s => ({ st: s.cronEnable ? 'run' : 'idle', icon: s.cronEnable ? '⟳' : '◦',
      name: `订阅「${s.tag || s.id}」`, tags: [s.cronEnable ? `cron ${s.cronExp}` : '手动'],
      m: `节点 ${s.nodes && s.nodes.totalCount != null ? s.nodes.totalCount : '—'} 个 · 上次更新 ${ago(parseTime(s.updatedAt)) || '—'}`, acts: [] })),
    { st: guardTail.length && /restart/.test(guardTail[0]) ? 'warn' : 'ok', icon: '🛡', name: '内存守卫 daed-guard',
      tags: ['阈值 180MB', '连续 2 天确认'], m: guardTail.length ? guardTail[0] : '每日 04:30 检查 · 暂无记录', acts: [] },
    { st: 'idle', icon: '⚡', name: '场景预设', tags: ['日常模式'], m: '设置页一键切换托管/策略/日志组合', acts: [{ n: '去设置', nav: 'settings' }] },
  ];
  return { g, ov, upNow, downNow, upInstant, downInstant, dlSpark, ulSpark, memSpark, memMB,
           aliveN, totalN, cfg, guardTail, tasks, ax };
}
/* 结构键：只有会改变元素「集合 / 顺序」的东西才进来；纯数值变化交给 ovUpdate() 定点更新。
 * 改动前每次 3s 轮询都重建整页 innerHTML → 闪烁、丢滚动位置与展开态、手机端掉帧。 */
function ovStructKey() {
  const g = S.general || {}, cfg = (S.cfgGlobal && S.cfgGlobal.global) || {};
  return [
    S.groups.map(gr => [gr.id, gr.name, gr.policy, (gr.pool || gr.nodes || []).length,
      steerGet(gr.id) ? 'S' : '-', recentFor(gr) ? 'R' : '-',
      gr.policy === 'fixed' && fixedNodeFor(gr) ? fixedNodeFor(gr).id : '-'].join('|')).join(','),
    (S.subs || []).map(s => [s.id, s.cronEnable ? 1 : 0, s.nodes && s.nodes.totalCount].join('|')).join(','),
    (S.guardLog || []).length,
    g.dae ? [g.dae.running, g.dae.modified, g.dae.version].join('|') : '',
    cfg.dialMode, cfg.logLevel, cfg.checkInterval, cfg.checkTolerance,
  ].join('~');
}
function ovHtml(m) {
  const { g, ov, upNow, downNow, dlSpark, ulSpark, memSpark, memMB,
          aliveN, totalN, cfg, tasks, ax } = m;
  return `
  <div class="kpi-grid">
    <div class="card kpi"><div class="lbl">下载速率</div>
      <div class="val" id="kpi-dl-val" style="color:var(--primary)">${fmtRate(downNow)}<small>↓</small></div>
      <div class="ctx" id="kpi-dl-ctx">累计 ↓${fmtBytes(ov.downloadTotal)} · 瞬时 ${fmtRate(ov.downloadRate || 0)}</div>
      <div class="spark" id="sp-dl">${dlSpark.length >= 2 ? sparkline(dlSpark, 'var(--primary)') : ''}</div></div>
    <div class="card kpi"><div class="lbl">上传速率</div>
      <div class="val" id="kpi-ul-val" style="color:var(--success)">${fmtRate(upNow)}<small>↑</small></div>
      <div class="ctx" id="kpi-ul-ctx">累计 ↑${fmtBytes(ov.uploadTotal)} · 瞬时 ${fmtRate(ov.uploadRate || 0)}</div>
      <div class="spark" id="sp-ul">${ulSpark.length >= 2 ? sparkline(ulSpark, 'var(--success)') : ''}</div></div>
    <div class="card kpi"><div class="lbl">活动连接</div>
      <div class="val" id="kpi-conn-val">${ov.activeConnections ?? '—'}<small>会话</small></div>
      <div class="ctx" id="kpi-conn-ctx">UDP ${ov.udpSessions ?? '—'} · 仅代理出站记录</div></div>
    <div class="card kpi"><div class="lbl">内存可用</div>
      <div class="val" id="kpi-mem-val" style="color:${memMB != null && memMB < 180 ? 'var(--warning)' : ''}">${memMB ?? '—'}<small>MB</small></div>
      <div class="ctx"><span class="warnt">阈值 180 / 红线 150</span></div>
      <div class="spark" id="sp-mem">${memSpark.length >= 2 ? sparkline(memSpark, 'var(--warning)') : ''}</div></div>
    <div class="card kpi"><div class="lbl">节点存活</div>
      <div class="val" id="kpi-alive-val">${aliveN}<small>/ ${totalN}</small></div>
      <div class="ctx" id="kpi-alive-ctx">${S.groups.length} 个分组 · min 策略自动择优</div></div>
  </div>

  <div class="ov-grid">
    <section class="card span8">
      <div class="card-head"><h2>实时速率</h2><span class="sub">来源 runtimeOverview 采样</span>
        <span class="spacer"></span>
        <span class="legend"><span class="lg-dl"><i></i>下载</span><span class="lg-ul"><i></i>上传</span></span></div>
      <div class="chart-meta"><span class="big pdn" id="ov-big-dl">${fmtRate(downNow)}<i>下载</i></span><span class="big pub" id="ov-big-ul">${fmtRate(upNow)}<i>上传</i></span>
        <span class="hint" id="ov-updated">更新于 ${hhmm(parseTime(ov.updatedAt)) || '—'}</span></div>
      <div class="chart-wrap" id="ov-chart"></div>
      <div class="chart-axis"><span id="ax-start">${ax.start}</span><span id="ax-peak">峰值 ${ax.peak}</span><span id="ax-end">${ax.end}</span></div>
    </section>

    <section class="card span4">
      <div class="card-head"><h2>系统状态</h2><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-nav="config">配置 →</button></div>
      <div class="state-list">
        ${[
          { k: '运行状态', v: g.dae.running ? '运行中' : '已停止', tag: g.dae.running ? 'ok' : 'err' },
          { k: '核心版本', v: g.dae.version || '—' },
          { k: '配置状态', v: g.dae.modified ? '有改动未应用' : '已生效', tag: g.dae.modified ? 'warn' : 'ok' },
          { k: '拨号模式', v: cfg.dialMode || '—' },
          { k: '日志级别', v: cfg.logLevel || '—' },
          { k: '测速间隔', v: (cfg.checkInterval || '—') + ' / 容差 ' + (cfg.checkTolerance || '—') },
          { k: '内存可用', v: memMB != null ? memMB + ' MB' : '—', tag: memMB != null && memMB < 180 ? 'warn' : 'ok' },
        ].map((s, i) => `<div class="state-row"><span class="k">${esc(s.k)}</span><span class="v" id="stv-${i}" title="${esc(s.v)}">${esc(s.v)}</span>${s.tag ? `<span class="tag ${s.tag}" id="stt-${i}">${s.tag === 'ok' ? '正常' : s.tag === 'warn' ? '注意' : '停止'}</span>` : ''}</div>`).join('')}
      </div>
    </section>

    <section class="card span8">
      <div class="card-head"><h2>实时速率</h2><span class="sub">来源 runtimeOverview 采样</span>
        <span class="spacer"></span>
        <span class="legend"><span class="lg-dl"><i></i>下载</span><span class="lg-ul"><i></i>上传</span></span></div>
      <div class="chart-meta"><span class="big pdn" id="ov-big-dl">${fmtRate(downNow)}<i>下载</i></span><span class="big pub" id="ov-big-ul">${fmtRate(upNow)}<i>上传</i></span>
        <span class="hint" id="ov-updated">更新于 ${hhmm(parseTime(ov.updatedAt)) || '—'}</span></div>
      <div class="chart-wrap" id="ov-chart"></div>
      <div class="chart-axis"><span id="ax-start">${ax.start}</span><span id="ax-peak">峰值 ${ax.peak}</span><span id="ax-end">${ax.end}</span></div>
    </section>

    <section class="card span4">
      <div class="card-head"><h2>系统状态</h2><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-nav="config">配置 →</button></div>
      <div class="state-list">
        ${[
          { k: '运行状态', v: g.dae.running ? '运行中' : '已停止', tag: g.dae.running ? 'ok' : 'err' },
          { k: '核心版本', v: g.dae.version || '—' },
          { k: '配置状态', v: g.dae.modified ? '有改动未应用' : '已生效', tag: g.dae.modified ? 'warn' : 'ok' },
          { k: '拨号模式', v: cfg.dialMode || '—' },
          { k: '日志级别', v: cfg.logLevel || '—' },
          { k: '测速间隔', v: (cfg.checkInterval || '—') + ' / 容差 ' + (cfg.checkTolerance || '—') },
          { k: '内存可用', v: memMB != null ? memMB + ' MB' : '—', tag: memMB != null && memMB < 180 ? 'warn' : 'ok' },
        ].map((s, i) => `<div class="state-row"><span class="k">${esc(s.k)}</span><span class="v" id="stv-${i}" title="${esc(s.v)}">${esc(s.v)}</span>${s.tag ? `<span class="tag ${s.tag}" id="stt-${i}">${s.tag === 'ok' ? '正常' : s.tag === 'warn' ? '注意' : '停止'}</span>` : ''}</div>`).join('')}
      </div>
    </section>

    <section class="card span8">
      <div class="card-head"><h2>定时任务与后台操作</h2><span class="sub">订阅 cron · 内存守卫 · 场景预设</span></div>
      ${tasks.map((t, i) => `
      <div class="task">
        <span class="st ${t.st}" aria-hidden="true">${t.icon}</span>
        <div class="ti"><b>${esc(t.name)} ${t.tags.map(x => `<span class="tag ${x.includes('阈值') || x.includes('cron') ? 'p' : ''}">${esc(x)}</span>`).join('')}</b>
          <div class="m" id="task-m-${i}">${esc(t.m)}</div></div>
        <div class="ta">${t.acts.map(a => `<button class="btn btn-sm" data-nav="${a.nav}">${esc(a.n)}</button>`).join('')}</div>
      </div>`).join('')}
    </section>

    <section class="card span12">
      <div class="card-head"><h2>分组实际出口</h2><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-nav="logs">出口记录 →</button></div>
      <div class="card-pad">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        ${S.groups.map((gr, i) => {
          const rec = recentFor(gr);
          const pred = predictFor(gr);
          const fixed = gr.policy === 'fixed' ? fixedNodeFor(gr) : null;
          const st = steerGet(gr.id);
          return `<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <b style="font-size:13px">${esc(gr.name)}</b>
            <span class="tag p">${esc(gr.policy)}</span>
            ${st ? '<span class="tag ok">托管</span>' : ''}
            <span class="hint" style="margin-left:auto">${(gr.pool || gr.nodes || []).length} 节点</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:12.5px">
            <span class="dot on"></span><span id="exit-${i}-name" style="color:var(--success);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fixed ? '🔒 ' + esc(fixed.name) : (rec ? esc(rec.name) : '—')}</span>
            <span class="hint" id="exit-${i}-ago" style="margin-left:auto">${rec ? ago(rec.ts) : ''}</span>
          </div>
          ${!fixed ? `<div class="hint" id="exit-${i}-pred">${pred ? `预计出口 ${esc(pred.node.name)}（按 min_avg10 近似；当前策略 ${esc(gr.policy)}）` : ''}</div>` : ''}
        </div>`;
        }).join('')}
        </div>
        <div class="hint" style="border-top:1px solid var(--border);margin-top:14px;padding-top:10px">真值来自连接日志 dialer 字段；直连/拦截流量不产生日志。</div>
      </div>
    </section>
  </div>`;
}
function bindOverviewEvents() {}
/* 1.9 数值层：只写需要变的节点，不重建 DOM */
function ovUpdate(m) {
  const { ov, upNow, downNow, upInstant, downInstant, dlSpark, ulSpark, memSpark, memMB,
          aliveN, totalN, ax, cfg, g } = m;
  const el = id => document.getElementById(id);
  const txt = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  const html = (id, v) => { const e = el(id); if (e) e.innerHTML = v; };

  html('kpi-dl-val', `${fmtRate(downNow)}<small>↓</small>`);
  txt('kpi-dl-ctx', `累计 ↓${fmtBytes(ov.downloadTotal)} · 瞬时 ${fmtRate(downInstant)}`);
  html('kpi-ul-val', `${fmtRate(upNow)}<small>↑</small>`);
  txt('kpi-ul-ctx', `累计 ↑${fmtBytes(ov.uploadTotal)} · 瞬时 ${fmtRate(upInstant)}`);
  html('kpi-conn-val', `${ov.activeConnections ?? '—'}<small>会话</small>`);
  txt('kpi-conn-ctx', `UDP ${ov.udpSessions ?? '—'} · 仅代理出站记录`);
  const memEl = el('kpi-mem-val');
  if (memEl) {
    memEl.style.color = memMB != null && memMB < 180 ? 'var(--warning)' : '';
    memEl.innerHTML = `${memMB ?? '—'}<small>MB</small>`;
  }
  html('kpi-alive-val', `${aliveN}<small>/ ${totalN}</small>`);
  txt('kpi-alive-ctx', `${S.groups.length} 个分组 · min 策略自动择优`);
  html('sp-dl', dlSpark.length >= 2 ? sparkline(dlSpark, 'var(--primary)') : '');
  html('sp-ul', ulSpark.length >= 2 ? sparkline(ulSpark, 'var(--success)') : '');
  html('sp-mem', memSpark.length >= 2 ? sparkline(memSpark, 'var(--warning)') : '');

  html('ov-big-dl', `${fmtRate(downNow)}<i>下载</i>`);
  html('ov-big-ul', `${fmtRate(upNow)}<i>上传</i>`);
  txt('ov-updated', `更新于 ${hhmm(parseTime(ov.updatedAt)) || '—'}`);
  rateChartInto($('#ov-chart'));
  txt('ax-start', ax.start);
  txt('ax-peak', `峰值 ${ax.peak}`);
  txt('ax-end', ax.end);

  // 系统状态 7 行
  const states = [
    { v: g.dae.running ? '运行中' : '已停止', tag: g.dae.running ? 'ok' : 'err' },
    { v: g.dae.version || '—' },
    { v: g.dae.modified ? '有改动未应用' : '已生效', tag: g.dae.modified ? 'warn' : 'ok' },
    { v: cfg.dialMode || '—' },
    { v: cfg.logLevel || '—' },
    { v: (cfg.checkInterval || '—') + ' / 容差 ' + (cfg.checkTolerance || '—') },
    { v: memMB != null ? memMB + ' MB' : '—', tag: memMB != null && memMB < 180 ? 'warn' : 'ok' },
  ];
  states.forEach((s, i) => {
    txt(`stv-${i}`, s.v);
    const t = el(`stt-${i}`);
    if (t) t.textContent = s.tag === 'ok' ? '正常' : s.tag === 'warn' ? '注意' : '停止';
    if (t) t.className = 'tag ' + (s.tag || '');
  });


  // 定时任务行的相对时间
  m.tasks.forEach((t, i) => txt(`task-m-${i}`, t.m));

  // 分组实际出口
  S.groups.forEach((gr, i) => {
    const rec = recentFor(gr), pred = predictFor(gr);
    const fixed = gr.policy === 'fixed' ? fixedNodeFor(gr) : null;
    html(`exit-${i}-name`, fixed ? '🔒 ' + esc(fixed.name) : (rec ? esc(rec.name) : '—'));
    txt(`exit-${i}-ago`, rec ? ago(rec.ts) : '');
    const p = el(`exit-${i}-pred`);
    if (p) p.textContent = pred ? `预计出口 ${pred.node.name}（按 min_avg10 近似；当前策略 ${gr.policy}）` : '';
  });
}
function renderOverview() {
  const box = $('#ov-body');
  if (!box || !S.general) return;
  const m = ovModel();
  const key = ovStructKey();
  if (key !== S._ovKey || !box.querySelector('.kpi-grid')) {   // 结构变了才重建骨架
    S._ovKey = key;
    box.innerHTML = ovHtml(m);
    bindOverviewEvents();
  }
  ovUpdate(m);                                                 // 每次轮询只走定点更新
}

/* ================= SVG 图表生成器 ================= */
function sparkline(vals, color, w = 120, h = 30) {
  if (!vals || vals.length < 2) return '';
  const max = Math.max(...vals), min = Math.min(...vals);
  const X = i => i / (vals.length - 1) * w;
  const Y = v => h - (v - min) / (max - min || 1) * (h - 4) - 2;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity=".12"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity=".85"/></svg>`;
}
function rateChartInto(box) {
  if (!box) return;
  const buf = ovWindow(600);                    // 1.3 按时间窗（近 10 分钟）取，不按点数切
  if (buf.length < 2) { box.innerHTML = '<div class="hint" style="padding:16px">速率采样中…（每 3 秒拉一次；单点间隔由 daed 采样密度决定）</div>'; return; }
  const W = 600, H = 168, pad = 6;
  const maxV = Math.max(1, ...buf.map(s => Math.max(s.up, s.down))) * 1.15;
  const X = i => pad + i / (buf.length - 1) * (W - pad * 2);
  const Y = v => H - pad - v / maxV * (H - pad * 2);
  const path = key => buf.map((s, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(s[key]).toFixed(1)}`).join('');
  const area = key => `${path(key)}L${X(buf.length - 1).toFixed(1)},${H - pad}L${X(0).toFixed(1)},${H - pad}Z`;
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${W}" y1="${(H * f) | 0}" y2="${(H * f) | 0}" stroke="var(--border)" stroke-width="1"/>`).join('');
  const yLab = [0, 0.5, 1].map(f => `<text x="${pad}" y="${(H - pad - f * (H - pad * 2)) - 3}" font-size="9" fill="var(--text-3)" font-family="var(--mono)">${fmtRate(maxV * f)}</text>`).join('');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近 10 分钟下载与上传速率">
    ${grid}${yLab}
    <path d="${area('down')}" fill="var(--primary)" opacity=".10"/>
    <path d="${path('down')}" fill="none" stroke="var(--primary)" stroke-width="var(--seed-chart-weight)" vector-effect="non-scaling-stroke"/>
    <path d="${area('up')}" fill="var(--success)" opacity=".08"/>
    <path d="${path('up')}" fill="none" stroke="var(--success)" stroke-width="calc(var(--seed-chart-weight) * .85)" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
/* ================= 页面：出口记录 ================= */
function cgiUrl(params) {
  const q = params ? '?' + params.toString() : '';
  try { const u = new URL(S.cfg.backend); return `http://${u.hostname}/cgi-bin/daed-board-log${q}`; }
  catch { return `/cgi-bin/daed-board-log${q}`; }
}
let cgiWarned = false;
async function refreshLog(manual) {
  if (S.inflight.has('log')) return;
  S.inflight.add('log');
  try {
    // 3.2 增量读取：客户端持游标 (inode, off)，服务端不落状态文件
    const p = new URLSearchParams();
    if (manual || !S.logCur.inode) p.set('reset', '1');
    else { p.set('inode', S.logCur.inode); p.set('off', S.logCur.off); }
    const r = await fetchTimeout(cgiUrl(p), {}, 10000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let text = await r.text();
    const mem = /^#MEM\s+(\d+)/m.exec(text);
    if (mem) { S.memAvailKB = +mem[1]; memHistSample(); }
    // 守卫事件 → 通知中心（去重后推送）
    const gLines = text.split(String.fromCharCode(10)).filter(l => l.startsWith('#GUARD ')).map(l => l.slice(7).trim());
    if (gLines.length !== (S.guardLog || []).length || gLines.some((l, i2) => l !== (S.guardLog || [])[i2])) {
      const known = new Set(S.guardLog || []);
      S.guardLog = gLines;
    }
    text = text.replace(/^#GUARD .*$/mg, '');
    // #META：本次切片的起点与"是否回填"；据此推进游标
    const meta = /^#META inode=(\d+) size=(\d+) off=(\d+) reset=(\d)/m.exec(text);
    if (meta) {
      // 从 #META 那一行的换行之后开始算日志体（CGI 保证 #META 是控制段的最后一行）。
      // 注意不要用 replace(/^#META .*$/mg,'')：那样会留下该行的换行符，
      // 被算进游标就会让偏移多 1 字节 → 下一批的第一行被截断丢掉。
      text = text.slice(text.indexOf('\n', meta.index) + 1);
      // 只消费到最后一个换行：末尾若是不完整的行，就留给下次读（否则会把半行喂给解析器）
      const nl = text.lastIndexOf('\n');
      const consumed = nl === -1 ? '' : text.slice(0, nl + 1);
      // dialer 里带 emoji：JS 的 String.length 是 UTF-16 码元数 ≠ 字节数，必须用 TextEncoder 计字节
      S.logCur = { inode: +meta[1], off: (+meta[3]) + new TextEncoder().encode(consumed).length };
    }
    ingestLog(text);
    renderLogPage();
    if (S.page === 'proxies') renderGroups();      // 实际出口即刻反映
    else if (S.page === 'overview') renderOverview();
  } catch (e) {
    if (manual || !cgiWarned) { toast('日志接口不可用：' + e.message + '（确认路由器已部署 /www/cgi-bin/daed-board-log）', 'err'); cgiWarned = true; }
  } finally { S.inflight.delete('log'); }
}
function pageLogs(el) {
  el.innerHTML = `
    <div class="toolbar">
      <span class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="search" id="lg-search" placeholder="筛选：域名 / IP / MAC / 节点…" value="${esc(S.logFilter)}"></span>
      <select class="select" id="lg-ob"><option value="">全部出站</option></select>
      <span class="spacer"></span>
      <span class="hint" id="lg-count"></span>
      <button class="btn btn-sm" id="lg-refresh">⟳ 刷新</button>
    </div>
    <div class="exit-cards" id="lg-exits"></div>
    <div class="card"><div class="table-wrap" id="lg-table"><div class="empty">加载中…</div></div></div>
    <p class="hint" style="margin-top:10px">说明：仅代理出站流量会产生连接日志（直连/拦截不记录）；dialer 字段为每条连接真实选点真值。日志级别需 ≥ info。</p>`;
  $('#lg-search').addEventListener('input', e => { S.logFilter = e.target.value.trim().toLowerCase(); renderLogPage(); });
  $('#lg-ob').addEventListener('change', e => { S.logOb = e.target.value; renderLogPage(); });
  $('#lg-refresh').addEventListener('click', () => refreshLog(true));
  // 一次性委托：行点击复制原始日志（替代每次渲染重绑 400 个监听器）
  $('#lg-table').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-raw]');
    if (!tr || !navigator.clipboard) return;
    navigator.clipboard.writeText(tr.dataset.raw).then(() => toast('已复制原始日志行', 'ok')).catch(() => {});
  });
  refreshLog(false);
}
function shortSrc(src) { return String(src || '').replace(/\s*:\s+:/, ':'); }
function kvRebuild(e) {
  return ['dialer', 'dscp', 'ip', 'mac', 'network', 'outbound', 'pid', 'pname', 'policy', 'sniffed']
    .filter(k => e[k] != null).map(k => `${k}=${e[k]}`).join(' ');
}
function renderLogPage() {
  const table = $('#lg-table');
  if (!table) return;
  const obs = [...new Set(S.logEntries.map(e => e.outbound))];
  const sel = $('#lg-ob');
  if (sel) {
    const cur = S.logOb;
    sel.innerHTML = '<option value="">全部出站</option>' + obs.map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('');
  }
  const exits = $('#lg-exits');
  if (exits) {
    exits.innerHTML = S.groups.map(g => {
      const rec = recentFor(g);
      if (!rec) return '';
      return `<div class="card exit-card">
        <span class="dot-now"></span>
        <div style="min-width:0"><div class="gname">${esc(g.name)} · 最近实际出口</div><div class="node">${esc(rec.name)}</div></div>
        <span class="ago">${ago(rec.ts)}</span>
      </div>`;
    }).join('');
  }
  const f = S.logFilter, ob = S.logOb;
  const rows = S.logEntries.filter(e =>
    (!ob || e.outbound === ob) &&
    (!f || (e.dst + ' ' + (e.sniffed || '') + ' ' + e.src + ' ' + (e.mac || '') + ' ' + (e.dialer || '') + ' ' + e.outbound + ' ' + (e.pname || '')).toLowerCase().includes(f))
  ).slice(0, 400);
  const cnt = $('#lg-count');
  if (cnt) cnt.textContent = `${rows.length} 条 / 共 ${S.logEntries.length}`;
  if (!rows.length) { table.innerHTML = '<div class="empty">暂无匹配的连接记录（等待代理流量产生）</div>'; S._logRenderKey = ''; return; }
  // 内容无变化时跳过 400 行表格重建（出站卡片与计数仍会刷新"n 秒前"）
  const rk = rows.length + '|' + (rows[0] ? rows[0].ts : '') + '|' + (rows[rows.length - 1] ? rows[rows.length - 1].ts : '') + '|' + (ob || '') + '|' + (f || '');
  if (rk === S._logRenderKey && table.querySelector('table')) return;
  S._logRenderKey = rk;
  table.innerHTML = `<table class="tbl"><thead><tr>
      <th>时间</th><th>网络</th><th>来源设备</th><th>目标</th><th>嗅探域名</th><th>出站</th><th>节点（实际）</th><th>策略</th><th>进程</th><th>MAC</th>
    </tr></thead><tbody>
    ${rows.map(e => `<tr data-raw="${esc('[' + new Date(e.ts).toLocaleString() + '] ' + shortSrc(e.src) + ' <-> ' + e.dst + ' ' + kvRebuild(e))}" title="点击复制原始日志行">
      <td class="mono">${hhmm(e.ts)}</td>
      <td>${esc(e.network || '')}</td>
      <td class="mono">${esc(shortSrc(e.src))}</td>
      <td class="mono">${esc(e.dst)}</td>
      <td>${esc(e.sniffed || e.dst.split(':')[0] || '')}</td>
      <td class="ob">${esc(e.outbound)}</td>
      <td class="dl">${esc(e.dialer || '')}</td>
      <td class="tag-cell">${esc(e.policy || '')}</td>
      <td>${esc(e.pname || '')}</td>
      <td class="mono tag-cell">${esc(e.mac || '')}</td>
    </tr>`).join('')}
    </tbody></table>`;
}

/* ================= 页面：节点订阅 ================= */
function pageNodes(el) {
  el.innerHTML = `
    <div class="toolbar">
      <span class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input class="search" id="nd-search" placeholder="搜索节点…" value="${esc(S.nodeFilter)}"></span>
      <select class="select" id="nd-sub"><option value="">全部订阅</option></select>
      <label class="check"><input type="checkbox" id="nd-hide" ${S.cfg.hideUnavail ? 'checked' : ''}> 隐藏不可用</label>
      <label class="check"><input type="checkbox" id="nd-junk" ${S.cfg.showJunk ? 'checked' : ''}> 显示无用节点</label>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="nd-addsub">＋ 导入订阅</button>
      <button class="btn btn-sm" id="nd-addnodes">＋ 批量导入节点</button>
      <button class="btn btn-sm" id="nd-testsel">⚡ 测速选中</button>
      <button class="btn btn-danger btn-sm" id="nd-delnodes">删除选中</button>
      <button class="btn btn-sm" id="nd-testall">⚡ 测速全部</button>
      <button class="btn btn-sm" id="nd-refresh" title="刷新">⟳ 刷新</button>
    </div>
    <div class="section-title">订阅源</div>
    <div class="sub-grid" id="nd-subs"><div class="empty">加载中…</div></div>
    <div class="section-title">全量节点</div>
    <div class="card"><div class="table-wrap" id="nd-table"><div class="empty">加载中…</div></div></div>`;
  $('#nd-search').addEventListener('input', e => { S.nodeFilter = e.target.value.trim().toLowerCase(); renderNodesTable(); });
  $('#nd-sub').addEventListener('change', e => { S.nodeSub = e.target.value; renderNodesTable(); });
  $('#nd-hide').addEventListener('change', e => { S.cfg.hideUnavail = e.target.checked; saveCfg(); renderNodesTable(); });
  $('#nd-junk').addEventListener('change', e => { S.cfg.showJunk = e.target.checked; saveCfg(); renderNodesTable(); });
  // 一次性事件委托（表格随轮询重渲染，监听器必须挂在容器上）
  $('#nd-table').addEventListener('change', e => {
    if (e.target.id === 'nd-chkall') $$('#nd-table tbody input[type=checkbox]').forEach(i => { i.checked = e.target.checked; });
  });
  $('#nd-table').addEventListener('click', e => {
    const p = e.target.closest('[data-lat]');
    if (p) { e.stopPropagation(); testNodes([p.dataset.lat]); }
  });
  $('#nd-testall').addEventListener('click', () => testNodes(visibleNodeIds()));
  $('#nd-testsel').addEventListener('click', () => {
    const ids = $$('#nd-table tbody input:checked').map(i => i.value);
    if (!ids.length) return toast('未勾选任何节点', 'err');
    testNodes(ids);
  });
  $('#nd-refresh').addEventListener('click', () => refreshNodesPage(true));
  $('#nd-addsub').addEventListener('click', subImport);
  $('#nd-addnodes').addEventListener('click', nodesImport);
  $('#nd-delnodes').addEventListener('click', nodesDelete);
  $('#nd-subs').addEventListener('click', e => {
    const btn = e.target.closest('[data-subaction]');
    if (!btn) return;
    const s = S.subs.find(x => x.id === btn.dataset.sid);
    if (!s) return;
    if (btn.dataset.subaction === 'update') subUpdate(s);
    else if (btn.dataset.subaction === 'edit') subEdit(s);
    else if (btn.dataset.subaction === 'del') subDelete(s);
  });
  refreshNodesPage(false);
}
async function refreshNodesPage(manual) {
  if (S.inflight.has('nodes')) return;
  S.inflight.add('nodes');
  try {
    const data = await api.nodesPage();
    const subs = data.subscriptions || [];
    S.subs = subs;
    const byId = new Map();
    for (const s of subs) for (const n of (s.nodes && s.nodes.edges) || []) byId.set(n.id, { ...n, subTag: s.tag });
    for (const n of (data.nodes && data.nodes.edges) || []) if (!byId.has(n.id)) byId.set(n.id, { ...n, subTag: '' });
    S.nodesAll = [...byId.values()];
    const ids = S.nodesAll.map(n => n.id);
    if (ids.length) applyLatencies(await api.latencies(ids));
    renderSubs();
    renderNodesTable();
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    if (manual) toast('加载失败：' + e.message, 'err');
  } finally { S.inflight.delete('nodes'); }
}
function renderSubs() {
  const box = $('#nd-subs');
  if (!box) return;
  const sel = $('#nd-sub');
  if (sel) {
    sel.innerHTML = '<option value="">全部订阅</option>' + S.subs.map(s =>
      `<option value="${esc(s.id)}" ${S.nodeSub === s.id ? 'selected' : ''}>${esc(s.tag || s.id)}${s.nodes ? ' (' + s.nodes.totalCount + ')' : ''}</option>`).join('');
  }
  box.innerHTML = S.subs.map(s => `<div class="card sub-card">
    <div class="sh"><b>${esc(s.tag || ('订阅 ' + s.id))}</b><span class="tag">${s.nodes ? s.nodes.totalCount : '—'} 节点</span>${s.cronEnable && s.cronExp ? `<span class="tag ok">cron ${esc(s.cronExp)}</span>` : '<span class="tag">手动</span>'}</div>
    <div class="meta"><span>上次更新：<span class="mono">${ago(parseTime(s.updatedAt)) || '—'}</span>${s.status ? ' · ' + esc(s.status) : ''}</span></div>
    <div class="info">${esc((s.link || '').length > 60 ? s.link.slice(0, 60) + '…' : (s.link || ''))}</div>
    <div class="hint">${s.info ? esc(String(s.info)) : ''}</div>
    <div class="sub-actions">
      <button class="btn btn-sm" data-subaction="update" data-sid="${s.id}">⟳ 立即更新</button>
      <button class="btn btn-sm" data-subaction="edit" data-sid="${s.id}">✎ 编辑</button>
      <button class="btn btn-sm btn-danger" data-subaction="del" data-sid="${s.id}">删除</button>
    </div>
  </div>`).join('') || '<div class="empty">无订阅</div>';
}
function nodeTableVisible(n) {
  if (!S.cfg.showJunk && isJunk(n)) return false;
  if (S.cfg.hideUnavail && !(S.lat.get(n.id) || {}).alive) return false;
  if (S.nodeSub && n.subscriptionID !== S.nodeSub) return false;
  const f = S.nodeFilter;
  return !f || (n.name + ' ' + (n.protocol || '') + ' ' + (n.tag || '') + ' ' + (n.subTag || '')).toLowerCase().includes(f);
}
function visibleNodeIds() {
  return S.nodesAll.filter(nodeTableVisible).map(n => n.id);
}

/* ---------- 订阅/节点管理动作（P1） ---------- */
async function subUpdate(s) {
  toast(`正在更新订阅「${s.tag}」…（重新拉取并严格对账）`);
  try {
    const r = await api.updateSub(s.id);
    toast(`订阅「${r.tag}」已更新，节点数 ${r.nodes ? r.nodes.totalCount : '—'}`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast(`更新失败：${e.message}（严格对账失败时现有节点保持不变）`, 'err');
  }
  refreshNodesPage(false);
}
async function subEdit(s) {
  const v = await showModal({
    title: `编辑订阅「${esc(s.tag || s.id)}」`,
    fields: [
      { key: 'tag', label: '标签', value: s.tag || '' },
      { key: 'link', label: '订阅链接', value: s.link || '', type: 'textarea', hint: '修改链接后需点「立即更新」才会重新拉取' },
      { key: 'cronExp', label: '更新定时 (cron 表达式)', value: s.cronExp || '', placeholder: '10 */6 * * *' },
      { key: 'cronEnable', label: '启用定时更新', value: !!s.cronEnable, type: 'checkbox' },
    ],
  });
  if (!v) return;
  try {
    if ((v.link || '').trim() && v.link.trim() !== (s.link || '')) await api.updateSubLink(s.id, v.link.trim());
    if ((v.tag || '').trim() && v.tag.trim() !== (s.tag || '')) await api.tagSub(s.id, v.tag.trim());
    if ((v.cronExp || '').trim() !== (s.cronExp || '') || !!v.cronEnable !== !!s.cronEnable) {
      await api.updateSubCron(s.id, (v.cronExp || '').trim(), !!v.cronEnable);
    }
    toast('订阅已保存', 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('保存失败：' + e.message, 'err');
  }
  refreshNodesPage(false);
}
async function subDelete(s) {
  const ok = await showConfirm(
    `确定删除订阅「<b>${esc(s.tag || s.id)}</b>」？<br>其下 <b>${s.nodes ? s.nodes.totalCount : '?'}</b> 个节点将从 daed 移除（所在分组的成员同步减少）；<br>删除后只能通过重新导入订阅恢复。`);
  if (!ok) return;
  try {
    await api.removeSubs([s.id]);
    toast(`订阅「${s.tag}」已删除`, 'ok');
    if (S.nodeSub === s.id) { S.nodeSub = ''; }
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('删除失败：' + e.message, 'err');
  }
  refreshNodesPage(false);
}
async function subImport() {
  const v = await showModal({
    title: '导入订阅',
    fields: [
      { key: 'link', label: '订阅链接', type: 'textarea', placeholder: 'https://…', hint: '导入时会立即拉取一次；拉取失败则不会创建（需检查链接/服务商订阅开关后重试）' },
      { key: 'tag', label: '标签（名称）', placeholder: '如：机场A' },
    ],
  });
  if (!v) return;
  const link = (v.link || '').trim(), tag = (v.tag || '').trim();
  if (!link) return toast('链接不能为空', 'err');
  try {
    const r = await api.importSub(link, tag);
    if (r.error) throw new Error(r.error);
    const bad = (r.nodeImportResult || []).filter(x => x.error);
    toast(`订阅「${r.sub && r.sub.tag || tag}」已导入${r.sub && r.sub.nodes ? '，节点 ' + r.sub.nodes.totalCount + ' 个' : ''}${bad.length ? `；${bad.length} 条链接解析失败` : ''}`, bad.length ? 'err' : 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('导入失败：' + e.message, 'err');
  }
  refreshNodesPage(false);
}
async function nodesImport() {
  const v = await showModal({
    title: '批量导入节点',
    fields: [
      { key: 'links', label: '分享链接（每行一条）', type: 'textarea', placeholder: 'anytls://…\nvless://…\nhy2://…', hint: '支持 dae 认识的任意分享链接格式；单条失败不影响其他（不整批回滚）' },
      { key: 'tag', label: '统一标签（可留空）', placeholder: '如：专线' },
    ],
  });
  if (!v) return;
  const items = (v.links || '').split('\n').map(l => l.trim()).filter(Boolean);
  const badLines = items.filter(l => !/^[a-z][a-z0-9+.-]*:\/\//i.test(l));
  const okLines = items.filter(l => /^[a-z][a-z0-9+.-]*:\/\//i.test(l))
    .map(l => ({ link: l, tag: (v.tag || '').trim() }));
  if (!okLines.length) return toast('没有可导入的链接（每行需为 scheme://… 格式的分享链接）', 'err');
  try {
    const res = await api.importNodesBatch(okLines) || [];
    const bad = res.filter(r => r.error);
    toast(`导入完成：成功 ${res.length - bad.length} / ${res.length}${badLines.length ? `；${badLines.length} 行格式非法已跳过` : ''}${bad.length ? '，' + bad.length + ' 条被 daed 拒绝' : ''}`, (bad.length || badLines.length) ? 'err' : 'ok');
    if (bad.length) console.warn('导入失败明细', bad);
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('导入失败：' + e.message, 'err');
  }
  refreshNodesPage(false);
}
async function nodesDelete() {
  const ids = $$('#nd-table tbody input:checked').map(i => i.value);
  if (!ids.length) return toast('未勾选任何节点', 'err');
  const names = ids.map(id => { const n = S.nodesAll.find(x => x.id === id); return n ? n.name : id; });
  const ok = await showConfirm(
    `确定删除 <b>${ids.length}</b> 个节点？<br>${esc(names.slice(0, 6).join('、'))}${names.length > 6 ? ' 等' : ''}<br><span style="color:var(--yellow)">注意：组内成员会同步移除；订阅里的节点可能被订阅更新重新导入。</span>`);
  if (!ok) return;
  try {
    const n = await api.removeNodesBatch(ids);
    toast(`已删除 ${n} 个节点`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('删除失败：' + e.message, 'err');
  }
  refreshNodesPage(false);
}

/* ================= 场景预设（一键切换常用配置组合） ================= */
const SCENES_KEY = 'daed-board/scenes';
const SCENE_PROXY_GROUP = 'proxy'; // 场景作用的分组名（按名称引用，抗 id 重建）
const BUILTIN_SCENES = [
  { id: 'daily', name: '日常模式', desc: 'proxy=香港托管+min_avg10，日志 info（其他组不动）', actions: [
    { t: 'steer', gname: SCENE_PROXY_GROUP, region: 'HK' },
    { t: 'policy', gname: SCENE_PROXY_GROUP, policy: 'min_avg10' },
    { t: 'log', v: 'info' },
  ] },
  { id: 'auto', name: '全局自动', desc: '取消 proxy 托管/钉选，全池 min_avg10 自动选点', actions: [
    { t: 'unmanage', gname: SCENE_PROXY_GROUP },
    { t: 'policy', gname: SCENE_PROXY_GROUP, policy: 'min_avg10' },
  ] },
  { id: 'debug', name: '诊断模式', desc: '日志级别 → debug（配合出口记录页排查）', actions: [
    { t: 'log', v: 'debug' },
  ] },
  { id: 'quiet', name: '恢复安静', desc: '日志级别 → info', actions: [
    { t: 'log', v: 'info' },
  ] },
];
let sceneBusy = false;

function scenesLoadAll() { try { const a = JSON.parse(localStorage.getItem('db.scenes') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
async function scenesPersist(arr) {
  localStorage.setItem('db.scenes', JSON.stringify(arr));
  try { await api.setStorage([SCENES_KEY], [JSON.stringify(arr)]); } catch {}
}
async function scenesSync() {
  try {
    const vals = await api.getStorage([SCENES_KEY]);
    const v = vals && vals[0];
    if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) { localStorage.setItem('db.scenes', JSON.stringify(arr)); return arr; } }
  } catch {}
  return scenesLoadAll();
}

async function setLogLevel(v) {
  const list = await api.configsAll();
  const cfg = list.find(x => x.selected) || list[0];
  if (!cfg || !cfg.global) throw new Error('未找到当前配置');
  if (cfg.global.logLevel === v) return false;
  const g = { ...cfg.global, logLevel: v };
  await api.updateConfig(cfg.id, g);
  await api.run();
  if (S.cfgGlobal && S.cfgGlobal.id === cfg.id) S.cfgGlobal.obj = g;
  return true;
}

// 把组收敛到目标状态的单个动作（跳过已处于目标状态的情形由调用方预检）
async function execAction(a) {
  const g = S.groups.find(x => x.name === a.gname);
  if (!g) throw new Error('找不到分组 ' + a.gname);
  if (a.t === 'steer') {
    await steerTo(g, a.region, { silent: true });
  } else if (a.t === 'unmanage') {
    await steerRestore(g, true);
  } else if (a.t === 'pin') {
    await pinToNode(g, { name: a.nodeName }, { silent: true });
  } else if (a.t === 'policy') {
    await api.setPolicy(g.id, a.policy, a.policy === 'fixed' ? [{ key: '', val: '0' }] : []);
    await api.run();
  } else if (a.t === 'log') {
    await setLogLevel(a.v);
  }
}
const actionDesc = a => ({
  steer: `「${a.gname}」托管到${regionName(a.region)}`,
  unmanage: `「${a.gname}」取消托管（恢复全池）`,
  pin: `「${a.gname}」钉选节点 ${a.nodeName || ''}`,
  policy: `「${a.gname}」策略 → ${a.policy}`,
  log: `日志级别 → ${a.v}`,
}[a.t] || a.t);

// 场景执行：预检（幂等跳过）→ 确认（含重载次数）→ 串行执行 → 汇报
async function execScene(scene) {
  if (sceneBusy || steerBusy) return toast('有托管操作正在执行…', 'err');
  sceneBusy = true;
  try {
    const plan = [];
    for (const a of scene.actions) {
      if (a.t === 'log') {
        const list = await api.configsAll();
        const cfg = list.find(x => x.selected) || list[0];
        if (!cfg || !cfg.global || cfg.global.logLevel !== a.v) plan.push(a);
        continue;
      }
      const g = S.groups.find(x => x.name === a.gname);
      if (!g) throw new Error('找不到分组 ' + a.gname + '（场景里的分组名需与 daed 中一致）');
      if (a.t === 'steer') {
        const st = steerGet(g.id);
        if (!(st && st.mode === 'region' && st.region === a.region)) plan.push(a);
      } else if (a.t === 'unmanage') {
        if (steerGet(g.id)) plan.push(a);
      } else if (a.t === 'pin') {
        const st = steerGet(g.id);
        if (!(st && st.mode === 'node' && st.pinnedName === a.nodeName)) plan.push(a);
      } else if (a.t === 'policy') {
        if (g.policy !== a.policy) plan.push(a);
      }
    }
    if (!plan.length) return toast('已处于「' + scene.name + '」场景，无需切换', 'ok');
    const reloads = plan.length; // 每个动作内部都伴随一次 run
    const ok = await showConfirm(
      `场景「<b>${esc(scene.name)}</b>」将执行 <b>${plan.length}</b> 个动作：` +
      `<div class="hint" style="margin:6px 0">${plan.map(a => '· ' + esc(actionDesc(a))).join('<br>')}</div>` +
      `预计 <b>${reloads}</b> 次 daed 重载（每次代理连接瞬断 1-2 秒）。确定继续？`);
    if (!ok) return;
    let i = 0;
    for (const a of plan) {
      i++;
      toast(`[${i}/${plan.length}] ${actionDesc(a)}…`);
      await execAction(a);
    }
    toast(`场景「${scene.name}」已应用`, 'ok');
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('场景执行失败：' + e.message + '（已完成部分保留；重跑场景会幂等跳过）', 'err');
  } finally {
    sceneBusy = false;
    await refreshGroups(false);
    cfgUpdateModified();
    if (S.page === 'settings') renderScenes();
  }
}

// 抓取当前状态为自定义预设动作序列
async function captureCurrentScene() {
  const actions = [];
  for (const g of S.groups) {
    const st = steerGet(g.id);
    if (st && st.mode === 'region') actions.push({ t: 'steer', gname: g.name, region: st.region });
    else if (st && st.mode === 'node') actions.push({ t: 'pin', gname: g.name, nodeName: st.pinnedName || '' });
    else actions.push({ t: 'unmanage', gname: g.name });
    actions.push({ t: 'policy', gname: g.name, policy: g.policy });
  }
  const list = await api.configsAll();
  const cfg = list.find(x => x.selected) || list[0];
  if (cfg && cfg.global && cfg.global.logLevel) actions.push({ t: 'log', v: cfg.global.logLevel });
  return actions;
}

/* ================= 页面：设置 ================= */
function renderScenes() {
  const box = $('#scene-card');
  if (!box) return;
  const card = (name, desc, btns, active) => `<div class="card scene-card${active ? ' active' : ''}"><div class="sh">${active ? '<span class="dot on"></span>' : ''}${name}${active ? '<span class="tag ok">使用中</span>' : ''}</div><div class="desc">${desc}</div><div class="sub-actions">${btns}</div></div>`;
  $('#scene-builtin').innerHTML = `<div class="scene-grid">` + BUILTIN_SCENES.map(s =>
    card(esc(s.name), esc(s.desc), `<button class="btn btn-sm btn-primary" data-scene="builtin:${s.id}">应用</button>`)).join('') + `</div>`;
  const custom = scenesLoadAll();
  $('#scene-custom').innerHTML = custom.length
    ? `<div class="scene-grid">` + custom.map(s => card(esc(s.name), esc((s.desc || '') + ' · ' + s.actions.length + ' 个动作'),
        `<button class="btn btn-sm btn-primary" data-scene="custom:${s.id}">应用</button><button class="btn btn-sm btn-danger" data-scene-del="${s.id}">删</button>`)).join('') + `</div>`
    : '<div class="hint">暂无——用下方按钮把当前状态存为预设</div>';
}

async function pageSettings(el) {
  el.innerHTML = `
    <div class="section-title">场景预设</div>
    <div class="card card-pad" id="scene-card">
      <div id="scene-builtin"></div>
      <div class="section-title" style="margin:10px 0 6px">自定义预设</div>
      <div id="scene-custom"></div>
      <div class="form-row" style="margin-top:10px">
        <button class="btn btn-primary" id="scene-save">📌 保存当前状态为预设</button>
        <span class="hint">记录各组托管/钉选/策略与日志级别，存 daed 云端（跨设备可用）</span>
      </div>
    </div>
    <div class="section-title">连接</div>
    <div class="card card-pad"><div class="form-grid">
      <label>后端地址<input id="st-url" value="${esc(S.cfg.backend)}" spellcheck="false"><span class="hint">daed GraphQL 地址，如 http://192.168.1.1:2023</span></label>
      <div class="form-row">
        <label style="flex:1">账号<input id="st-user" value="${esc(S.cfg.user)}"></label>
        <label style="flex:1">密码<input id="st-pass" type="password" value="${esc(S.cfg.pass)}"></label>
      </div>
      <label class="check"><input type="checkbox" id="st-remember" ${S.cfg.remember ? 'checked' : ''}> 记住密码（保存在本机浏览器）</label>
      <div class="form-row">
        <button class="btn btn-primary" id="st-save">保存并重连</button>
        <button class="btn btn-danger" id="st-logout">注销</button>
        <button class="btn" id="st-clear">清空本地缓存</button>
      </div>
    </div></div>
    <div class="section-title">显示与刷新</div>
    <div class="card card-pad"><div class="form-grid">
      <div class="form-row">
        <label style="flex:1">绿色延迟上限 (ms)<input id="st-low" type="number" value="${S.cfg.lowMs}"></label>
        <label style="flex:1">黄色上限 (ms)<input id="st-mid" type="number" value="${S.cfg.midMs}"></label>
      </div>
      <div class="form-row">
        <label style="flex:1">代理页刷新间隔 (秒)<input id="st-groupsec" type="number" min="5" value="${S.cfg.groupSec}"></label>
        <label style="flex:1">日志刷新间隔 (秒)<input id="st-logsec" type="number" min="3" value="${S.cfg.logSec}"></label>
        <label style="flex:1">组节点自动测速 (秒，0=关)<input id="st-retest" type="number" min="0" value="${S.cfg.retestSec}"></label>
      </div>
      <div class="form-row">
        <label style="flex:1">屏蔽倍率 ≤ (0=不屏蔽)<input id="st-fmult" type="number" step="0.1" min="0" value="${S.cfg.filterMult}"></label>
        <label style="flex:2">屏蔽关键词 (逗号分隔)<input id="st-fkw" value="${esc(S.cfg.filterKw)}"></label>
      </div>
      <div class="hint">名称/标签含以上关键词或倍率≤阈值的节点视为"无用节点"（机场的信息占位与低倍率节点），默认全站隐藏，各页可用「显示无用节点」临时打开。</div>
    </div></div>
    <div class="section-title">诊断</div>
    <div class="card card-pad"><div class="form-grid">
      <div class="form-row">
        <button class="btn" id="st-cgitest">测试日志 CGI</button>
        <span class="hint" id="st-cgires">CGI: ${esc(cgiUrl())}</span>
      </div>
      <div id="st-cfginfo" class="hint">读取全局配置中…</div>
      <div class="hint">
        本面板的组变更有两类（均有确认弹窗与快照，点「全局」一键还原）：
        ①「区域托管」——点区域 chip 把组临时收缩为对应区域节点；
        ②「钉选节点」——点节点卡上的 📌 把组收缩为仅该节点且策略设为 fixed（AI 组换节点也用这个）。
        两者都会重载 daed（连接瞬断 1-2 秒）；托管区域全失效时自动切到最优存活区域（钉选节点不自动切换）；
        订阅更新重建节点 id 后按名称自动补员。组实际走哪个节点以「实际出口 / 出口记录」为准（连接日志 dialer 字段，真值）。
      </div>
    </div></div>`;
  $('#st-save').addEventListener('click', async () => {
    const oldUrl = S.cfg.backend;
    S.cfg.backend = $('#st-url').value.trim() || DEFAULT_CFG.backend;
    S.cfg.user = $('#st-user').value.trim();
    S.cfg.pass = $('#st-pass').value;
    S.cfg.remember = $('#st-remember').checked;
    if (!S.cfg.remember) S.cfg.pass = '';
    S.cfg.lowMs = Number($('#st-low').value) || 150;
    S.cfg.midMs = Number($('#st-mid').value) || 350;
    S.cfg.groupSec = Math.max(5, Number($('#st-groupsec').value) || 30);
    S.cfg.logSec = Math.max(3, Number($('#st-logsec').value) || 5);
    S.cfg.retestSec = Math.max(0, Number($('#st-retest').value) || 0);
    S.cfg.filterMult = Math.max(0, Number($('#st-fmult').value) || 0);
    S.cfg.filterKw = $('#st-fkw').value.trim() || DEFAULT_CFG.filterKw;
    saveCfg();
    if (oldUrl !== S.cfg.backend) { S.token = ''; localStorage.removeItem(TOKEN_KEY); S.authed = false; }
    if (await ensureAuth()) { toast('已保存并重连', 'ok'); boot(); }
  });
  $('#st-logout').addEventListener('click', () => {
    S.token = ''; localStorage.removeItem(TOKEN_KEY);
    S.cfg.pass = ''; saveCfg();
    showLogin();
  });
  $('#st-clear').addEventListener('click', () => {
    localStorage.removeItem(HIST_KEY); localStorage.removeItem('db.closed');
    S.hist.clear(); S.histTs.clear();
    toast('已清空本地缓存数据（连接配置保留）', 'ok');
  });
  $('#st-cgitest').addEventListener('click', async () => {
    const r = $('#st-cgires');
    r.textContent = '测试中…';
    try {
      const resp = await fetchTimeout(cgiUrl(), {}, 8000);
      const t = await resp.text();
      r.innerHTML = `CGI 正常（HTTP ${resp.status}，${t.split('\n').filter(Boolean).length} 行日志）`;
    } catch (e) {
      r.innerHTML = `CGI 不可用：${esc(e.message)} —— 确认路由器已部署 /www/cgi-bin/daed-board-log 且有执行权限；注意本页面需从路由器（http://路由器IP/daed-board/）打开才能访问 CGI`;
    }
  });
  try {
    const c = await api.selectedCfg();
    const g = c && c[0] && c[0].global;
    const info = $('#st-cfginfo');
    if (info) info.innerHTML = g
      ? `daed 全局（只读）：dialMode=${esc(g.dialMode)} · 测速间隔=${esc(g.checkInterval)} · 容差=${esc(g.checkTolerance)} · 嗅探=${esc(g.sniffingTimeout)} · 日志级别=${esc(g.logLevel)} · 检查URL=${esc((g.tcpCheckUrl || []).join(', '))}`
      : '未读到全局配置';
  } catch (e) { const info = $('#st-cfginfo'); if (info) info.textContent = '全局配置读取失败：' + e.message; }
  // 场景预设
  el.insertAdjacentHTML('beforeend', `
    <div class="section-title">关于</div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--text-2);max-width:560px">
      <div>daed-board · 原生零依赖的 daed 运维控制台（跑在 uhttpd 静态目录，LuCI「服务 → Daed 仪表盘」内嵌）</div>
      <div>后端：<span class="mono" id="about-version">—</span> · 数据走 GraphQL（wing.db 唯一合法写入口）与 <span class="mono">/cgi-bin/daed-board-log</span>（连接日志与内存）</div>
      <div>安全：写操作均有确认与快照（区域托管/钉选一键还原）；命脉规则移除强制二次确认。</div>
    </div>`);

  $('#scene-save').addEventListener('click', async () => {
    if (sceneBusy || steerBusy) return toast('有操作正在执行…', 'err');
    let actions;
    try { actions = await captureCurrentScene(); } catch (e) { return toast('抓取失败：' + e.message, 'err'); }
    const v = await showModal({ title: '保存当前状态为预设', fields: [{ key: 'name', label: '预设名称', placeholder: '如：我的基线' }] });
    if (!v || !(v.name || '').trim()) return;
    const arr = await scenesSync();
    arr.push({ id: 'c' + Date.now(), name: v.name.trim(), desc: '抓取于 ' + new Date().toLocaleString(), actions });
    await scenesPersist(arr);
    renderScenes();
    toast('预设已保存', 'ok');
  });
  $('#scene-card').addEventListener('click', async e => {
    const del = e.target.closest('[data-scene-del]');
    if (del) {
      await scenesPersist(scenesLoadAll().filter(s => s.id !== del.dataset.sceneDel));
      renderScenes();
      toast('已删除', 'ok');
      return;
    }
    const btn = e.target.closest('[data-scene]');
    if (!btn) return;
    const [kind, id] = btn.dataset.scene.split(':');
    await scenesSync();
    const scene = kind === 'builtin' ? BUILTIN_SCENES.find(s => s.id === id) : scenesLoadAll().find(s => s.id === id);
    if (scene) { await execScene(scene); renderScenes(); }
  });
  scenesSync().then(renderScenes).catch(() => renderScenes());
  renderScenes();
}

/* ================= 页面：配置（P2+P3：DNS/路由/全局配置） ================= */
const GLOBAL_FIELDS = [
  ['logLevel', '日志级别', '常用', 'select', ['silent', 'error', 'warn', 'info', 'debug']],
  ['dialMode', '拨号模式 dialMode', '常用', 'select', ['ip', 'domain', 'domain+', 'domain++']],
  ['sniffingTimeout', '嗅探超时', '常用', 'text', '如 100ms'],
  ['tcpCheckUrl', 'TCP 测速 URL', '常用', 'lines', '每行一条'],
  ['udpCheckDns', 'UDP 测速 DNS', '常用', 'lines', '每行一条'],
  ['checkInterval', '测速间隔', '常用', 'text', '如 10m0s'],
  ['checkTolerance', '切换容差', '常用', 'text', '如 100ms'],
  ['autoConfigKernelParameter', '自动配置内核参数', '常用', 'bool'],
  ['autoConfigFirewallRule', '自动配置防火墙规则', '常用', 'bool'],
  ['disableWaitingNetwork', '禁用等待网络就绪', '常用', 'bool'],
  ['tcpCheckHttpMethod', 'TCP 测速方法', '高级', 'text', 'HEAD / GET'],
  ['allowInsecure', '允许不安全 TLS', '高级', 'bool'],
  ['tlsImplementation', 'TLS 实现', '高级', 'text', 'tls / utls'],
  ['utlsImitate', 'uTLS 指纹', '高级', 'text', 'chrome / firefox / safari / random …'],
  ['mptcp', '多路径 TCP (mptcp)', '高级', 'bool'],
  ['disableThp', '禁用透明大页 (THP)', '高级', 'bool'],
  ['enableLocalTcpFastRedirect', '本地 TCP 快速重定向', '高级', 'bool'],
  ['tproxyPort', 'TPROXY 端口', '高级', 'number'],
  ['tproxyPortProtect', 'TPROXY 端口保护', '高级', 'bool'],
  ['soMarkFromDae', 'SO_MARK 标记值', '高级', 'number'],
  ['soMarkFromDaeSet', '启用 SO_MARK 设置', '高级', 'bool'],
  ['pprofPort', 'pprof 调试端口', '高级', 'number'],
  ['bpfConnStateMapSize', 'eBPF 连接表大小', '高级', 'number'],
  ['lanInterface', 'LAN 接口', '高级', 'lines', '每行一个，如 br-lan'],
  ['wanInterface', 'WAN 接口', '高级', 'lines', '每行一个，如 pppoe-wan'],
  ['bootstrapResolver', '引导 DNS', '高级', 'text', '如 223.5.5.5'],
  ['fallbackResolver', '回退 DNS', '高级', 'text', '如 https://1.1.1.1/dns-query'],
  ['bandwidthMaxTx', '带宽上限（上传）', '高级', 'text', '如 100mbps，留空不限'],
  ['bandwidthMaxRx', '带宽上限（下载）', '高级', 'text'],
  ['udphopInterval', 'UDP 跳变间隔', '高级', 'text'],
  ['tlsFragment', 'TLS 分片', '高级', 'bool'],
  ['tlsFragmentLength', 'TLS 分片长度', '高级', 'text'],
  ['tlsFragmentInterval', 'TLS 分片间隔', '高级', 'text'],
];
const CFG_TABS = {
  routing: { label: '路由', create: 'createRouting', update: 'updateRouting', remove: 'removeRouting', select: 'selectRouting' },
  dns: { label: 'DNS', create: 'createDns', update: 'updateDns', remove: 'removeDns', select: 'selectDns' },
};

function pageConfig(el) {
  if (!S.cfgTab) S.cfgTab = 'routing';
  el.innerHTML = `
    <div class="alert"><span aria-hidden="true">⛨</span>
      <div><b>命脉保护已启用：</b>路由首条 <span class="mono">pname(...dnsmasq)->must_direct</span> 与 DNS 上游 <span class="mono">1.1.1.1</span> 若被移除，保存时将强制二次确认——它们是全网干净解析的命脉。</div>
    </div>
    <div class="cfg-layout">
      <div>
        <div class="section-title">编辑器</div>
        <div class="cfg-tabs">
          ${[['routing', '路由规则', '多版本'], ['dns', 'DNS', '多版本'], ['global', '全局配置', '33 字段']].map(([t, n, v]) => `<div class="cfg-tab ${S.cfgTab === t ? 'on' : ''}" data-cfgtab="${t}"><span>${n}</span><span class="v">${v}</span></div>`).join('')}
        </div>
        <div class="section-title">状态</div>
        <div style="padding:0 12px"><span class="hint" id="cf-modified"></span></div>
      </div>
      <div>
        <div class="toolbar" style="justify-content:flex-end">
          <button class="btn btn-primary btn-sm" id="cf-apply">⚡ 应用改动 (run)</button>
        </div>
        <div id="cfg-body"><div class="empty">加载中…</div></div>
      </div>
    </div>`;
  $('#cf-apply').addEventListener('click', cfgApply);
  el.addEventListener('click', e => {
    const tb = e.target.closest('[data-cfgtab]');
    if (tb && tb.dataset.cfgtab !== S.cfgTab) { S.cfgTab = tb.dataset.cfgtab; renderPage(); }
  });
  cfgRenderTab();
}
function cfgRenderTab() {
  cfgUpdateModified();
  if (S.cfgTab === 'global') return cfgRenderGlobal();
  return cfgRenderText(S.cfgTab);
}
async function cfgUpdateModified() {
  const el = $('#cf-modified');
  if (!el) return;
  try {
    const g = await api.general();
    S.general = g;
    el.innerHTML = g.dae.modified
      ? '<span style="color:var(--yellow)">⚠ 有改动未应用</span>'
      : '<span style="color:var(--green)">配置已生效</span>';
  } catch { el.textContent = ''; }
}
async function cfgApply() {
  const ok = await showConfirm('将运行 <b>run</b> 应用当前全部配置 —— <b>代理连接会瞬断 1-2 秒</b>。确定继续？');
  if (!ok) return;
  try { await api.run(); toast('已应用，配置生效', 'ok'); }
  catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('应用失败：' + e.message + '（旧配置仍在运行）', 'err');
  }
  cfgUpdateModified();
}

// ---- 路由 / DNS 文本编辑器 ----
function cfgFirstRule(t) {
  for (const ln of String(t || '').split('\n')) {
    const s = ln.trim();
    if (s && !s.startsWith('#')) return s;
  }
  return '';
}
async function cfgRenderText(kind) {
  const meta = CFG_TABS[kind];
  const body = $('#cfg-body');
  body.innerHTML = '<div class="empty">加载中…</div>';
  let list;
  try { list = await (kind === 'routing' ? api.routings() : api.dnss()); }
  catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
  }
  S.cfgText = S.cfgText || {};
  const prev = S.cfgText[kind] || {};
  const item = list.find(x => x.id === prev.editId) || list.find(x => x.selected) || list[0] || {};
  const st = S.cfgText[kind] = { list, editId: item.id, text: (kind === 'routing' ? item.routing : item.dns) || '' };
  st.text = st.text && st.text.string || '';
  const ruleCount = kind === 'routing' ? st.text.split(String.fromCharCode(10)).filter(l => l.trim() && !l.trim().startsWith('#')).length : 0;
  body.innerHTML = `
    <div class="toolbar" style="margin-bottom:8px">
      <span class="tag ${item.selected ? 'ok' : ''}">${item.selected ? '✓ 当前生效版本' : '非当前版本（设为当前 + 应用后启用）'}</span>
      ${kind === 'routing' ? `<span class="hint">${ruleCount} 条匹配</span>` : ''}
      <span class="spacer"></span>
      <button class="btn btn-sm" id="cfg-new">＋ 新建版本</button>
    </div>
    <textarea id="cfg-text" class="cfg-editor" spellcheck="false">${esc(st.text)}</textarea>
    <div class="toolbar" style="margin-top:10px">
      <label class="check" style="color:var(--text-2)">版本
        <select class="select" id="cfg-ver">${list.map(v => `<option value="${esc(v.id)}" ${v.id === st.editId ? 'selected' : ''}>${esc(v.name || v.id)}${v.selected ? '（当前）' : ''}</option>`).join('')}</select>
      </label>
      <button class="btn btn-sm" id="cfg-do-verify">① 校验</button>
      <button class="btn btn-primary btn-sm" id="cfg-do-save">② 保存</button>
      <button class="btn btn-danger btn-sm" id="cfg-del">删除此版本</button>
      ${item.selected ? '' : '<button class="btn btn-sm" id="cfg-select">设为当前</button>'}
      <span class="hint" id="cfg-verify"></span>
      </div>
      <div class="hint">${kind === 'routing'
        ? '首条规则 pname(...dnsmasq) -> must_direct 是 DNS 干净解析的命脉，移除会被强制二次确认。'
        : 'fallback 上游 1.1.1.1（cf DoH）是国内域名干净解析的关键，移除会被强制二次确认。'}</div>
    </div>`;
  const q = s => body.querySelector(s);
  q('#cfg-ver').addEventListener('change', e => { st.editId = e.target.value; cfgRenderText(kind); });
  q('#cfg-do-verify').addEventListener('click', async () => {
    const out = q('#cfg-verify');
    out.textContent = '校验中…';
    try {
      const r = kind === 'routing' ? await api.parsedRouting(q('#cfg-text').value) : await api.parsedDns(q('#cfg-text').value);
      out.innerHTML = kind === 'routing'
        ? `<span style="color:var(--green)">✓ 语法正确，${(r.rules || []).length} 条规则</span>`
        : `<span style="color:var(--green)">✓ 语法正确，${(r.upstream || []).length} 个上游</span>`;
    } catch (e) { out.innerHTML = `<span class="imp-result bad">✗ ${esc(e.message)}</span>`; }
  });
  q('#cfg-do-save').addEventListener('click', () => cfgSaveText(kind));
  q('#cfg-new').addEventListener('click', async () => {
    const v = await showModal({ title: `新建${meta.label}版本（复制当前文本）`, fields: [{ key: 'name', label: '版本名称', placeholder: '如：备份-20260906' }] });
    if (!v || !(v.name || '').trim()) return;
    try {
      const r = await api[meta.create](v.name.trim(), q('#cfg-text').value);
      st.editId = r.id;
      cfgRenderText(kind);
      toast('已创建', 'ok');
    } catch (e) { toast('创建失败：' + e.message, 'err'); }
  });
  q('#cfg-del').addEventListener('click', async () => {
    const it = st.list.find(x => x.id === st.editId);
    const ok = await showConfirm(`确定删除版本「<b>${esc(it.name || it.id)}</b>」？不可恢复。`);
    if (!ok) return;
    try { await api[meta.remove](st.editId); toast('已删除', 'ok'); st.editId = null; cfgRenderText(kind); }
    catch (e) { toast('删除失败：' + e.message, 'err'); }
  });
  const selBtn = q('#cfg-select');
  if (selBtn) selBtn.addEventListener('click', async () => {
    const ok = await showConfirm(`将把「<b>${esc(item.name || item.id)}</b>」设为当前版本（需再点「应用改动」生效）。确定？`);
    if (!ok) return;
    try { await api[meta.select](st.editId); toast('已设为当前，记得点「应用改动」', 'ok'); cfgRenderText(kind); cfgUpdateModified(); }
    catch (e) { toast('失败：' + e.message, 'err'); }
  });
}
async function cfgSaveText(kind) {
  const meta = CFG_TABS[kind];
  const st = S.cfgText[kind];
  const item = st.list.find(x => x.id === st.editId) || {};
  const old = (kind === 'routing' ? item.routing : item.dns) || {};
  const oldText = old.string || '';
  const nw = $('#cfg-text').value;
  if (nw === oldText) return toast('内容无变化，无需保存', 'ok');
  const vout = $('#cfg-verify');
  vout.textContent = '保存前校验中…';
  try { await (kind === 'routing' ? api.parsedRouting(nw) : api.parsedDns(nw)); }
  catch (e) { return vout.innerHTML = `<span class="imp-result bad">✗ 校验失败：${esc(e.message)}</span>`; }
  // 命脉保护：路由首条规则 must_direct/pname/dnsmasq；DNS 的 1.1.1.1 上游
  const guard = kind === 'routing'
    ? (() => {
        const o = cfgFirstRule(oldText), n = cfgFirstRule(nw);
        const had = ['must_direct', 'pname', 'dnsmasq'].every(m => o.includes(m));
        return had && !['must_direct', 'pname', 'dnsmasq'].every(m => n.includes(m));
      })()
    : (oldText.includes('1.1.1.1') && !nw.includes('1.1.1.1'));
  if (guard) {
    const msg = kind === 'routing'
      ? '新文本<b>移除了首条 must_direct（DNS 命脉）规则</b>——它保证全网 DNS 走 dae 干净解析，移除可能导致 DNS 污染。'
      : '新文本<b>移除了 1.1.1.1（cf DoH）上游</b>——它是国内域名干净解析的关键，移除可能导致 DNS 污染。';
    const v = await showModal({ title: '⚠ 危险操作确认', fields: [{ key: 'ack', label: msg + '　勾选以确认继续：', type: 'checkbox' }] });
    if (!v || !v.ack) { vout.innerHTML = '<span class="hint">已取消保存</span>'; return; }
  }
  try {
    await api[meta.update](st.editId, nw);
    if (kind === 'routing') item.routing = { string: nw }; else item.dns = { string: nw };
    toast(`「${meta.label}」已保存（未应用）——记得点「应用改动」`, 'ok');
    cfgUpdateModified();
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('保存失败：' + e.message, 'err');
  }
}

// ---- 全局配置动态表单 ----
function cfgSnapGet() {
  return api.getStorage(['daed-board/cfgsnap']).then(vals => {
    const v = vals && vals[0];
    try { const o = JSON.parse(v || 'null'); return o && o.global ? o : null; } catch { return null; }
  }).catch(() => null);
}
async function cfgRenderGlobal() {
  const body = $('#cfg-body');
  body.innerHTML = '<div class="empty">加载中…</div>';
  let list;
  try { list = await api.configsAll(); }
  catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    body.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; return;
  }
  const cfg = list.find(x => x.selected) || list[0] || {};
  S.cfgGlobal = { list, id: cfg.id, obj: cfg.global || {} };
  const obj = S.cfgGlobal.obj;
  const finput = f => {
    const val = obj[f[0]];
    const dk = `data-gk="${f[0]}"`;
    if (f[3] === 'bool') return `<input type="checkbox" ${dk} ${val ? 'checked' : ''}>`;
    if (f[3] === 'number') return `<input type="number" ${dk} value="${esc(val ?? 0)}">`;
    if (f[3] === 'lines') return `<textarea class="cfg-editor mini" ${dk} spellcheck="false">${esc((val || []).join('\n'))}</textarea>`;
    if (f[3] === 'select') return `<select ${dk}>${f[4].map(o => `<option ${String(val) === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    return `<input type="text" ${dk} value="${esc(val ?? '')}" spellcheck="false" placeholder="${esc(f[4] || '')}">`;
  };
  const fieldHtml = f => `<label class="cf-field"><span>${f[1]}</span>${finput(f)}${f[4] && f[3] !== 'select' && f[3] !== 'bool' ? `<span class="fhint">${esc(f[4])}</span>` : ''}</label>`;
  const grp = gname => GLOBAL_FIELDS.filter(f => f[2] === gname).map(fieldHtml).join('');
  body.innerHTML = `
    <div class="toolbar" style="margin-bottom:10px">
      <label class="check" style="color:var(--text-2)">配置版本
        <select class="select" id="cfg-gver">${list.map(v => `<option value="${esc(v.id)}" ${v.id === S.cfgGlobal.id ? 'selected' : ''}>${esc(v.name || v.id)}${v.selected ? '（当前）' : ''}</option>`).join('')}</select>
      </label>
      <span class="hint">⚠ 保存后需「应用改动」生效；此处可覆盖 tproxy/接口等核心参数，请谨慎修改高级项。</span>
    </div>
    <div class="section-title">常用字段</div>
    <div class="cf-grid">${grp('常用')}</div>
    <details style="margin-top:12px"><summary class="section-title" style="cursor:pointer">高级（危险/低频项，默认勿动）</summary>
      <div class="cf-grid" style="margin-top:10px">${grp('高级')}</div>
    </details>
    <div class="toolbar" style="margin-top:14px">
      <button class="btn btn-primary" id="cfg-gsave">保存</button>
      <button class="btn" id="cfg-gsnap">还原到快照</button>
      <span class="hint" id="cfg-gmsg"></span>
    </div>`;
  const q = s => body.querySelector(s);
  q('#cfg-gver').addEventListener('change', e => {
    S.cfgGlobal.id = e.target.value;
    const c = list.find(x => x.id === e.target.value);
    S.cfgGlobal.obj = (c && c.global) || {};
    cfgRenderGlobal();
  });
  q('#cfg-gsave').addEventListener('click', cfgSaveGlobal);
  q('#cfg-gsnap').addEventListener('click', async () => {
    const snap = await cfgSnapGet();
    if (!snap) return toast('没有可用快照', 'err');
    S.cfgGlobal.obj = snap.global;
    cfgRenderGlobal();
    toast('已从快照回填表单，检查后点「保存」', 'ok');
  });
  cfgSnapGet().then(snap => {
    const btn = q('#cfg-gsnap');
    if (btn && snap) btn.textContent = `还原到快照（${new Date(snap.at).toLocaleString()}）`;
  });
}
async function cfgSaveGlobal() {
  const obj = {};
  for (const f of GLOBAL_FIELDS) {
    const el = document.querySelector(`#cfg-body [data-gk="${f[0]}"]`);
    if (!el) return toast('表单不完整，请刷新页面', 'err');
    if (f[3] === 'bool') obj[f[0]] = el.checked;
    else if (f[3] === 'number') obj[f[0]] = parseInt(el.value, 10) || 0;
    else if (f[3] === 'lines') obj[f[0]] = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    else obj[f[0]] = el.value;
  }
  try { await api.setStorage(['daed-board/cfgsnap'], [JSON.stringify({ at: Date.now(), id: S.cfgGlobal.id, global: S.cfgGlobal.obj })]); } catch {}
  try {
    await api.updateConfig(S.cfgGlobal.id, obj);
    S.cfgGlobal.obj = obj;
    toast('全局配置已保存（未应用）——记得点「应用改动」', 'ok');
    cfgUpdateModified();
  } catch (e) {
    if (e instanceof AuthError) return handleAuthError();
    toast('保存失败：' + e.message, 'err');
  }
}

/* ================= 认证 / 启动 ================= */
function showLogin() {
  $('#app').hidden = true;
  const m = $('#login');
  m.hidden = false;
  $('#login-url').value = S.cfg.backend;
  $('#login-user').value = S.cfg.user;
  $('#login-pass').value = S.cfg.pass || '';
  $('#login-remember').checked = S.cfg.remember;
  $('#login-err').textContent = '';
}
async function ensureAuth() {
  if (S.token && jwtExp(S.token) > Date.now() + 30000) { S.authed = true; return true; }
  if (S.cfg.pass) {
    try { await login(S.cfg.user, S.cfg.pass); return true; }
    catch (e) { console.warn('自动登录失败', e); }
  }
  S.authed = false;
  showLogin();
  return false;
}
function handleAuthError() { S.token = ''; ensureAuth(); }
$('#login-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const url = $('#login-url').value.trim();
  const user = $('#login-user').value.trim();
  const pass = $('#login-pass').value;
  if (!url || !user || !pass) { $('#login-err').textContent = '后端地址 / 账号 / 密码 均必填'; return; }
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = '登录中…';
  $('#login-err').textContent = '';
  try {
    S.cfg.backend = url; S.cfg.user = user;
    S.cfg.remember = $('#login-remember').checked;
    S.cfg.pass = S.cfg.remember ? pass : '';
    saveCfg();
    await login(user, pass);
    $('#login').hidden = true;
    boot();
    toast('登录成功', 'ok');
  } catch (e) {
    $('#login-err').textContent = '登录失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
});
function updateNavState() {
  const el = $('#nav-state');
  const g = S.general;
  if (el) {
    if (g) {
      el.textContent = '已连接 · ' + (S.cfg.backend || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      el.className = 'on';
    } else el.textContent = '连接中…';
  }
  const dot = $('#nav-dot'), core = $('#nav-core'), ver = $('#nav-version');
  if (g && dot) dot.className = 'dot ' + (g.dae.running ? 'on' : 'off');
  if (core) core.textContent = g ? (g.dae.running ? '核心运行中' : '核心已停止') : '核心状态';
  if (ver) ver.textContent = g && g.dae.version ? g.dae.version : '';
  const link = $('#nav-daed-link');
  if (link && S.cfg.backend) link.href = S.cfg.backend.replace(/\/+$/, '');
  const av = $('#about-version');
  if (av && g) av.textContent = 'dae ' + (g.dae.version || '') + (g.dae.modified ? ' · 有改动未应用' : '');
  renderNav();
  topChips();
}

/* ================= 轮询 ================= */
const POLL = [
  { key: 'groups', period: () => S.cfg.groupSec * 1000, pages: null, skipOn: ['overview'], run: () => refreshGroups(false) },
  { key: 'poll:general', period: () => 3000, pages: ['overview'], run: () => refreshGeneral() },
  { key: 'poll:log', period: () => S.cfg.logSec * 1000, pages: ['logs'], run: () => refreshLog(false) },
  { key: 'poll:logbg', period: () => Math.max(S.cfg.logSec, 10) * 1000, pages: null, run: () => { if (S.page !== 'logs') return refreshLog(false); } },
  { key: 'poll:nodes', period: () => 45000, pages: ['nodes'], run: () => refreshNodesPage(false) },
  { key: 'poll:hist', period: () => 180000, pages: null, run: async () => {
    if (!S.groups.length) return;
    const all = steerLoadAll();
    const extra = Object.values(all).flatMap(st => (st.backup && st.backup.pool || []).map(n => n.id));
    const ids = [...new Set(S.groups.flatMap(g => (g.pool || g.nodes).map(n => n.id)).concat(extra))];
    if (ids.length) { try { applyLatencies(await api.latencies(ids)); } catch {} }
    try { await checkSteerHealth(); } catch {}
  } },
  // 面板侧主动重测组池：daed 内核 checkInterval 默认约 3m，这里可更密（默认 90s；0=关闭）
  { key: 'poll:retest', period: () => (S.cfg.retestSec > 0 ? S.cfg.retestSec * 1000 : Infinity), pages: null, run: async () => {
    if (!(S.cfg.retestSec > 0) || S.testing.size) return;
    const ids = [...new Set(S.groups.flatMap(g => (g.pool || g.nodes || []).map(n => n.id)))];
    if (ids.length) await testNodes(ids);
  } },
];
setInterval(() => {
  if (!S.authed || $('#app').hidden) return;
  const now = Date.now();
  for (const p of POLL) {
    if (p.pages && !p.pages.includes(S.page)) continue;
    if (p.skipOn && p.skipOn.includes(S.page)) continue; // 1.10 概览页的 groups 由概览批量查询承载
    if (now - (S.lastTs[p.key] || 0) < p.period()) continue;
    if (S.inflight.has(p.key)) continue;
    S.lastTs[p.key] = now;
    S.inflight.add(p.key);
    Promise.resolve(p.run()).catch(() => {}).finally(() => S.inflight.delete(p.key));
  }
}, 1000);

/* ================= 启动 ================= */
async function boot() {
  $('#app').hidden = false;
  $('#login').hidden = true;
  S.lastTs = {};
  const runBtn = $('#tb-run');
  if (runBtn) runBtn.addEventListener('click', cfgApply);
  // 1.4 首屏去阻塞：先渲染，跨设备托管状态同步改到后台并行
  //（改动前 await 这条 ~47KB / 79ms 的 jsonStorage 读，首屏要等它回来才开始渲染）
  if (!location.hash) location.hash = '#/proxies';
  else onRoute();
  // 首屏减负：先只拉 groups（不阻塞全量 latencies），延迟后台补齐
  refreshGroups(false, { skipLat: true });
  refreshGeneral();
  // 同步完成后：重绘（托管 chips 依赖快照）+ 把本轮 groups 让给批量查询 + 补跑一次审计
  steerSyncFromServer().then(() => {
    ovGroupsTs = Date.now();
    return refreshGroups(false);
  }).then(() => steerAudit().catch(() => {})).catch(() => {});
}
ensureAuth().then(ok => { if (ok) boot(); });

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, extname } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
// DATA_DIR is a persistent disk mount in production. Locally it remains ./data.
const dataFile = join(process.env.DATA_DIR || join(root, 'data'), 'store.json');
const env = Object.fromEntries((existsSync(join(root, '.env')) ? await readFile(join(root, '.env'), 'utf8') : '')
  .split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(/=(.*)/s).slice(0, 2)));
const cfg = {
  port: Number(env.PORT || 8787), appId: env.META_APP_ID, secret: env.META_APP_SECRET,
  redirect: env.META_REDIRECT_URI || 'http://localhost:8787/auth/meta/callback',
  loginConfigId: env.META_LOGIN_CONFIG_ID
};
const scopes = ['pages_show_list','pages_read_engagement','pages_read_user_content','read_insights','ads_read','business_management'].join(',');
let store = { state: null, token: null, accounts: [], selected: null, snapshots: [] };
if (existsSync(dataFile)) store = { ...store, ...JSON.parse(await readFile(dataFile, 'utf8')) };
const save = async () => { await mkdir(dirname(dataFile), { recursive: true }); await writeFile(dataFile, JSON.stringify(store, null, 2)); };
const json = (res, status, payload) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0' }); res.end(JSON.stringify(payload)); };
const graph = async (path, token = store.token) => {
  const url = path.startsWith('https://') ? new URL(path) : new URL(`https://graph.facebook.com/v26.0/${path}`);
  if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`无法连接 Meta API（${error.cause?.code || error.message}）。请确认本机 Node.js 可访问 graph.facebook.com，并已配置可用代理。`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || 'Meta API request failed');
  return body;
};
const query = (path, params = {}) => `${path}?${new URLSearchParams(params)}`;
const startOfWeek = (date = new Date()) => { const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const number = value => value == null || value === '' ? null : Number(value);
const sum = values => values.reduce((total, value) => total + (number(value) || 0), 0);
const addDays = (value, days) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const metricValues = async (page, metric, from, to) => {
  const result = await graph(query(`${page.id}/insights`, { metric, period: 'day', since: from, until: addDays(to, 1) }), page.pageToken);
  return result.data?.[0]?.values || [];
};
const total = values => sum(values.map(value => value.value));
const last = values => values.length ? number(values.at(-1).value) : null;
const wow = (current, previous) => current == null || previous == null || previous === 0 ? null : (current - previous) / previous;
const insightValue = item => {
  if (item?.total_value?.value != null) return number(item.total_value.value);
  if (item?.value != null) return number(item.value);
  return null;
};
const insightTotal = items => {
  const values = (items || []).flatMap(item => item.values?.map(value => number(value.value)) || [insightValue(item)]);
  return values.some(value => value != null) ? sum(values) : null;
};
const insightLast = items => {
  const values = (items || []).flatMap(item => item.values?.map(value => number(value.value)) || [insightValue(item)]).filter(value => value != null);
  return values.length ? values.at(-1) : null;
};
async function instagramInsight(account, metric, from, to) {
  const params = { metric, period: 'day', since: from, until: addDays(to, 1), metric_type: 'total_value' };
  try {
    return (await graph(query(`${account.id}/insights`, params), account.pageToken)).data || [];
  } catch (withTypeError) {
    // Some account metrics still use the earlier Insights response contract.
    try {
      delete params.metric_type;
      return (await graph(query(`${account.id}/insights`, params), account.pageToken)).data || [];
    } catch {
      return [];
    }
  }
}

async function instagramMetrics(from, to) {
  const page = store.accounts.find(account => account.id === store.selected?.pageId && account.pageToken);
  const account = page?.instagram ? { ...page.instagram, pageToken: page.pageToken } : null;
  if (!account) return { status: 'not_connected', reason: '当前 Facebook Page 未绑定 Instagram 专业账号。' };
  let profile = {};
  try { profile = await graph(query(account.id, { fields: 'id,username,name,followers_count' }), account.pageToken); } catch { /* Insights may still be available if profile metadata is delayed. */ }
  const metricNames = ['views', 'reach', 'total_interactions', 'profile_links_taps', 'profile_activity', 'profile_views', 'follows_and_unfollows', 'follower_count'];
  const result = Object.fromEntries(await Promise.all(metricNames.map(async metric => [metric, await instagramInsight(account, metric, from, to)])));
  const views = insightTotal(result.views);
  const reach = insightTotal(result.reach);
  const interactions = insightTotal(result.total_interactions);
  const follows = insightTotal(result.follows_and_unfollows);
  const followerSeries = result.follower_count;
  const closingFollows = number(profile.followers_count) ?? insightLast(followerSeries);
  const followerDailyValues = (followerSeries || []).flatMap(item => item.values?.map(value => number(value.value)) || []).filter(value => value != null);
  // follower_count can be returned as daily growth rather than account total. Only
  // calculate net follows when Meta supplied a plausible account-total series.
  const isFollowerTotalSeries = closingFollows != null && followerDailyValues.length >= 2 && followerDailyValues.every(value => value > closingFollows * 0.5);
  const openingFollows = isFollowerTotalSeries ? followerDailyValues[0] : null;
  const clicks = insightTotal(result.profile_links_taps);
  const profileVisits = insightTotal(result.profile_activity) ?? insightTotal(result.profile_views);
  const hasData = [views, reach, interactions, clicks, profileVisits, closingFollows].some(value => value != null);
  return {
    status: hasData ? 'connected' : 'connected_no_metrics', name: profile.username ? `@${profile.username}` : page.name,
    totalViews: views, totalReach: reach, viewers: reach, interactions,
    newFollows: follows ?? insightTotal(followerSeries), netFollows: closingFollows != null && openingFollows != null ? closingFollows - openingFollows : null,
    totalFollows: closingFollows, clicks, profileVisits,
    reason: hasData ? undefined : 'Instagram 已授权，但 Meta 暂未返回当前日期范围的洞察指标。', notes: []
  };
}

async function facebookMetrics(from, to) {
  const page = store.accounts.find(account => account.id === store.selected?.pageId && account.pageToken);
  if (!page) return { status: 'not_connected', reason: '尚未选择 Facebook Page' };
  const [views, uniqueViewers, engagements, profileVisits, newFollows, follows] = await Promise.all([
    metricValues(page, 'page_media_view', from, to), metricValues(page, 'page_total_media_view_unique', from, to), metricValues(page, 'page_post_engagements', from, to),
    metricValues(page, 'page_views_total', from, to), metricValues(page, 'page_daily_follows', from, to),
    metricValues(page, 'page_follows', from, to)
  ]);
  const allEngagements = total(engagements);
  const closingFollows = last(follows);
  const openingFollows = follows.length ? number(follows[0].value) : null;
  return {
    status: 'connected', name: page.name, totalViews: total(views),
    // Summing daily unique media viewers deliberately does not deduplicate people across days.
    totalReach: total(uniqueViewers), viewers: total(uniqueViewers),
    // Facebook Professional Dashboard's aggregate interaction metric.
    interactions: allEngagements,
    newFollows: total(newFollows), netFollows: closingFollows != null && openingFollows != null ? closingFollows - openingFollows : null,
    totalFollows: closingFollows, clicks: null, profileVisits: total(profileVisits), notes: []
  };
}

async function captureLcsrSnapshot() {
  const page = store.accounts.find(account => account.id === store.selected?.pageId && account.pageToken);
  if (!page) throw new Error('尚未选择 Facebook Page。');
  const fields = 'id,shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)';
  let path = query(`${page.id}/published_posts`, { fields, limit: 100 });
  let likes = 0, comments = 0, sharesAndReposts = 0, pages = 0;
  while (path && pages < 100) {
    const result = await graph(path, page.pageToken);
    for (const post of result.data || []) {
      likes += Number(post.reactions?.summary?.total_count || 0);
      comments += Number(post.comments?.summary?.total_count || 0);
      sharesAndReposts += Number(post.shares?.count || 0);
    }
    path = result.paging?.next || null;
    pages += 1;
  }
  const snapshot = { day: new Date().toISOString().slice(0, 10), capturedAt: new Date().toISOString(), likes, comments, sharesAndReposts, total: likes + comments + sharesAndReposts, complete: !path };
  store.lcsrSnapshots = [...(store.lcsrSnapshots || []).filter(item => item.day !== snapshot.day), snapshot];
  await save();
  return snapshot;
}

function decorate(current, previous) {
  const interactionRate = current.interactions != null && current.totalReach ? current.interactions / current.totalReach : null;
  const followRate = current.newFollows != null && current.totalReach ? current.newFollows / current.totalReach : null;
  return { ...current, viewsWow: wow(current.totalViews, previous.totalViews), reachWow: wow(current.totalReach, previous.totalReach),
    interactionsWow: wow(current.interactions, previous.interactions), engagementRate: interactionRate,
    followConversionRate: followRate, followsWow: wow(current.totalFollows, previous.totalFollows) };
}

async function report(from, to, requestedPlatforms = []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('请选择有效的开始日期和结束日期。');
  const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const previousTo = addDays(from, -1); const previousFrom = addDays(previousTo, -(days - 1));
  const selected = requestedPlatforms.length ? requestedPlatforms : ['facebook', 'instagram', 'linkedin', 'tiktok', 'snapchat', 'youtube'];
  const rows = [];
  if (selected.includes('facebook')) {
    const [current, previous] = await Promise.all([facebookMetrics(from, to), facebookMetrics(previousFrom, previousTo)]);
    rows.push({ platform: 'Facebook', ...decorate(current, previous) });
  }
  const inactive = { totalViews: null, totalReach: null, interactions: null, newFollows: null, netFollows: null, totalFollows: null, clicks: null, viewers: null, profileVisits: null, viewsWow: null, reachWow: null, interactionsWow: null, engagementRate: null, followConversionRate: null, followsWow: null };
  if (selected.includes('instagram')) {
    const [current, previous] = await Promise.all([instagramMetrics(from, to), instagramMetrics(previousFrom, previousTo)]);
    rows.push({ platform: 'Instagram', ...inactive, ...decorate(current, previous) });
  }
  for (const [key, label] of [['linkedin', 'LinkedIn'], ['tiktok', 'TikTok'], ['snapchat', 'Snapchat'], ['youtube', 'YouTube']]) if (selected.includes(key)) rows.push({ platform: label, status: 'not_connected', reason: '尚未连接该平台 API。', ...inactive });
  const entry = { at: new Date().toISOString(), from, to, platforms: rows.map(row => ({ platform: row.platform, status: row.status })) };
  store.syncLog = [entry, ...(store.syncLog || [])].slice(0, 100); await save();
  return { from, to, previousFrom, previousTo, rows, lastSyncedAt: entry.at };
}

async function loadAccounts() {
  const pages = await graph(query('me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: 100 }));
  const ads = await graph(query('me/adaccounts', { fields: 'id,name,account_status', limit: 100 }));
  store.accounts = (pages.data || []).map(p => ({ id: p.id, name: p.name, instagram: p.instagram_business_account || null, pageToken: p.access_token }))
    .concat((ads.data || []).map(a => ({ id: a.id, name: a.name, type: 'ad_account', status: a.account_status })));
  await save();
}
function actionTotal(actions = [], types) { return actions.filter(a => types.includes(a.action_type)).reduce((sum, a) => sum + Number(a.value || 0), 0); }
async function sync() {
  if (!store.selected?.pageId) throw new Error('Choose a Facebook Page first.');
  const page = store.accounts.find(a => a.id === store.selected.pageId); if (!page?.pageToken) throw new Error('Page token is unavailable; reconnect Meta.');
  const today = new Date().toISOString().slice(0, 10); const since = startOfWeek();
  const posts = await graph(query(`${page.id}/posts`, { fields: 'id,created_time,shares,insights.metric(post_reactions_like_total)', since, until: today }), page.pageToken);
  const organicInteractions = (posts.data || []).reduce((n, p) => n + Number(p.shares?.count || 0) + Number(p.insights?.data?.find(metric => metric.name === 'post_reactions_like_total')?.values?.[0]?.value || 0), 0);
  let adsViews = null, adsReach = null, adsClicks = null, adsInteractions = null;
  if (store.selected.adAccountId) {
    const insight = await graph(query(`${store.selected.adAccountId}/insights`, { fields: 'reach,inline_link_clicks,actions', time_range: JSON.stringify({ since, until: today }), level: 'account' }));
    const row = insight.data?.[0] || {}; adsReach = Number(row.reach || 0); adsClicks = Number(row.inline_link_clicks || 0);
    adsViews = actionTotal(row.actions, ['video_view','video_play']); adsInteractions = actionTotal(row.actions, ['post_engagement','page_engagement']);
  }
  // Views/reach/follows require account-level insights. They remain null until Meta returns the metric for the selected Page/IG account.
  const snapshot = { week: since, capturedAt: new Date().toISOString(), organicViews: null, adsViews, organicReach: null, adsReach,
    organicInteractions, adsInteractions, clicks: adsClicks, profileVisits: null, newFollows: null, unfollows: null, totalFollows: null };
  store.snapshots = [...store.snapshots.filter(s => s.week !== since), snapshot]; await save(); return snapshot;
}
function weekly() {
  const rows = [...store.snapshots].sort((a,b) => a.week.localeCompare(b.week));
  return rows.map((row, index) => { const previous = rows[index - 1]; const number = value => value == null ? null : Number(value); const combined = (...values) => values.every(value => number(value) == null) ? null : values.reduce((sum, value) => sum + (number(value) || 0), 0); const totalViews = combined(row.organicViews, row.adsViews); const totalReach = combined(row.organicReach, row.adsReach); const interactions = combined(row.organicInteractions, row.adsInteractions); const netFollows = row.newFollows == null ? null : Number(row.newFollows) - Number(row.unfollows || 0); const wow = (current, earlier) => current == null || earlier == null || earlier === 0 ? null : (current - earlier) / earlier;
    return { ...row, totalViews, totalReach, interactions, engagementRate: totalReach ? interactions / totalReach : null, netFollows, followConversion: totalReach && netFollows != null ? netFollows / totalReach : null, viewsWow: wow(totalViews, previous?.totalViews), followsWow: wow(row.totalFollows, previous?.totalFollows) };
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/auth/meta') {
      if (!cfg.appId || !cfg.secret) return json(res, 400, { error: 'Add META_APP_ID and META_APP_SECRET to .env first.' });
      store.state = randomBytes(24).toString('hex'); await save();
      const login = new URL('https://www.facebook.com/v26.0/dialog/oauth'); login.searchParams.set('client_id', cfg.appId); login.searchParams.set('redirect_uri', cfg.redirect); login.searchParams.set('state', store.state);
      if (cfg.loginConfigId) login.searchParams.set('config_id', cfg.loginConfigId); else login.searchParams.set('scope', scopes);
      res.writeHead(302, { location: login }); return res.end();
    }
    if (url.pathname === '/auth/meta/callback') {
      if (url.searchParams.get('state') !== store.state) throw new Error('Login state did not match. Please start again.');
      const exchange = new URL('https://graph.facebook.com/v26.0/oauth/access_token'); exchange.search = new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.secret, redirect_uri: cfg.redirect, code: url.searchParams.get('code') || '' });
      let tokenResponse;
      try {
        tokenResponse = await fetch(exchange);
      } catch (error) {
        throw new Error(`无法连接 Meta API（${error.cause?.code || error.message}）。请确认本机 Node.js 可访问 graph.facebook.com，并已配置可用代理。`);
      }
      const tokenBody = await tokenResponse.json(); if (!tokenResponse.ok) throw new Error(tokenBody?.error?.message || 'Token exchange failed');
      store.token = tokenBody.access_token; store.state = null; await loadAccounts(); res.writeHead(302, { location: '/' }); return res.end();
    }
    if (url.pathname === '/api/status') return json(res, 200, { connected: Boolean(store.token), accounts: store.accounts.filter(a => !a.pageToken), pages: store.accounts.filter(a => a.pageToken).map(({ pageToken, ...safe }) => safe), selected: store.selected, lastSyncedAt: store.syncLog?.[0]?.at || null });
    if (url.pathname === '/api/select' && req.method === 'POST') { let body = ''; for await (const part of req) body += part; const selection = JSON.parse(body); store.selected = { pageId: selection.pageId, adAccountId: selection.adAccountId || null }; await save(); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/report') return json(res, 200, await report(url.searchParams.get('from') || '', url.searchParams.get('to') || '', (url.searchParams.get('platforms') || '').split(',').filter(Boolean)));
    if (url.pathname === '/api/capture' && req.method === 'POST') return json(res, 200, { snapshot: await captureLcsrSnapshot() });
    if (url.pathname === '/api/sync' && req.method === 'POST') { const body = await report(url.searchParams.get('from') || new Date().toISOString().slice(0, 10), url.searchParams.get('to') || new Date().toISOString().slice(0, 10), (url.searchParams.get('platforms') || 'facebook,instagram').split(',').filter(Boolean)); return json(res, 200, body); }
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const publicFiles = new Set(['index.html', 'app.js', 'style.css', 'favicon.svg']);
    if (!publicFiles.has(path)) return json(res, 404, { error: 'Not found' });

    // Local development uses ./public; GitHub's browser uploader stores the
    // same four static files at repository root for the deployment package.
    const nested = join(root, 'public', path);
    const file = existsSync(nested) ? nested : join(root, path);
    const extension = extname(file);
    const type = extension === '.js' ? 'text/javascript'
      : extension === '.css' ? 'text/css'
      : extension === '.svg' ? 'image/svg+xml'
      : 'text/html';
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    return res.end(content);
  } catch (error) {
    if (res.headersSent) return res.end();
    const status = error?.code === 'ENOENT' ? 404 : 500;
    return json(res, status, { error: status === 404 ? 'Not found' : error.message });
  }
});
server.listen(cfg.port, '0.0.0.0', () => console.log(`Social analytics: http://localhost:${cfg.port}`));
const dailyCapture = () => {
  if (!store.token || !store.selected?.pageId) return;
  captureLcsrSnapshot().then(() => {
    store.lcsrCaptureError = null;
    return save();
  }).catch(async error => {
    // LCSR collection is optional for the live dashboard. Do not let a missing
    // content-read permission make the local service look as though it failed.
    store.lcsrCaptureError = { at: new Date().toISOString(), message: error.message };
    await save();
    console.warn(`LCSR daily snapshot skipped: ${error.message}`);
  });
};
dailyCapture();
setInterval(() => { if (store.token && store.selected?.pageId) { const today = new Date().toISOString().slice(0, 10); report(today, today, ['facebook', 'instagram']).catch(console.error); dailyCapture(); } }, 24 * 60 * 60 * 1000);

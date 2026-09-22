const $ = selector => document.querySelector(selector);
const catalog = [['facebook','Facebook'],['instagram','Instagram'],['linkedin','LinkedIn'],['tiktok','TikTok'],['snapchat','Snapchat'],['youtube','YouTube']];
const format = value => value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
const percent = value => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const iso = date => date.toISOString().slice(0, 10);
const today = new Date(); const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
$('#from').value = iso(weekAgo); $('#to').value = iso(today);
$('#platforms').innerHTML = catalog.map(([id, label]) => `<label class="chip"><input type="checkbox" value="${id}" ${id === 'facebook' || id === 'instagram' ? 'checked' : ''}><span>${label}</span></label>`).join('');
const selectedPlatforms = () => [...document.querySelectorAll('#platforms input:checked')].map(input => input.value);
function render(rows) {
  $('#rows').innerHTML = rows.map(row => `<tr><td><strong>${row.platform}</strong></td><td>${format(row.totalViews)}</td><td>${percent(row.viewsWow)}</td><td>${format(row.totalReach)}</td><td>${percent(row.reachWow)}</td><td>${format(row.interactions)}</td><td>${percent(row.engagementRate)}</td><td>${percent(row.interactionsWow)}</td><td>${format(row.newFollows)}</td><td>${format(row.netFollows)}</td><td>${percent(row.followConversionRate)}</td><td>${format(row.totalFollows)}</td><td>${percent(row.followsWow)}</td><td>${format(row.clicks)}</td><td>${format(row.viewers)}</td><td>${format(row.profileVisits)}</td><td><span class="status ${row.status}">${row.status === 'connected' ? '已同步' : row.reason || '未连接'}</span></td></tr>`).join('');
  const facebook = rows.find(row => row.platform === 'Facebook' && row.status === 'connected');
  $('#summary').classList.toggle('hidden', !facebook);
  if (facebook) $('#summary').innerHTML = [['Total Views', facebook.totalViews], ['Interactions', facebook.interactions], ['New Follows', facebook.newFollows], ['Profile Visits', facebook.profileVisits]].map(([label,value]) => `<article><span>${label}</span><strong>${format(value)}</strong></article>`).join('');
}
async function refresh() {
  const from = $('#from').value, to = $('#to').value, platforms = selectedPlatforms();
  if (!platforms.length) return alert('请至少选择一个平台。');
  $('#refresh').disabled = true; $('#refresh').textContent = '更新中…';
  try { const response = await fetch(`/api/report?from=${from}&to=${to}&platforms=${platforms.join(',')}`, {cache: 'no-store'}); const data = await response.json(); if (!response.ok) throw new Error(data.error); render(data.rows); $('#synced').textContent = `更新于 ${new Date(data.lastSyncedAt).toLocaleString('zh-CN')}`; }
  catch (error) { alert(error.message); }
  finally { $('#refresh').disabled = false; $('#refresh').textContent = '更新数据'; }
}
async function status() {
  const data = await fetch('/api/status', {cache: 'no-store'}).then(response => response.json());
  $('#connect').textContent = data.connected ? '重新连接账号' : '连接账号';
  $('#notice').classList.toggle('hidden', data.connected); $('#setup').classList.toggle('hidden', !data.connected);
  if (!data.connected) return;
  $('#page').innerHTML = data.pages.map(item => `<option value="${item.id}" ${data.selected?.pageId === item.id ? 'selected' : ''}>${item.name}${item.instagram ? ` · IG @${item.instagram.username || item.instagram.id}` : ' · 未绑定 IG'}</option>`).join('');
  $('#ads').innerHTML = '<option value="">暂不连接广告账户</option>' + data.accounts.map(item => `<option value="${item.id}" ${data.selected?.adAccountId === item.id ? 'selected' : ''}>${item.name}</option>`).join('');
  if (data.lastSyncedAt) $('#synced').textContent = `上次同步 ${new Date(data.lastSyncedAt).toLocaleString('zh-CN')}`;
  await refresh();
}
$('#save').onclick = async () => { await fetch('/api/select', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({pageId: $('#page').value, adAccountId: $('#ads').value}) }); await refresh(); };
$('#refresh').onclick = refresh;
status().catch(error => alert(error.message));

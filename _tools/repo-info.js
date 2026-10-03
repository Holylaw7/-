#!/usr/bin/env node
/**
 * 读取仓库当前元数据，并确认 token 权限（不打印 token 本身）。
 *   node _tools/repo-info.js
 *
 * token 从环境变量 GITHUB_TOKEN 读取，绝不写入文件、绝不打印。
 */
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'Holylaw7/-';

async function api(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ykt-repo-setup',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, ok: res.ok, body };
}

(async () => {
  if (!TOKEN) { console.error('缺少 GITHUB_TOKEN 环境变量'); process.exit(1); }

  console.log('=== ① token 身份与权限 ===');
  const me = await api('/user');
  if (!me.ok) { console.error('  ✗ token 无效或已过期:', me.status, JSON.stringify(me.body).slice(0, 200)); process.exit(1); }
  console.log('  登录身份:', me.body.login);

  const scopes = (await fetch('https://api.github.com/user', {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'ykt-repo-setup' },
  })).headers.get('x-oauth-scopes');
  console.log('  token scopes:', scopes === null ? '(fine-grained token，无 classic scopes 字段)' : (scopes || '(空)'));

  console.log('\n=== ② 当前仓库元数据 ===');
  const r = await api(`/repos/${REPO}`);
  if (!r.ok) { console.error('  ✗ 读取失败:', r.status, JSON.stringify(r.body).slice(0, 200)); process.exit(1); }
  const d = r.body;
  console.log('  仓库名    :', d.name);
  console.log('  可见性    :', d.visibility);
  console.log('  默认分支  :', d.default_branch);
  console.log('  description:', d.description === null ? '(未设置)' : JSON.stringify(d.description));
  console.log('  homepage   :', d.homepage === null || d.homepage === '' ? '(未设置)' : d.homepage);
  console.log('  topics     :', (d.topics && d.topics.length) ? JSON.stringify(d.topics) : '(未设置)');
  console.log('  license    :', d.license ? d.license.spdx_id : '(未识别)');

  console.log('\n=== ③ 权限自检（能否改仓库设置）===');
  const perms = d.permissions || {};
  console.log('  admin:', !!perms.admin, ' push:', !!perms.push, ' pull:', !!perms.pull);
  if (!perms.admin) console.log('  ⚠ 没有 admin 权限，改 description/topics 可能失败');

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.message); process.exit(1); });

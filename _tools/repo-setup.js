#!/usr/bin/env node
/**
 * 设置仓库简介 / 主页 / Topics
 *   node _tools/repo-setup.js
 *
 * token 从环境变量 GITHUB_TOKEN 读取，绝不写入文件、绝不打印。
 */
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'Holylaw7/-';

const DESCRIPTION = '长江雨课堂自动刷课用户脚本（篡改猴/油猴）：自动跳转下一节、锁定 2 倍速、'
  + '切换页面或最小化后台仍继续播放（防暂停/防降速/防挂机弹窗），自动跳过测验与作业。'
  + '通用适配任意课程，教室号自动识别，无需配置。';

// GitHub topic 规则：必须以小写字母或数字开头，只能包含小写字母、数字、连字符，
// 且不超过 50 字符 —— 因此不能用中文。
const TOPICS = [
  'tampermonkey',
  'userscript',
  'yuketang',
  'changjiang',
  'course-automation',
  'video-autoplay',
  'background-playback',
  'javascript',
];

async function api(path, method, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ykt-repo-setup',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

(async () => {
  if (!TOKEN) { console.error('缺少 GITHUB_TOKEN 环境变量'); process.exit(1); }

  console.log('=== ① 设置简介与主页 ===');
  const patch = await api(`/repos/${REPO}`, 'PATCH', { description: DESCRIPTION });
  if (patch.ok) {
    console.log('  ✓ description 已写入');
    console.log('    ' + patch.body.description);
  } else {
    console.log('  ✗ 失败:', patch.status, JSON.stringify(patch.body).slice(0, 240));
  }

  console.log('\n=== ② 设置 Topics ===');
  const t = await api(`/repos/${REPO}/topics`, 'PUT', { names: TOPICS });
  if (t.ok) {
    console.log('  ✓ topics 已写入:', JSON.stringify(t.body.names));
  } else {
    console.log('  ✗ 失败:', t.status, JSON.stringify(t.body).slice(0, 240));
  }

  console.log('\n=== ③ 回读确认 ===');
  const d = await api(`/repos/${REPO}`, 'GET');
  if (d.ok) {
    console.log('  仓库     :', d.body.full_name);
    console.log('  可见性   :', d.body.visibility);
    console.log('  简介     :', d.body.description || '(空)');
    console.log('  Topics   :', (d.body.topics || []).join(', ') || '(空)');
    console.log('  许可证   :', d.body.license ? d.body.license.spdx_id : '(无)');
    console.log('  星标/流派:', d.body.stargazers_count, '/', d.body.forks_count);
  } else {
    console.log('  ✗ 回读失败:', d.status);
  }

  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.message); process.exit(1); });

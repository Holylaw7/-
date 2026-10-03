#!/usr/bin/env node
/**
 * 服务端视角：脚本到底有没有真的播放过？（不依赖页面自述）
 *   node _tools/check-server-playback.js
 *
 * mock 站点会把每个小节「服务端已记录的播放秒数」暴露在 /__state，
 * 这是判定"是否真的播了"最可靠的依据。
 */
const CONFIG = require('./config');

(async () => {
  const base = CONFIG.mock.origin();
  let st;
  try {
    st = await (await fetch(`${base}/__state`, { signal: AbortSignal.timeout(5000) })).json();
  } catch (e) {
    console.error('无法读取 mock 状态:', e.message);
    process.exit(1);
  }

  console.log('=== 服务端记录的播放情况 ===');
  const leaves = st.leaves || [];
  let anyPlayed = false;
  leaves.forEach((l) => {
    // 注意：/__state 里返回的字段是 seconds（已四舍五入），不是 server_seconds
    const secs = Number(l.seconds ?? l.server_seconds ?? 0);
    if (secs > 0) anyPlayed = true;
    const mark = secs > 0 ? '✓' : (l.kind === 'video' ? '·' : ' ');
    console.log(`  ${mark} leaf=${String(l.id).padEnd(10)} ${String(l.kind).padEnd(6)} 服务端秒数=${String(secs).padStart(7)}  done=${!!l.done}  «${String(l.name).slice(0, 26)}»`);
  });

  console.log('\n=== 心跳统计 ===');
  console.log('  hidden 上报次数:', st.hiddenReports ?? '(未提供)');
  console.log('  visible 上报次数:', st.visibleReports ?? '(未提供)');
  if (st.beats) console.log('  心跳条数:', Array.isArray(st.beats) ? st.beats.length : st.beats);

  console.log('\n=== 结论 ===');
  if (anyPlayed) {
    console.log('  ✓ 服务端收到过播放时长 → 视频**确实播放过**（播放链路正常）');
    console.log('    若界面断言却显示 paused=true，说明是"播完后跳节/重置"的时序问题，不是播放被拦。');
  } else {
    console.log('  ✗ 服务端从未收到播放时长 → 视频**从未真正播放**');
    console.log('     这才是需要排查的自动播放问题。');
  }
  process.exit(0);
})().catch((e) => { console.error('异常:', e && e.stack || e); process.exit(1); });

// 回归：学习会话等待超时后必须**真正取消** DSH 那边的 turn。
//
// 真实事故（2026-11-01）：一次黑话研究 turn 在桥接 120s 超时放弃后，DSH 侧又继续跑了
// 56 分钟 / 289 步 / 128M token（约 ¥4.25），结果无人消费。waitLearnerTurn 超时只
// reject 是不够的，必须 stopSessionWork，并丢弃该学习会话（避免“已停止 turn 的结束
// 事件”串到下一个 prompt 的 waiter 上）。本文件钉住两条契约：
//   1. 超时 → reject + stopSessionWork(sessionId) + 等待者清理；
//   2. 同一会话还有别的等待者时不动手（否则会误杀别人正在等的 turn）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;

async function test(name, run) {
  tests++;
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

await test('waitLearnerTurn 超时：reject + stopSessionWork + 清理等待者', async () => {
  const h = await bridgeHarness({ config: { slang: { enabled: false } } });
  try {
    const sid = 'fixture-learner-session';
    await assert.rejects(() => h.waitLearnerTurn(sid, 20), /等待学习会话 turn 超时/);
    // 取消是 fire-and-forget，等一个 tick 让 then 链跑完
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(h.calls.cancelled.includes(sid), '超时后必须调用 stopSessionWork');
    assert.equal(h.learnerWaiters.has(sid), false, '等待者应被清理');
  } finally {
    await h.close();
  }
});

await test('同一会话还有其他等待者时不取消（避免误杀）', async () => {
  const h = await bridgeHarness({ config: { slang: { enabled: false } } });
  try {
    const sid = 'fixture-learner-shared';
    const first = h.waitLearnerTurn(sid, 20);
    const second = h.waitLearnerTurn(sid, 1000);
    await assert.rejects(() => first, /超时/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.calls.cancelled.includes(sid), false, '还有其他等待者时不应取消 turn');
    second.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1020));
  } finally {
    await h.close();
  }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
process.exitCode = failures ? 1 : 0;

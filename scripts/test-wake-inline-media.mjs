// 回归：reserved2 唤醒必须把「模型还没看过的新消息图片」直接内联进 prompt。
//
// 真实故障（2026-10-30 会话实证）：桥接把会话模型切到某个工具调用参数不稳定的路由后，
// qq_get_message_images 的 messageId 参数在模型侧被传坏（MCP -32602 Input validation error），
// 58/58 次看图全失败；而 reserved2 的唤醒只给「文本快照 + 工具」，图片完全依赖该工具，
// 于是机器人彻底看不到图，只能对群友说“看不见图”。
//
// 修复：唤醒时把 snapshot.messages 里、模型还没看过（不在 modelSeenSeqs）的新消息图片
// 直接内联进 prompt（旧 chat/reserved 模式本来就是内联的）。本文件钉住四条契约：
//   1. 带图新消息 → prompt 里出现 image 块 + 「本次唤醒已附图」提示；
//   2. 同一条图下一轮唤醒不得重复附图（modelSeenSeqs 生效，避免重复烧 token）；
//   3. 纯文本唤醒不带图、也不出现“已附图”提示（不能对模型撒谎）；
//   4. socialV2.media.inlineWake=false 可整体关闭（回滚开关）；
//   5. 图片抓取失败不连累唤醒本身（仍投递纯文本，模型可退回工具/请对方发文字）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const IMG_MEDIA = [{ kind: 'image', file: 'fixture-image.jpg' }];
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

async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, ...config } } });
  h.setMode('reserved2');
  try { await run(h); } finally { await h.close(); }
}

function append(h, text, media = []) {
  const st = h.getSocialV2State(KEY);
  const seq = (st.lastUnreadSeq || 0) + 1;
  h.appendSocialV2Message(KEY, '小明', text, text, false, false, `fixture-${seq}`, media, '789');
  return seq;
}

const lastPromptContent = (h) => h.calls.prompts.at(-1)?.content ?? [];
const imageBlocks = (h) => lastPromptContent(h).filter((part) => part?.type === 'image');
const promptText = (h) => lastPromptContent(h).find((part) => part?.type === 'text')?.text ?? '';

await test('带图新消息唤醒：图片内联进 prompt，并给出「已附图」提示', async () => {
  await withBridge(async (h) => {
    append(h, '[图片]', IMG_MEDIA);
    const result = await h.deliverPrompt(KEY, '', { wakeReason: 'atMention@seq1' });
    assert.equal(result?.ok, true);
    const images = imageBlocks(h);
    assert.equal(images.length, 1, '应内联 1 张图片');
    assert.match(String(images[0]?.mediaType), /^image\//, 'image 块必须带 mimeType');
    assert.ok(String(images[0]?.data ?? '').length > 0, 'image 块必须带 base64 数据');
    assert.match(promptText(h), /【本次唤醒已附图】/);
    assert.match(promptText(h), /不需要再调用 qq_get_message_images/);
  });
});

await test('同一条图不会在下一轮唤醒里重复附图（modelSeenSeqs 生效）', async () => {
  await withBridge(async (h) => {
    append(h, '[图片]', IMG_MEDIA);
    await h.deliverPrompt(KEY, '', { wakeReason: 'atMention@seq1' });
    assert.equal(imageBlocks(h).length, 1);
    await h.deliverPrompt(KEY, '', { wakeReason: 'probability@seq1' });
    assert.equal(imageBlocks(h).length, 0, '已展示过的图不应重复内联');
    assert.doesNotMatch(promptText(h), /【本次唤醒已附图】/);
  });
});

await test('纯文本唤醒不附图，也不会出现「已附图」提示', async () => {
  await withBridge(async (h) => {
    append(h, '在吗');
    await h.deliverPrompt(KEY, '', { wakeReason: 'atMention@seq1' });
    assert.equal(imageBlocks(h).length, 0);
    assert.doesNotMatch(promptText(h), /【本次唤醒已附图】/);
  });
});

await test('inlineWake=false 可关闭唤醒附图（回滚开关）', async () => {
  await withBridge(async (h) => {
    append(h, '[图片]', IMG_MEDIA);
    await h.deliverPrompt(KEY, '', { wakeReason: 'atMention@seq1' });
    assert.equal(imageBlocks(h).length, 0);
  }, { media: { inlineWake: false } });
});

await test('图片抓取失败不连累唤醒：仍投递纯文本', async () => {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false } } } });
  h.setMode('reserved2');
  try {
    h.bot.getImage = async () => { throw new Error('fixture gateway down'); };
    append(h, '[图片]', IMG_MEDIA);
    const result = await h.deliverPrompt(KEY, '', { wakeReason: 'atMention@seq1' });
    assert.equal(result?.ok, true, '附图失败也必须正常投递');
    assert.equal(imageBlocks(h).length, 0);
    assert.equal(lastPromptContent(h)[0]?.type, 'text');
    assert.doesNotMatch(promptText(h), /【本次唤醒已附图】/, '没有图片时不能声称已附图');
  } finally { await h.close(); }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
process.exitCode = failures ? 1 : 0;

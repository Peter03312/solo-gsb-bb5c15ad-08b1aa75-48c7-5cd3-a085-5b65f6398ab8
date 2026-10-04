'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '术语测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles };
}

const enc = encodeURIComponent;

// ---------- 术语表维护 ----------

test('维护：初始术语版本 0、表为空；非法语言代号 → 400', async () => {
  const { pid } = await setupProject();
  const view = await api(`/api/projects/${pid}/glossary`);
  assert.equal(view.status, 200);
  assert.equal(view.body.term_version, 0);
  assert.deepEqual(view.body.languages, []);

  const bad = await api(`/api/projects/${pid}/glossary/${enc('bad lang')}`);
  assert.equal(bad.status, 400);
});

test('维护：配置术语 → 200 且术语版本 +1；同语言源词去重排序', async () => {
  const { pid } = await setupProject();
  const r = await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0,
    terms: [
      { source_term: '世界', target_term: 'World' },
      { source_term: '你好', target_term: 'Hello' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.term_version, 1);
  assert.deepEqual(r.body.terms.map((t) => t.source_term), ['世界', '你好']);

  const one = await api(`/api/projects/${pid}/glossary/en`);
  assert.equal(one.body.term_version, 1);
  assert.equal(one.body.term_count, 2);

  const overview = await api(`/api/projects/${pid}/glossary`);
  assert.equal(overview.body.term_count, 2);
  assert.equal(overview.body.languages[0].lang, 'en');
});

test('维护：词与译法须非空文本、同语言不得重复；首尾空白拒绝 → 400', async () => {
  const { pid } = await setupProject();
  const cases = [
    { term_version: 0, terms: [{ source_term: '', target_term: 'X' }] },
    { term_version: 0, terms: [{ source_term: '  ', target_term: 'X' }] },
    { term_version: 0, terms: [{ source_term: '你好', target_term: '' }] },
    { term_version: 0, terms: [{ source_term: ' 你好', target_term: 'Hi' }] },
    { term_version: 0, terms: [{ source_term: '你好', target_term: 'Hi' }, { source_term: '你好', target_term: 'Hello' }] },
    { terms: [] },
    { term_version: 'x', terms: [] },
  ];
  for (const body of cases) {
    const r = await api(`/api/projects/${pid}/glossary/en`, 'PUT', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // 全部拒绝后术语仍为空、版本仍为 0
  assert.equal((await api(`/api/projects/${pid}/glossary`)).body.term_version, 0);
});

test('维护：空数组合法（清空该语言）；清空推进版本', async () => {
  const { pid } = await setupProject();
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', { term_version: 0, terms: [{ source_term: '你好', target_term: 'Hello' }] });
  const r = await api(`/api/projects/${pid}/glossary/en`, 'PUT', { term_version: 1, terms: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.term_version, 2);
  assert.deepEqual(r.body.terms, []);
});

test('维护：过期 term_version → 409 返回当前表；不同语言共用项目术语版本', async () => {
  const { pid } = await setupProject();
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', { term_version: 0, terms: [{ source_term: '你好', target_term: 'Hello' }] });
  const stale = await api(`/api/projects/${pid}/glossary/fr`, 'PUT', { term_version: 0, terms: [] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.term_version, 1);
  assert.equal(stale.body.current.languages[0].term_count, 1);

  // 用当前版本改另一种语言，版本继续推进
  const ok = await api(`/api/projects/${pid}/glossary/fr`, 'PUT', { term_version: 1, terms: [{ source_term: '世界', target_term: 'Monde' }] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.term_version, 2);
  // 英语术语不受影响
  const en = await api(`/api/projects/${pid}/glossary/en`);
  assert.equal(en.body.terms.length, 1);
  assert.equal(en.body.term_version, 2);
});

// ---------- 精确匹配与缺失查询 ----------

async function bilingual(pid, cues, line1 = 'Hello World', line2 = 'Welcome') {
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: line1, cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: line2, cue_version: 1 });
}

test('匹配：按当前原文字幕精确匹配源词；每行命中词的规定译法都须出现', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0,
    terms: [
      { source_term: '你好', target_term: 'Hello' },
      { source_term: '世界', target_term: 'World' },
    ],
  });
  // 行1原文“你好世界”命中两个词：译文只含 Hello 不含 World → 缺 1 个
  await bilingual(pid, cues, 'Hello buddy', 'Welcome');
  const check = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', {});
  assert.equal(check.status, 200);
  assert.equal(check.body.term_version, 1);
  assert.equal(check.body.configured, true);
  assert.equal(check.body.missing_count, 1);
  assert.deepEqual(check.body.items, [{
    lang: 'en', subtitle_id: cues[0].id, idx: 0, source_term: '世界', target_term: 'World',
  }]);
  assert.equal(check.body.rows[0].translation.text, 'Hello buddy');

  // 只查字幕 2（未命中任何源词）→ 无缺失
  const one = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', { subtitle_ids: [cues[1].id] });
  assert.equal(one.body.checked_count, 1);
  assert.equal(one.body.missing_count, 0);

  // 缺译的行（使用尚无译文的新语言）：命中词全部视为缺失，translation 为 null
  await api(`/api/projects/${pid}/glossary/${enc('ja-JP')}`, 'PUT', {
    term_version: 1,
    terms: [
      { source_term: '你好', target_term: 'こんにちは' },
      { source_term: '世界', target_term: 'セカイ' },
    ],
  });
  const check2 = await api(`/api/projects/${pid}/glossary/${enc('ja-JP')}/check`, 'POST', {});
  const line1Rows = check2.body.rows.filter((r) => r.subtitle_id === cues[0].id);
  assert.equal(line1Rows[0].translation, null);
  assert.equal(line1Rows[0].missing.length, 2);
});

test('匹配：子串精确匹配（不做分词）；未配置术语的语言不受影响', async () => {
  const { pid, cues } = await setupProject();
  await bilingual(pid, cues, 'Whatever', 'Welcome');
  // 没配置任何术语：所有语言恒无缺失
  const empty = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', {});
  assert.equal(empty.body.configured, false);
  assert.equal(empty.body.missing_count, 0);

  // 源词是原文子串即命中；译文包含规定译法即满足
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0,
    terms: [{ source_term: '你好世', target_term: 'Whatever' }],
  });
  const ok = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', {});
  assert.equal(ok.body.missing_count, 0, '子串命中且译文含规定译法');

  // 另一语言 fr 未配置术语，即使译文任意也无缺失
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'x', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'y', cue_version: 1 });
  const fr = await api(`/api/projects/${pid}/glossary/fr/check`, 'POST', {});
  assert.equal(fr.body.configured, false);
  assert.equal(fr.body.missing_count, 0);
});

test('查询：subtitle_ids 非法/指向不存在行 → 400', async () => {
  const { pid } = await setupProject();
  const badType = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', { subtitle_ids: ['x'] });
  assert.equal(badType.status, 400);
  const ghost = await api(`/api/projects/${pid}/glossary/en/check`, 'POST', { subtitle_ids: [9999] });
  assert.equal(ghost.status, 400);
});

// ---------- 译文可保存、状态不被术语改变 ----------

test('保存：缺术语译文仍可保存供修正；术语变更不改变 current/review 状态', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0, terms: [{ source_term: '你好', target_term: 'Hello' }],
  });
  const save = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: '不合规译文', cue_version: 1 });
  assert.equal(save.status, 201);
  assert.equal(save.body.translation.status, 'current');

  // 并列视图：状态仍 current，但暴露 term_missing
  const view = await api(`/api/projects/${pid}/translations/en`);
  const e = view.body.entries[0];
  assert.equal(e.state, 'current');
  assert.equal(e.valid, true);
  assert.equal(e.term_missing[0].source_term, '你好');
  assert.equal(view.body.glossary.missing_count, 1);

  // 再改术语（加词/换译法），译文状态依旧 current
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 1,
    terms: [
      { source_term: '你好', target_term: 'Hello' },
      { source_term: '世界', target_term: 'World' },
    ],
  });
  const view2 = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view2.body.entries[0].state, 'current');
  assert.equal(view2.body.glossary.term_version, 2);

  // 源行变化导致的 review 与术语无关：状态机行为不变
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好世界哦' });
  const view3 = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view3.body.entries[0].state, 'review');
});

// ---------- 导出/交付/署名：事务内核对术语，任一缺失不生成快照 ----------

test('单语言导出：术语缺失 → 422 terminology 逐行报错且无快照；补齐后通过并记录术语版本', async () => {
  const { pid, cues } = await setupProject();
  await bilingual(pid, cues); // 行1 'Hello World'、行2 'Welcome'
  // 初始术语规定“世界”须译为 Earth：行1 含 World 不含 Earth → 术语缺失
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0, terms: [{ source_term: '世界', target_term: 'Earth' }],
  });
  const blocked = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.term_version, 1);
  assert.equal(blocked.body.terminology.length, 1);
  assert.equal(blocked.body.terminology[0].subtitle_id, cues[0].id);
  assert.equal(blocked.body.terminology[0].missing[0].target_term, 'Earth');
  assert.deepEqual(await (await api(`/api/projects/${pid}/translations/en/exports`)).body, []);

  // 术语改为译文已满足的 Hello/World 后导出成功，快照记录核对时 term_version
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 1,
    terms: [
      { source_term: '你好', target_term: 'Hello' },
      { source_term: '世界', target_term: 'World' },
    ],
  });
  const ok = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.term_version, 2);

  // 术语后续修改：旧快照内容不变；再次导出按新术语核对（当前版本 v2 → 改后 v3）
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 2, terms: [{ source_term: '你好', target_term: 'Howdy' }],
  });
  const dl = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.ok(dl.body.includes('Hello World'));
  const re = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(re.status, 422);
  assert.equal(re.body.term_version, 3);
  assert.equal(re.body.terminology[0].missing[0].target_term, 'Howdy');
});

test('多语同版交付：任一语言术语缺失按语言/行返回 terminology，整批不生成快照', async () => {
  const { pid, cues } = await setupProject();
  await bilingual(pid, cues);
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour le monde', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'Bienvenue', cue_version: 1 });
  // en 术语满足（Hello/World 都在行1；行2不命中）；fr 行1缺规定译法
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0,
    terms: [
      { source_term: '你好', target_term: 'Hello' },
      { source_term: '世界', target_term: 'World' },
    ],
  });
  await api(`/api/projects/${pid}/glossary/fr`, 'PUT', {
    term_version: 1, terms: [{ source_term: '你好', target_term: 'Salut' }],
  });

  const body = {
    sub_version: 1, rules_version: 1, languages: ['en', 'fr'],
    translations: {
      en: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
      fr: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
    },
  };
  const blocked = await api(`/api/projects/${pid}/deliveries`, 'POST', body);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.term_version, 2);
  const fr = blocked.body.languages.find((l) => l.lang === 'fr');
  assert.equal(fr.terminology.length, 1);
  assert.equal(fr.terminology[0].subtitle_id, cues[0].id);
  const en = blocked.body.languages.find((l) => l.lang === 'en');
  assert.equal(en.problem_count, 0);
  // 整批失败：原文/译文序列都没有快照
  assert.equal((await api(`/api/projects/${pid}/exports`)).body.length, 0);
  assert.deepEqual(await (await api(`/api/projects/${pid}/translations/en/exports`)).body, []);
  assert.deepEqual(await (await api(`/api/projects/${pid}/translations/fr/exports`)).body, []);
  assert.deepEqual((await api(`/api/projects/${pid}/deliveries`)).body.batches, []);

  // 修正 fr 后整批通过
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Salut le monde', cue_version: 1, version: 1 });
  body.translations.fr[0].version = 2;
  const ok = await api(`/api/projects/${pid}/deliveries`, 'POST', body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.files.length, 3);
});

test('署名版译文导出：术语缺失按行 translation_term_missing；原文署名导出不查术语', async () => {
  const { pid, cues } = await setupProject();
  await bilingual(pid, cues);
  await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`,
    'PUT', { attribution_version: 0, cue_version: 1, speaker_number: 1 });
  await api(`/api/projects/${pid}/attributions/subtitles/${cues[1].id}`,
    'PUT', { attribution_version: 1, cue_version: 1, speaker_number: 1 });

  // 术语让英语行1不满足
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0, terms: [{ source_term: '你好', target_term: 'Howdy' }],
  });

  // 原文署名导出不参与术语核对 → 成功
  const src = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attribution_version: 2,
  });
  assert.equal(src.status, 201, JSON.stringify(src.body));
  assert.equal(src.body.term_version, null);

  // 译文署名导出缺术语 → 422 按行列码
  const blocked = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attribution_version: 2, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.term_version, 1);
  const row = blocked.body.rows.find((r) => r.subtitle_id === cues[0].id);
  assert.ok(row.codes.includes('translation_term_missing'));
  assert.equal(row.term_missing[0].target_term, 'Howdy');
  assert.deepEqual((await api(`/api/projects/${pid}/attributed-exports`)).body.exports.length, 1);

  // 清空该语言术语后导出成功并记录 term_version
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', { term_version: 1, terms: [] });
  const ok = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attribution_version: 2, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(ok.status, 200 + 1, JSON.stringify(ok.body));
  assert.equal(ok.body.term_version, 2);
});

test('语言总览带 term_count / term_version；译文回填与术语核对并存', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossary/en`, 'PUT', {
    term_version: 0, terms: [{ source_term: '你好', target_term: 'Hello' }],
  });
  // 整批回填不含术语也能成功（回填只写字数/字速，术语在导出时核对）
  const batch = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B1', sub_version: 1, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hello World' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Welcome' },
    ],
  });
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  const overview = await api(`/api/projects/${pid}/translations`);
  assert.equal(overview.body.term_version, 1);
  assert.equal(overview.body.languages[0].term_count, 1);
  // 回填译文满足术语 → 导出通过
  const ex = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(ex.status, 201, JSON.stringify(ex.body));
});

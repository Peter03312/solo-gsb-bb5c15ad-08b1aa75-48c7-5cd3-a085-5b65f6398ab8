'use strict';

/**
 * 译审术语表（glossary）：
 *
 * 译审为项目各目标语言维护“源词 → 规定译法”的对照表：
 *   - 源词与译法均为非空文本；同一语言内源词不得重复（DB 唯一索引 + 请求校验）；
 *   - 修改按语言整体替换，携带读取时术语版本 term_version；过期返回当前表（409）；
 *   - 每次成功修改推进项目级 term_version（所有语言共用一个版本号）。
 *
 * 核对规则（只读取当前术语，不改动任何译文）：
 *   - 按当前原文字幕文本“精确匹配”源词：源词作为子串出现在原文行中即为命中；
 *   - 每条命中的译文必须包含对应规定译法（译文文本包含 target_term 即满足）；
 *   - 一行命中多个源词时，每个命中词的规定译法都必须在译文中出现；
 *   - 未配置术语的语言不受影响（术语表为空 → 无缺失）。
 *
 * 术语只影响查询/导出核对：译文仍可保存供修正，术语变更不改变既有译文的
 * current/review 状态，也不改变旧导出快照。单语言译文导出、多语言同版交付与
 * 译文署名导出在原有事务内读取当前术语并核对，任一缺失逐行报错且不生成快照。
 */

const { normalizeLang } = require('./translation');

const MAX_TERMS_PER_LANG = 1000;
const MAX_TERM_LEN = 128;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const mapTermRow = (r) => ({
  id: r.id,
  lang: r.lang,
  source_term: r.source_term,
  target_term: r.target_term,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** 项目当前术语版本 */
function getTermVersion(db, projectId) {
  return db.prepare('SELECT term_version FROM projects WHERE id = ?').get(projectId).term_version;
}

/** 某语言全部术语（按源词升序；子串核对时输出顺序稳定） */
function listTermsByLang(db, projectId, lang) {
  return db.prepare(
    `SELECT * FROM glossary_terms WHERE project_id = ? AND lang = ? ORDER BY source_term`
  ).all(projectId, lang).map(mapTermRow);
}

/** 项目全部术语（按语言、源词排序），返回 Map(lang -> termRows) */
function listTermsByAllLangs(db, projectId) {
  const rows = db.prepare(
    `SELECT * FROM glossary_terms WHERE project_id = ? ORDER BY lang, source_term`
  ).all(projectId);
  const byLang = new Map();
  for (const r of rows) {
    if (!byLang.has(r.lang)) byLang.set(r.lang, []);
    byLang.get(r.lang).push(mapTermRow(r));
  }
  return byLang;
}

/** 术语总览：每种语言的条数与对照表（附当前 term_version） */
function buildGlossaryView(db, projectId) {
  const termVersion = getTermVersion(db, projectId);
  const byLang = listTermsByAllLangs(db, projectId);
  const languages = [...byLang.keys()].sort().map((lang) => ({
    lang,
    term_count: byLang.get(lang).length,
    terms: byLang.get(lang),
  }));
  return {
    project_id: projectId,
    term_version: termVersion,
    language_count: languages.length,
    term_count: languages.reduce((n, l) => n + l.term_count, 0),
    languages,
  };
}

/**
 * 术语表修改请求形状校验（与项目当前状态无关的部分）。
 * 合法请求：{ term_version, terms:[{source_term, target_term}] }（terms 允许为空 = 清空该语言）。
 */
function parseGlossaryBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.term_version) || b.term_version < 0) {
    errors.push('term_version（读取时术语版本）必须是 ≥0 的整数');
  }
  const terms = [];
  if (!Array.isArray(b.terms)) {
    errors.push('terms 必须是数组：[{source_term（源词）, target_term（规定译法）}]，允许空数组清空该语言');
  } else if (b.terms.length > MAX_TERMS_PER_LANG) {
    errors.push(`terms 数量 ${b.terms.length} 超过单语言上限 ${MAX_TERMS_PER_LANG}`);
  } else {
    const seen = new Set();
    b.terms.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`terms[${i}] 必须是对象 {source_term, target_term}`);
        return;
      }
      const itemErrors = [];
      let source = null;
      let target = null;
      if (typeof it.source_term !== 'string' || it.source_term.trim() === '') {
        itemErrors.push('source_term（源词）必须是非空文本');
      } else {
        source = it.source_term.trim();
        if (source !== it.source_term) itemErrors.push('source_term 不得含首尾空白');
        if (source.length > MAX_TERM_LEN) itemErrors.push(`source_term 长度超过上限 ${MAX_TERM_LEN} 字`);
      }
      if (typeof it.target_term !== 'string' || it.target_term.trim() === '') {
        itemErrors.push('target_term（规定译法）必须是非空文本');
      } else {
        target = it.target_term.trim();
        if (target !== it.target_term) itemErrors.push('target_term 不得含首尾空白');
        if (target.length > MAX_TERM_LEN) itemErrors.push(`target_term 长度超过上限 ${MAX_TERM_LEN} 字`);
      }
      if (itemErrors.length > 0) {
        errors.push(`terms[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seen.has(source)) {
        errors.push(`terms[${i}] 源词 ${JSON.stringify(source)} 在同一语言内重复：同语言源词不得重复`);
        return;
      }
      seen.add(source);
      terms.push({ source_term: source, target_term: target });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    termVersion: errors.length === 0 ? b.term_version : null,
    terms,
  };
}

/**
 * 整体替换某语言术语表（调用方须已完成 term_version 乐观锁核对）。
 * 同一事务内删除旧条目、写入新条目并推进项目术语版本。
 * 返回 { term_version, terms }。
 */
function replaceLangTerms(db, projectId, lang, terms) {
  const { bumpTermVersion } = require('./db');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM glossary_terms WHERE project_id = ? AND lang = ?').run(projectId, lang);
    const ins = db.prepare(
      'INSERT INTO glossary_terms (project_id, lang, source_term, target_term) VALUES (?, ?, ?, ?)'
    );
    terms.forEach((t) => ins.run(projectId, lang, t.source_term, t.target_term));
    return bumpTermVersion(db, projectId);
  });
  const termVersion = tx();
  return { term_version: termVersion, terms: listTermsByLang(db, projectId, lang) };
}

/** 稳定排序：长词优先、等长按字典序，保证一行多词命中时输出确定 */
function sortTerms(terms) {
  return [...terms].sort((a, b) => {
    const sa = typeof a === 'string' ? a : a.source_term;
    const sb = typeof b === 'string' ? b : b.source_term;
    if (sb.length !== sa.length) return sb.length - sa.length;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/**
 * 按原文字幕文本精确匹配源词，返回译文中缺失的规定译法。
 *   sourceText      当前原文字幕行文本
 *   translationText 该行译文文本
 *   terms           [{source_term, target_term}]
 * 命中 = 源词是原文行的子串；满足 = 译文包含规定译法。返回缺失项列表（可能为空）。
 */
function findMissingTerms(sourceText, translationText, terms) {
  const missing = [];
  for (const t of sortTerms(terms)) {
    const source = t.source_term;
    const target = t.target_term;
    if (sourceText.includes(source) && !translationText.includes(target)) {
      missing.push({ source_term: source, target_term: target });
    }
  }
  return missing;
}

/**
 * 逐行核对某语言当前字幕的术语命中情况（只读）。
 *   options.subtitleIds 给定且非空时，只核对指定字幕 ID（须为当前字幕行）；否则核对全部行。
 * 返回：
 *   { lang, configured, term_version, terms, cue_count, checked_count,
 *     rows: [{subtitle_id, idx, source_text, translation: {version,status,text}|null,
 *             missing:[{source_term,target_term}]}],  // 仅含存在缺失的行
 *     items: [{lang, subtitle_id, idx, source_term, target_term}], // 扁平缺失清单
 *     missing_count }
 * 没有译文的行：该行所有命中词都视为缺失（译文无法包含规定译法）。
 */
function evaluateGlossary(db, projectId, lang, options = {}) {
  const termVersion = getTermVersion(db, projectId);
  const terms = listTermsByLang(db, projectId, lang);
  const cues = db.prepare(
    `SELECT id, idx, text FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const filter = options.subtitleIds instanceof Set && options.subtitleIds.size > 0
    ? options.subtitleIds
    : null;
  const trRows = db.prepare(
    `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status != 'history'`
  ).all(projectId, lang);
  const trByCue = new Map(trRows.map((r) => [r.subtitle_id, r]));

  const rows = [];
  const items = [];
  let checked = 0;
  for (const cue of cues) {
    if (filter && !filter.has(cue.id)) continue;
    checked++;
    const tr = trByCue.get(cue.id) || null;
    const translationText = tr ? tr.text : '';
    const missing = findMissingTerms(cue.text, translationText, terms);
    if (missing.length > 0) {
      rows.push({
        subtitle_id: cue.id,
        idx: cue.idx,
        source_text: cue.text,
        translation: tr ? { version: tr.version, status: tr.status, text: tr.text } : null,
        missing,
      });
      for (const m of missing) {
        items.push({ lang, subtitle_id: cue.id, idx: cue.idx, ...m });
      }
    }
  }
  return {
    lang,
    configured: terms.length > 0,
    term_version: termVersion,
    terms,
    cue_count: cues.length,
    checked_count: checked,
    rows,
    items,
    missing_count: items.length,
  };
}

/**
 * 导出前对“已有译文的行”做术语核对（供单语言导出/多语交付/署名导出在事务内调用）。
 * entries: [{cue:{id,idx,text}, translation: 译文行(含 text) 或 null}]
 * 仅返回译文中缺失的规定译法（无译文的行由调用方按 missing 桶处理，不在此重复）：
 *   [{subtitle_id, idx, text, translation:{version,status,text}, missing:[...]}]
 */
function checkEntries(entries, terms) {
  if (!terms || terms.length === 0) return [];
  const out = [];
  for (const e of entries) {
    if (!e.translation) continue;
    const missing = findMissingTerms(e.cue.text, e.translation.text, terms);
    if (missing.length > 0) {
      out.push({
        subtitle_id: e.cue.id,
        idx: e.cue.idx,
        text: e.cue.text,
        translation: {
          version: e.translation.version,
          status: e.translation.status,
          text: e.translation.text,
        },
        missing,
        reasons: missing.map(
          (m) => `原文命中术语源词 ${JSON.stringify(m.source_term)}，译文须包含规定译法 ${JSON.stringify(m.target_term)}`
        ),
      });
    }
  }
  return out;
}

module.exports = {
  MAX_TERMS_PER_LANG,
  MAX_TERM_LEN,
  normalizeLang,
  getTermVersion,
  listTermsByLang,
  listTermsByAllLangs,
  buildGlossaryView,
  parseGlossaryBody,
  replaceLangTerms,
  findMissingTerms,
  sortTerms,
  evaluateGlossary,
  checkEntries,
};

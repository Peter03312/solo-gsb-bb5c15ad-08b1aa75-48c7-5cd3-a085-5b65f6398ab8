'use strict';

/** 毫秒 -> WebVTT 时间戳 HH:MM:SS.mmm */
function formatTimestamp(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (v, n) => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

/**
 * 生成 WebVTT 文件内容。cues 需已按时间升序：
 * [{ start_ms, end_ms, text, speaker? }]
 *
 * speaker 缺省时输出普通正文（与旧导出完全兼容）；给出时按 WebVTT 说话人标签语法输出
 * `<v 显示名>正文</v>`。显示名须事先通过 validateSpeakerName（不含换行/<、>），
 * 否则标签语法会被破坏，调用方不得传入。
 */
function toWebVtt(cues) {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const blocks = ['WEBVTT', ''];
  sorted.forEach((c, i) => {
    const body = c.speaker ? `<v ${c.speaker}>${c.text}</v>` : c.text;
    blocks.push(
      String(i + 1),
      `${formatTimestamp(c.start_ms)} --> ${formatTimestamp(c.end_ms)}`,
      body,
      ''
    );
  });
  return blocks.join('\n');
}

module.exports = { toWebVtt, formatTimestamp };

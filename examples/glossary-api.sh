#!/usr/bin/env bash
# 译审术语表完整调用示例：
#   维护对照表（乐观锁/非空/同语言源词唯一）→ 缺失查询（语言/字幕ID/源词）
#   → 缺术语译文仍可保存 → 单语言导出核对 → 多语同版交付核对 → 译文署名导出核对
#   → 术语变更不改变译文状态、旧快照不变；原文导出与未配置术语语言不受影响。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/glossary-api.sh [BASE_URL]
# 例如：bash examples/glossary-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（准备 2 行源字幕：你好世界 / 欢迎光临） ==="
WORDS='{"name":"术语 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "源字幕 id=$SID1（你好世界）/ $SID2（欢迎光临）"

echo
echo "=== 1. 术语总览（初始 term_version=0，无语言） ==="
req GET "/api/projects/$PID/glossary" | body_of

echo
echo "=== 2. 译审为英语配置术语（携带 term_version=0）→ 200，版本推进到 1 ==="
req PUT "/api/projects/$PID/glossary/en" '{
  "term_version":0,
  "terms":[
    {"source_term":"你好","target_term":"Hello"},
    {"source_term":"世界","target_term":"World"}
  ]
}' | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print("term_version =", d["term_version"], "; 源词 =", [t["source_term"] for t in d["terms"]])'

echo
echo "=== 3. 非法修改 → 400（空源词/空译法/同语言源词重复/首尾空白/版本字段非法） ==="
echo "--- 空源词："
req PUT "/api/projects/$PID/glossary/en" '{"term_version":1,"terms":[{"source_term":"","target_term":"X"}]}' | body_of
echo "--- 同语言源词重复："
req PUT "/api/projects/$PID/glossary/en" '{"term_version":1,"terms":[{"source_term":"你好","target_term":"A"},{"source_term":"你好","target_term":"B"}]}' | body_of
echo "--- 语言代号非法（路径层）："
req PUT "/api/projects/$PID/glossary/zh%20CN" '{"term_version":1,"terms":[]}' | body_of

echo
echo "=== 4. 过期术语版本 → 409，返回当前整表 current ==="
req PUT "/api/projects/$PID/glossary/en" '{"term_version":0,"terms":[]}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("当前 term_version =", d["current"]["term_version"])'

echo
echo "=== 5. 保存英语译文（故意不满足术语）：仍 201/200 成功，状态 current（供后续修正） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hi there","cue_version":1}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("行1 译文状态 =", d["translation"]["status"], "v"+str(d["translation"]["version"]))'
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
echo "（术语变更不会把这些译文改成 review；current/review 只跟源字幕变化走）"

echo
echo "=== 6. 缺失查询：按语言、字幕 ID、源词列出缺失译法与术语版本 ==="
echo "--- 全部行："
req POST "/api/projects/$PID/glossary/en/check" '{}' | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print("configured =", d["configured"], ", term_version =", d["term_version"], ", missing_count =", d["missing_count"])
for it in d["items"]: print("  字幕", it["subtitle_id"], "缺：源词", it["source_term"], "→ 规定译法", it["target_term"])'
echo "--- 只查字幕 $SID2（未命中任何源词，应无缺失）："
req POST "/api/projects/$PID/glossary/en/check" "{\"subtitle_ids\":[$SID2]}" | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("checked =", d["checked_count"], ", missing =", d["missing_count"])'
echo "--- 指向不存在的字幕行 → 400："
req POST "/api/projects/$PID/glossary/en/check" '{"subtitle_ids":[99999]}' | body_of

echo
echo "=== 7. 并列查询视图暴露 term_missing（状态仍 current） ==="
req GET "/api/projects/$PID/translations/en" | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print("glossary =", d["glossary"])
for e in d["entries"]: print("  字幕", e["cue"]["id"], e["state"], "缺术语:", [m["source_term"] for m in e["term_missing"]])'

echo
echo "=== 8. 单语言译文导出：术语缺失 → 422 terminology 逐行报错，不生成快照 ==="
req POST "/api/projects/$PID/translations/en/exports" '{}' | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print("error:", d["error"])
for r in d.get("terminology", []):
    print("  字幕", r["subtitle_id"], r["text"], "缺:", [(m["source_term"], m["target_term"]) for m in r["missing"]])'
echo "导出快照数（应为 0）：$(req GET "/api/projects/$PID/translations/en/exports" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"

echo
echo "=== 9. 修正译文（一行命中多词时全部满足）后导出成功，快照记录 term_version ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello World","cue_version":1,"version":1}' >/dev/null
req POST "/api/projects/$PID/translations/en/exports" '{}' | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print("导出 v"+str(d["version"]), "term_version =", d["term_version"])
print(d["content"])'

echo
echo "=== 10. 再补一种语言 fr：未配置术语 → 术语核对不拦截 ==="
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
req POST "/api/projects/$PID/translations/fr/exports" '{}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("fr 导出 v"+str(d.get("version")), "(未配置术语，照常通过)")'

echo
echo "=== 11. 给 fr 配置术语后，多语同版交付按语言/行核对 ==="
echo "--- 配置 fr 术语：世界 → Mondes（当前译文 le monde 不含 Mondes）"
req PUT "/api/projects/$PID/glossary/fr" '{"term_version":1,"terms":[{"source_term":"世界","target_term":"Mondes"}]}' >/dev/null
req POST "/api/projects/$PID/deliveries" "{
  \"sub_version\":1,\"rules_version\":1,\"languages\":[\"en\",\"fr\"],
  \"translations\":{
    \"en\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":1}],
    \"fr\":[{\"subtitle_id\":$SID1,\"version\":1},{\"subtitle_id\":$SID2,\"version\":1}]
  }}" | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
for l in d["languages"]:
    print(" 语言", l["lang"], "问题数", l["problem_count"],
          [(r["subtitle_id"], [m["target_term"] for m in r["missing"]]) for r in l["terminology"]])'
echo "--- 修正 fr 译文后重新交付 → 201（各序列快照均记录 term_version）："
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour les Mondes","cue_version":1,"version":1}' >/dev/null
req POST "/api/projects/$PID/deliveries" "{
  \"sub_version\":1,\"rules_version\":1,\"languages\":[\"en\",\"fr\"],
  \"translations\":{
    \"en\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":1}],
    \"fr\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":1}]
  }}" | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print(" 批次", d["id"], "文件:", [(f["kind"], f["lang"], "v"+str(f["version"])) for f in d["files"]])'

echo
echo "=== 12. 署名版导出：原文不查术语；译文缺术语按行 translation_term_missing ==="
req POST "/api/projects/$PID/speakers" '{"display_name":"茶客甲"}' >/dev/null
req PUT "/api/projects/$PID/attributions/subtitles/$SID1" '{"attribution_version":0,"cue_version":1,"speaker_number":1}' >/dev/null
req PUT "/api/projects/$PID/attributions/subtitles/$SID2" '{"attribution_version":1,"cue_version":1,"speaker_number":1}' >/dev/null
echo "--- 原文署名导出（术语不参与）→ 201："
req POST "/api/projects/$PID/attributed-exports" '{"sub_version":1,"attribution_version":2}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" v"+str(d["version"]), "term_version =", d["term_version"])'
echo "--- 改 fr 术语使译文不满足，译文署名导出 → 422 按行列码："
req PUT "/api/projects/$PID/glossary/fr" '{"term_version":2,"terms":[{"source_term":"你好","target_term":"XXX"}]}' >/dev/null
req POST "/api/projects/$PID/attributed-exports" "{
  \"sub_version\":1,\"attribution_version\":2,\"lang\":\"fr\",
  \"translations\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":1}]}" | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
for r in d.get("rows", []):
    print(" 字幕", r["subtitle_id"], r["codes"], [(m["source_term"], m["target_term"]) for m in r["term_missing"]])'

echo
echo "=== 13. 兼容性收尾 ==="
echo "--- 原文普通导出不受术语影响："
req POST "/api/projects/$PID/exports" '{}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" 原文导出 v"+str(d["version"]))'
echo "--- 清空 fr 术语（空数组也推进 term_version）后该语言恢复不受限："
req PUT "/api/projects/$PID/glossary/fr" '{"term_version":3,"terms":[]}' | body_of \
 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" term_version =", d["term_version"], ", fr 词条数 =", len(d["terms"]))'
echo "--- 术语总览："
req GET "/api/projects/$PID/glossary" | body_of | python3 -c '
import json,sys; d=json.load(sys.stdin)
print(" term_version =", d["term_version"], ";", [(l["lang"], l["term_count"]) for l in d["languages"]])'

echo
echo "完成。旧导出快照内容随后续术语/译文修改保持不变，可用列表与下载接口随时回看："
echo "  GET /api/projects/$PID/translations/en/exports 与 .../exports/:version"
echo "  GET /api/projects/$PID/deliveries 与 GET /api/projects/$PID/attributed-exports"

#!/bin/sh
# smoke-curl.sh — 8377 服务端点冒烟（curl）。需要先起 test/serve.mjs。
# 覆盖全部 6 端点的正常/异常路径，exit 0 = 全过。
set -u
B=http://127.0.0.1:8377
BODY=/tmp/smoke-body
fail=0
chk() {
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1 (want $2 got $3)"; fail=1; fi
}
ok() {
  if [ "$1" = 0 ]; then echo "PASS $2"; else echo "FAIL $2"; fail=1; fi
}
code() { curl -s -o "$BODY" -w "%{http_code}" "$@"; }

chk "GET / -> 200" 200 "$(code $B/)"
grep -q "cytoscape" "$BODY"; ok $? "/ body contains cytoscape init"

chk "GET /graph -> 200" 200 "$(code $B/graph)"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.facts.length===1&&j.steps.length===1&&j.hints.length===0&&j.goal.text==="goal-text"?0:1)' "$BODY"
ok $? "/graph shape (facts=1 steps=1 hints=0 goal=goal-text)"

chk "GET /status -> 200" 200 "$(code $B/status)"
grep -q '"running":false' "$BODY"; ok $? "/status running=false (no engine)"

chk "GET /log -> 200" 200 "$(code $B/log)"
grep -q "ui server at" "$BODY"; ok $? "/log contains server-start line"

chk "POST /hints valid -> 200" 200 "$(code -X POST -H "content-type: application/json" -d '{"text":"curl-hint"}' $B/hints)"
grep -q '"ok":true' "$BODY"; ok $? "/hints valid -> {ok:true}"
code $B/graph >/dev/null
grep -q "curl-hint" "$BODY"; ok $? "/graph reflects injected hint (injectHint persisted)"

chk "POST /hints empty body -> 400" 400 "$(code -X POST -H "content-type: application/json" -d '{}' $B/hints)"
chk "POST /hints blank text -> 400" 400 "$(code -X POST -H "content-type: application/json" -d '{"text":"  "}' $B/hints)"

chk "POST /abort (no engine) -> 409" 409 "$(code -X POST $B/abort)"
chk "GET /nope -> 404" 404 "$(code $B/nope)"

echo "smoke: $([ $fail = 0 ] && echo ALL PASS || echo FAILURES)"
exit $fail

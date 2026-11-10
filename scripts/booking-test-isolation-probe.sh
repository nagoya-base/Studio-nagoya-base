#!/usr/bin/env bash
# Issue #874（PR #875 レビュー）: PR CI専用のprobe。run-booking-tests-isolated.sh の probe モードで、
# 隔離ユーザーとして「テスト／依存コードが悪意を持っていた場合」の操作を試す。本番workflowからは呼ばない。
#   - 失敗すべき操作（workspace・RUNNER_TEMP・Node/clasp導入先・/usr/local/bin・ルートFS・既存world-writableファイルへの書込み、Docker socket、sudo、
#     cron/at登録、他ユーザーのプロセス環境変数の読取り）が1つでも成功したら exit 1。
#   - 成功してよい操作（常駐子プロセス・/tmp等への置き土産）は残したまま終わる。後片付けで消えることをCIが確認する。
#   - BOOKING_ISOLATION_CANARY（ホスト上のworld-writableなディレクトリ）が渡された場合は、そこへの書込みも失敗すべき操作として試す。
#     （/usr/local/bin・hostedtoolcache のようにrunner上でworld-writableな場所を模す）
set -uo pipefail

escaped=()
try_write() { # <label> <directory>
  local dir="$2"
  [[ -n "$dir" && -d "$dir" ]] || return 0
  if ( : > "$dir/.booking-isolation-probe" ) 2>/dev/null; then escaped+=("$1"); fi
}

try_write workspace "${PROBE_WORKSPACE:-}"
try_write workspace-git "${PROBE_WORKSPACE:-}/.git"
try_write runner-temp "${PROBE_RUNNER_TEMP:-}"
try_write node-bin "${PROBE_NODE_BIN:-}"
try_write npm-global-prefix "${PROBE_NPM_PREFIX:-}"
try_write usr-local-bin /usr/local/bin
try_write etc /etc

try_write canary "${BOOKING_ISOLATION_CANARY:-}"
# 既存のworld-writableなファイルを（内容を変えずに）書込みモードで開けたら隔離不成立。
while IFS= read -r -d '' f; do
  if ( : >> "$f" ) 2>/dev/null; then escaped+=("world-writable-file"); break; fi
done < <(find /usr /opt /home /etc /var -xdev -type f -perm -0002 -print0 2>/dev/null | head -z -n 20)
if ( : > /.booking-isolation-probe ) 2>/dev/null; then escaped+=(root-filesystem); fi

if [[ -S /var/run/docker.sock && -w /var/run/docker.sock ]]; then escaped+=(docker-socket); fi
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then escaped+=(docker-api); fi
if sudo -n true >/dev/null 2>&1; then escaped+=(sudo); fi
if command -v crontab >/dev/null 2>&1 && echo '* * * * * true' | crontab - >/dev/null 2>&1; then escaped+=(crontab); fi
if command -v at >/dev/null 2>&1 && echo true | at now + 5 minutes >/dev/null 2>&1; then escaped+=(at); fi
for environ in /proc/[0-9]*/environ; do
  [[ -O "$environ" ]] && continue
  if { tr '\0' '\n' < "$environ"; } 2>/dev/null | grep -qE '^(ACTIONS_RUNTIME_TOKEN|GITHUB_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)='; then
    escaped+=("environ-of-other-process"); break
  fi
done
# 環境に GitHub/Actions の変数が無いこと（env -i で起動されている）。
if env | grep -qE '^(GITHUB_|ACTIONS_|RUNNER_)'; then escaped+=(inherited-github-env); fi

# 成功してよい置き土産（後片付けで消えることをCIが確認する）。
setsid nohup sleep 6007 >/dev/null 2>&1 < /dev/null &
( sleep 6008 & ) >/dev/null 2>&1
: > /tmp/booking-isolation-leftover
: > /dev/shm/booking-isolation-leftover 2>/dev/null || true

if [[ "${#escaped[@]}" -gt 0 ]]; then
  echo "Isolation probe: forbidden operations succeeded: ${escaped[*]}" >&2
  exit 1
fi
echo "Isolation probe: every forbidden operation was refused."

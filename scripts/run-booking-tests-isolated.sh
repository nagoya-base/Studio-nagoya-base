#!/usr/bin/env bash
# Issue #874（PR #875 レビュー）: Booking GAS本番workflowの承認後テストを、後続のSecret付きstepから
# プロセスと書込み可能なファイルシステムの両面で隔離して実行する。
#
#   bash scripts/run-booking-tests-isolated.sh repository-tests
#       リポジトリ全体のテスト（stripe-webhook-relayの依存・Jekyll gems・npm test）を隔離実行する。
#   bash scripts/run-booking-tests-isolated.sh probe <repo相対のスクリプト>
#       PR CI専用。隔離を破ろうとするprobeを同じ仕組みで実行し、後片付けと検証が効くことを確かめる。
#
# 隔離の方法（コンテナイメージやDocker socketは使わない）:
#   1. 使い捨てのOSユーザー（sudo・docker・admグループなし、cron/at禁止）をこのrunで新規作成する。
#   2. 承認済みcommitのworkspaceを、そのユーザーのhomeへ複製する（workspace自体は書込み不可のまま）。
#   3. 環境変数を空にして（env -i）、そのユーザーで実行する。GITHUB_*・ACTIONS_*・トークン・Secretは渡らない。
#      mount namespaceでホストの全ファイルシステムを読取り専用にし（world-writableな場所も上書き不可）、/tmp等はnamespace専用tmpfs、
#      PID namespace・no_new_privs・capabilityなしで実行する（詳細は下のlauncher）。
#   4. 終了後（成功・失敗とも）: 全プロセスをKILLして残存0を確認 → そのユーザー所有のファイルを全ファイルシステムで探索し、
#      home・/tmp・/var/tmp・/dev/shm 以外に1つでもあれば失敗（想定外の書込み先＝隔離不成立）、許可領域のものは削除 →
#      ユーザー削除 → workspaceが承認済みcommitのまま無変更（追跡・未追跡・ignoredとも差分なし）であることを確認。
#   いずれかの確認に失敗した場合は、テスト結果に関係なく exit 3 で停止する（後続のSecret付きstepへ進まない）。
# 残余リスク（docs/booking-gas-production-deploy.md）: 同じVMのカーネルを共有するため、カーネル／setuidの脆弱性による
# 権限昇格までは防げない。ネットワークは依存取得のため遮断しない（この時点でSecretは存在しない）。
set -euo pipefail

mode="${1:-}"
workspace="${GITHUB_WORKSPACE:-}"
test_user="booking-test-$$"
test_home="/home/$test_user"
allowed_roots=("$test_home" /tmp /var/tmp /dev/shm)

die() { echo "Isolated tests: $1" >&2; exit "${2:-1}"; }

probe_env=()
case "$mode" in
  repository-tests)
    inner='(cd cloud-run/stripe-webhook-relay && npm ci --ignore-scripts) && bundle install && npm test'
    ;;
  probe)
    probe="${2:-}"
    [[ "$probe" =~ ^[A-Za-z0-9_./-]+\.sh$ && "$probe" != *..* && -f "$workspace/$probe" ]] || die "probe must be an existing repository script"
    inner="bash $probe"
    # probeに攻撃対象の場所だけを教える（値はパスのみ。Secret・トークンは含まない）。
    probe_env=(PROBE_WORKSPACE="$workspace" PROBE_RUNNER_TEMP="${RUNNER_TEMP:-}"
      PROBE_NODE_BIN="$(dirname "$(command -v node)")" PROBE_NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)/lib/node_modules")
    [[ -z "${BOOKING_ISOLATION_CANARY:-}" ]] || probe_env+=(BOOKING_ISOLATION_CANARY="$BOOKING_ISOLATION_CANARY")
    ;;
  *)
    die "unsupported mode (repository-tests | probe <script>)"
    ;;
esac

[[ -n "$workspace" && -d "$workspace/.git" ]] || die "GITHUB_WORKSPACE is not a checkout"
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "GITHUB_SHA is not a 40-digit commit SHA"
sudo -n true 2>/dev/null || die "passwordless sudo is required to create the isolated user"
if id "$test_user" >/dev/null 2>&1; then die "isolated user already exists"; fi

# workspaceが承認済みcommitそのもので、差分・未追跡・ignoredファイルが無いこと（前後で同じ確認をする）。
workspace_is_clean() {
  [[ "$(git -C "$workspace" rev-parse HEAD)" == "$GITHUB_SHA" ]] &&
    [[ -z "$(git -C "$workspace" status --porcelain --untracked-files=all --ignored)" ]]
}
workspace_is_clean || die "workspace is not the clean approved commit before the tests"

# ---- 後片付けと検証（trapで必ず実行。失敗はexit 3） ----
teardown_failed=0
teardown() {
  local uid gid attempt leftovers outside path root ok
  if ! uid="$(id -u "$test_user" 2>/dev/null)" || ! gid="$(id -g "$test_user" 2>/dev/null)"; then
    teardown_failed=1; echo "Isolation teardown: the isolated user is missing" >&2; return
  fi
  sudo -n usermod --lock --expiredate 1 "$test_user" >/dev/null 2>&1 || true
  sudo -n crontab -r -u "$test_user" >/dev/null 2>&1 || true
  # 実UID・実効UIDの両方で、残存0になるまでKILLする（daemon化・二重fork・setsidを含む）。
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sudo -n pkill -KILL -U "$uid" >/dev/null 2>&1 || true
    sudo -n pkill -KILL -u "$uid" >/dev/null 2>&1 || true
    if ! pgrep -U "$uid" >/dev/null && ! pgrep -u "$uid" >/dev/null; then break; fi
    sleep 1
  done
  if pgrep -U "$uid" >/dev/null || pgrep -u "$uid" >/dev/null; then
    teardown_failed=1; echo "Isolation teardown: processes of the isolated user survived" >&2
  fi
  # sudoの試行（拒否されても）でsudo自身が作る記録ファイル（root作成・内容はタイムスタンプのみ）は既知の副作用として削除する。
  sudo -n rm -f "/run/sudo/ts/$test_user" "/run/sudo/ts/$uid" "/var/run/sudo/ts/$test_user" "/var/run/sudo/ts/$uid"
  # そのユーザー所有のファイルを全ファイルシステムで探す（/proc・/sysは除外）。許可領域外は隔離不成立。
  leftovers="$(sudo -n find / \( -path /proc -o -path /sys \) -prune -o \( -user "$uid" -o -group "$gid" \) -print 2>/dev/null || true)"
  outside=""
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    ok=0
    for root in "${allowed_roots[@]}"; do
      if [[ "$path" == "$root" || "$path" == "$root/"* ]]; then ok=1; fi
    done
    [[ "$ok" -eq 1 ]] || outside+="$path"$'\n'
  done <<<"$leftovers"
  if [[ -n "$outside" ]]; then
    teardown_failed=1
    echo "Isolation teardown: the isolated user wrote outside its allowed areas ($(printf '%s' "$outside" | wc -l) path(s)):" >&2
    printf '%s' "$outside" | head -n 20 | sed 's/^/  /' >&2
  fi
  for root in /tmp /var/tmp /dev/shm; do
    sudo -n find "$root" -xdev \( -user "$uid" -o -group "$gid" \) -delete 2>/dev/null || true
  done
  sudo -n userdel --remove "$test_user" >/dev/null 2>&1 || true
  sudo -n groupdel "$test_user" >/dev/null 2>&1 || true
  sudo -n rm -rf "$test_home"
  if id "$test_user" >/dev/null 2>&1 || [[ -e "$test_home" ]]; then
    teardown_failed=1; echo "Isolation teardown: the isolated user or its home still exists" >&2
  fi
  if [[ -n "$(sudo -n find /tmp /var/tmp /dev/shm -xdev \( -user "$uid" -o -group "$gid" \) -print 2>/dev/null || true)" ]]; then
    teardown_failed=1; echo "Isolation teardown: files of the isolated user remain in shared temp areas" >&2
  fi
  if ! workspace_is_clean; then
    teardown_failed=1; echo "Isolation teardown: the workspace changed during the tests" >&2
  fi
}

finish() {
  local status=$?
  trap - EXIT
  teardown
  if [[ "$teardown_failed" -ne 0 ]]; then
    echo "Isolated tests: ISOLATION_NOT_CONFIRMED. Stopping before any step that receives secrets." >&2
    exit 3
  fi
  echo "Isolation confirmed: no process or file of the isolated user remains, and the workspace is the unchanged approved commit."
  exit "$status"
}

sudo -n useradd --create-home --home-dir "$test_home" --shell /bin/bash --user-group "$test_user"
trap finish EXIT
# cron/atによる遅延実行を禁止する（cron.allow/at.allowがあればそちらが優先され、未記載のユーザーは元々不可）。
for deny in /etc/cron.deny /etc/at.deny; do
  echo "$test_user" | sudo -n tee -a "$deny" >/dev/null
done
sudo -n cp -a "$workspace/." "$test_home/repo"
sudo -n rm -f "$test_home/repo/.git/config.lock"
sudo -n chown -R "$test_user:$test_user" "$test_home/repo"
sudo -n mkdir -p "$test_home/tmp"
sudo -n chown "$test_user:$test_user" "$test_home/tmp"

# 依存取得のためのproxy／CA設定だけは引き継ぐ（GitHub-hosted runnerでは通常未設定。Secretではない）。
net_env=()
for name in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE; do
  [[ -z "${!name:-}" ]] || net_env+=("$name=${!name}")
done

# 隔離ユーザーの実行環境（root権限でnamespaceを作り、最後にsetprivで権限を捨てる）:
#  - mount namespace: ホストの全mountを読取り専用にする（world-writableなファイル・ディレクトリへの上書きも不可）。
#    書けるのは隔離ユーザーのhomeと、namespace専用のtmpfs（/tmp・/var/tmp・/dev/shm。終了とともに消える）だけ。
#  - PID namespace: 実行の親プロセス（PID 1）が終わると、namespace内の全プロセスがkernelにより終了させられる。
#  - setpriv: 隔離ユーザーのUID/GIDだけ（補助グループなし）、no_new_privs（sudo等のsetuidで権限を得られない）、capabilityなし。
# namespaceの構築に失敗した場合は exit 97 とし、隔離不成立（exit 3）として扱う。
launcher='
set -euo pipefail
home="$1"; uid="$2"; gid="$3"; shift 3
mount --make-rprivate / || exit 97
mount --bind "$home" "$home" || exit 97
while IFS= read -r mp; do
  case "$mp" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*|"$home") continue ;; esac
  mount -o remount,bind,ro "$mp" || exit 97
done < <(awk "{print \$5}" /proc/self/mountinfo | while IFS= read -r raw; do printf "%b\n" "$raw"; done | sort -u)
for t in /tmp /var/tmp /dev/shm; do
  mount -t tmpfs -o nosuid,nodev,mode=1777 tmpfs "$t" || exit 97
done
if ( : > /.booking-isolation-rw-check ) 2>/dev/null; then rm -f /.booking-isolation-rw-check; exit 97; fi
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"
'

echo "Running $mode as an isolated user (read-only host filesystem, private tmp, own PID namespace, no secrets, no GitHub tokens)"
status=0
sudo -n unshare --mount --pid --fork --mount-proc --propagation private \
  bash -c "$launcher" booking-isolation "$test_home" "$(id -u "$test_user")" "$(id -g "$test_user")" \
  env -i HOME="$test_home" PATH="$PATH" LANG=C.UTF-8 CI=true TMPDIR="$test_home/tmp" \
    BUNDLE_DEPLOYMENT=true BUNDLE_PATH="$test_home/bundle" ${probe_env[@]+"${probe_env[@]}"} ${net_env[@]+"${net_env[@]}"} \
    bash -c "cd \"\$HOME/repo\" && $inner" || status=$?
if [[ "$status" -eq 97 ]]; then
  echo "Isolated tests: the isolation namespace could not be set up." >&2
  teardown_failed=1
  exit 1
fi
if [[ "$status" -ne 0 ]]; then
  echo "Isolated $mode failed (exit $status)." >&2
  exit "$status"
fi
echo "Isolated $mode passed."

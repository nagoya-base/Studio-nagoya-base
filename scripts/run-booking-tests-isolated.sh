#!/usr/bin/env bash
# Issue #874（PR #875 レビュー）: Booking GAS本番workflowの承認後テストを、後続のSecret付きstepから
# プロセスと書込み可能なファイルシステムの両面で隔離して実行する。
#
#   bash scripts/run-booking-tests-isolated.sh repository-tests
#       リポジトリ全体のテスト（stripe-webhook-relayの依存・Jekyll gems・npm test）を隔離実行する。
#   bash scripts/run-booking-tests-isolated.sh probe <repo相対のスクリプト>
#       PR CI専用。隔離を破ろうとするprobeを同じ仕組みで実行し、後片付けと検証が効くことを確かめる。
#
# 隔離の方法（コンテナイメージやDocker socketは使わない。ホストの設定ファイルは変更しない）:
#   1. 使い捨てのOSユーザー（sudo・docker・admグループなし）をこのrunで新規作成する。
#   2. 承認済みcommitのworkspaceを、そのユーザーのhomeへ複製する（workspace自体は書込み不可のまま）。
#   3. 環境変数を空にして（env -i）、そのユーザーで実行する。GITHUB_*・ACTIONS_*・トークン・Secretは渡らない。
#      mount namespaceでホストの全ファイルシステムを読取り専用にし（world-writableな場所も上書き不可）、/tmp等はnamespace専用tmpfs、
#      PID namespace・no_new_privs・capabilityなしで実行する（詳細は下のlauncher）。
#   4. 終了後（成功・失敗とも）: 全プロセスをKILLして残存0を確認 → そのユーザー所有のファイルを全ファイルシステムで探索し、
#      home・/tmp・/var/tmp・/dev/shm 以外に1つでもあれば失敗（想定外の書込み先＝隔離不成立）、許可領域のものは削除して再走査 →
#      ユーザー削除 → workspaceが承認済みcommitのまま無変更（追跡・未追跡・ignoredとも差分なし）であることを確認。
#   いずれかの確認に失敗した場合（走査の失敗・不完全な走査、削除や再確認の失敗を含む）は、テスト結果に関係なく
#   exit 3 で停止する（後続のSecret付きstepへ進まない）。
# 残余リスク（docs/booking-gas-production-deploy.md）: 同じVMのカーネルを共有するため、カーネル／setuidの脆弱性による
# 権限昇格までは防げない。ネットワークは依存取得のため遮断しない（この時点でSecretは存在しない）。
set -euo pipefail

mode="${1:-}"
workspace="${GITHUB_WORKSPACE:-}"
test_user="booking-test-$$"
test_home="/home/$test_user"
allowed_roots=("$test_home" /tmp /var/tmp /dev/shm)

die() { echo "Isolated tests: $1" >&2; exit "${2:-1}"; }

# 遅延計測（Issue #950）。主要な区間（準備・実行・先読み待ち・全走査）の経過ミリ秒だけを stderr に出す（パス・環境変数値・Secretは出さない）。
# 計測は隔離の判定に一切関与しない。
_t_last="${EPOCHREALTIME//[.,]/}"
phase() { local now="${EPOCHREALTIME//[.,]/}"; echo "ISOLATION_TIMING $1 $(( (now - _t_last) / 1000 ))ms" >&2; _t_last="$now"; }

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

# ---- ファイルシステムのメタデータ先読み（Issue #950。判定には一切使わない） ----
# 後片付けの全走査（find /）は、GitHub-hosted runnerの冷えたディスクでは約5分かかる（温まっていれば約3秒）。
# 遅いのは走査の中身ではなく、メタデータの逐次I/O待ちなので、テストの実行中に読取りだけの並列statでキャッシュを温める。
# - 先読みはキャッシュを載せるだけ。隔離の成否は、先読みの後に必ず実行する従来どおりの走査（scan_owned）だけが決める。
# - 先読みの失敗・中断・時間切れは無視してよい（走査はそれでも完全に実行され、失敗すれば従来どおり exit 3）。
# - 何も書き換えない（find による読取りのみ）。走査の範囲・検査の内容は変えない。
# - 先読みには短い上限（既定240秒。冷えたrunnerの実測は約130〜220秒）を設ける。上限に達したら、先読みの全プロセス（root側のtimeoutが
#   プロセスグループごと終了させる）を止めて、必ず元の完全な走査へ進む。任意の最適化が検査時間を押し上げないための上限。
warm_pid=""
warm_limit="${BOOKING_ISOLATION_WARM_TIMEOUT:-240}"
[[ "$warm_limit" =~ ^[0-9]+(\.[0-9]+)?$ ]] || warm_limit=240
warm_fs_cache() {
  local warm_status=0
  # timeout はroot側（sudoの内側）で動かす。外側だとsudoにしか届かず、rootのfind/xargsが残りうる。
  sudo -n env WARM_WORKERS=64 WARM_DEPTH=3 timeout --kill-after=5 "$warm_limit" bash -c '
    prune=( \( -path /proc -o -path /sys \) -prune -o )
    # 浅い階層（DEPTH未満）のディレクトリは直下だけ、DEPTH階層のディレクトリは配下すべてを stat する（ -user はstatを強制するため）。
    find / -maxdepth "$((WARM_DEPTH - 1))" "${prune[@]}" -type d -print0 |
      xargs -0 -r -P "$WARM_WORKERS" -I{} find {} -maxdepth 1 -user 0 -o -nouser -o -print0 >/dev/null 2>&1
    find / -mindepth "$WARM_DEPTH" -maxdepth "$WARM_DEPTH" "${prune[@]}" -type d -print0 |
      xargs -0 -r -P "$WARM_WORKERS" -I{} find {} \( -path /proc -o -path /sys \) -prune -o -user 0 -o -nouser -o -print0 >/dev/null 2>&1
  ' >/dev/null 2>&1 || warm_status=$?
  # 124=時間切れ、137=強制終了。判定には使わず、ログにだけ残す。
  if [[ "$warm_status" -eq 124 || "$warm_status" -eq 137 ]]; then echo "ISOLATION_TIMING warmup-stopped-at-time-limit ${warm_limit}s" >&2; fi
  return 0
}
# BOOKING_ISOLATION_PREWARM=0 は先読みだけを省く（PR CIで、直前のstepで既に温まっている異常注入stepの重複を避ける専用。本番workflowでは使わない）。
# 先読みは判定に関与しないため、これを0にしても走査・隔離条件・exit 3は変わらない。
start_warm_fs_cache() { [[ "${BOOKING_ISOLATION_PREWARM:-1}" != "0" ]] || return 0; warm_fs_cache & warm_pid=$!; }
# 走査の直前に先読みの終了を待つ。待った時間は計測に出す（先読みの結果は成否に影響しない）。
wait_warm_fs_cache() {
  [[ -n "$warm_pid" ]] || return 0
  wait "$warm_pid" 2>/dev/null || :
  warm_pid=""
  return 0
}

# ---- 後片付けと検証（trapで必ず実行。失敗はexit 3） ----
# 方針: 後片付けの各コマンドの失敗・部分的な走査は握りつぶさず、すべて隔離不成立（teardown_failed=1 → exit 3）とする。
teardown_failed=0
teardown_fail() { teardown_failed=1; echo "Isolation teardown: $1" >&2; }

# 指定UID/GIDのプロセス有無。0=あり 1=なし それ以外=pgrep自体の失敗（呼出し側で隔離不成立にする）。
user_processes_exist() {
  local s=0
  pgrep -U "$1" >/dev/null || s=$?
  [[ "$s" -le 1 ]] || return 2
  [[ "$s" -eq 0 ]] && return 0
  s=0
  pgrep -u "$1" >/dev/null || s=$?
  [[ "$s" -le 1 ]] || return 2
  return "$s"
}

# そのユーザー所有（UIDまたはGID）のパスを走査し、結果を scan_result に入れる。
# findが0以外で終わった走査（権限・I/Oエラー、走査中に消えたパスなど）は不完全とみなして最大3回までやり直し、
# 3回とも完全に終わらなければ失敗を返す（呼出し側で隔離不成立にする）。
scan_result=""
scan_owned() { # <uid> <gid> <find対象...>（findの式は固定）
  local uid="$1" gid="$2" attempt out
  shift 2
  for attempt in 1 2 3; do
    if out="$(sudo -n find "$@" \( -path /proc -o -path /sys \) -prune -o \( -user "$uid" -o -group "$gid" \) -print 2>/dev/null)"; then
      scan_result="$out"
      return 0
    fi
    echo "ISOLATION_TIMING scan-attempt-$attempt-incomplete" >&2
    sleep 1
  done
  return 1
}

teardown() {
  local uid gid attempt outside path root ok status
  if ! uid="$(id -u "$test_user" 2>/dev/null)" || ! gid="$(id -g "$test_user" 2>/dev/null)"; then
    teardown_fail "the isolated user is missing"; return
  fi
  # 実UID・実効UIDの両方で、残存0になるまでKILLする（daemon化・二重fork・setsidを含む）。
  # pkillの終了コード1は「該当なし」。それ以外の失敗は隔離不成立。
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    for flag in -U -u; do
      status=0
      sudo -n pkill -KILL "$flag" "$uid" >/dev/null 2>&1 || status=$?
      [[ "$status" -le 1 ]] || { teardown_fail "pkill failed (exit $status)"; return; }
    done
    status=0
    user_processes_exist "$uid" || status=$?
    [[ "$status" -le 1 ]] || { teardown_fail "could not list the processes of the isolated user"; return; }
    [[ "$status" -eq 1 ]] && break
    sleep 1
  done
  status=0
  user_processes_exist "$uid" || status=$?
  [[ "$status" -eq 1 ]] || teardown_fail "processes of the isolated user survived or could not be listed"
  # sudoの試行（拒否されても）でsudo自身が作る記録ファイル（root作成・内容はタイムスタンプのみ）は既知の副作用として削除する。
  sudo -n rm -f "/run/sudo/ts/$test_user" "/run/sudo/ts/$uid" "/var/run/sudo/ts/$test_user" "/var/run/sudo/ts/$uid" ||
    teardown_fail "could not remove sudo timestamp records"
  # そのユーザー所有のファイルを全ファイルシステムで探す（/proc・/sysは除外）。許可領域外は隔離不成立。
  wait_warm_fs_cache
  phase teardown-wait-warmup
  if ! scan_owned "$uid" "$gid" /; then
    teardown_fail "SCAN_FAILED: the filesystem scan for files of the isolated user did not complete"
  else
    outside=""
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      ok=0
      for root in "${allowed_roots[@]}"; do
        if [[ "$path" == "$root" || "$path" == "$root/"* ]]; then ok=1; fi
      done
      [[ "$ok" -eq 1 ]] || outside+="$path"$'\n'
    done <<<"$scan_result"
    if [[ -n "$outside" ]]; then
      teardown_fail "the isolated user wrote outside its allowed areas ($(printf '%s' "$outside" | wc -l) path(s)):"
      printf '%s' "$outside" | head -n 20 | sed 's/^/  /' >&2
    fi
  fi
  phase teardown-full-scan-and-classify
  # 共有一時領域に残った所有ファイルを削除し、必ず再走査で0件を確認する（削除・再走査の失敗も隔離不成立）。
  for root in /tmp /var/tmp /dev/shm; do
    ok=0
    for attempt in 1 2 3; do
      if sudo -n find "$root" -xdev -depth \( -user "$uid" -o -group "$gid" \) -delete 2>/dev/null; then ok=1; break; fi
      sleep 1
    done
    [[ "$ok" -eq 1 ]] || teardown_fail "SHARED_TEMP_CLEANUP_FAILED: could not delete files of the isolated user in $root"
  done
  if ! scan_owned "$uid" "$gid" /tmp /var/tmp /dev/shm; then
    teardown_fail "SCAN_FAILED: the re-scan of the shared temp areas did not complete"
  elif [[ -n "$scan_result" ]]; then
    teardown_fail "files of the isolated user remain in shared temp areas"
  fi
  sudo -n userdel --remove "$test_user" >/dev/null 2>&1 || teardown_fail "userdel failed"
  if getent group "$test_user" >/dev/null; then
    sudo -n groupdel "$test_user" >/dev/null 2>&1 || teardown_fail "groupdel failed"
  fi
  sudo -n rm -rf "$test_home" || teardown_fail "could not remove the isolated home"
  if id "$test_user" >/dev/null 2>&1 || getent group "$test_user" >/dev/null || [[ -e "$test_home" ]]; then
    teardown_fail "the isolated user, its group or its home still exists"
  fi
  if ! workspace_is_clean; then
    teardown_fail "the workspace changed during the tests"
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
start_warm_fs_cache
# cron/atの登録はホストのファイルを変えずに防ぐ: spool（/var/spool）はnamespace内で読取り専用、crontab/atの
# setgidは no_new_privs で効かない。後片付けの全走査でも所有ファイルが残れば隔離不成立になる（/etc/cron.deny等は触らない）。
sudo -n cp -a "$workspace/." "$test_home/repo"
sudo -n rm -f "$test_home/repo/.git/config.lock"
sudo -n chown -R "$test_user:$test_user" "$test_home/repo"
sudo -n mkdir -p "$test_home/tmp"
sudo -n chown "$test_user:$test_user" "$test_home/tmp"
phase setup-user-and-copy-workspace

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
# 同じ場所に重ねたmountは最上位（mountinfoの最後）だけを対象にする。形式: "<mount単位のoptions> <mount point(8進エスケープ)>"。
list_mounts() { awk "{o[\$5]=\$6} END{for (p in o) print o[p], p}" /proc/self/mountinfo | sort -k2; }
while IFS=" " read -r opts raw; do
  mp="$(printf "%b" "$raw")"
  case "$mp" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*|"$home") continue ;; esac
  # 既に読取り専用のmount（snapのsquashfsなど）は、書込めないことが確認済みなので再mountしない（Issue #925:
  # 再mountが "Read-only file system" で失敗してもmount自体は読取り専用のまま）。rwのmountの再mount失敗は従来どおり隔離不成立。
  case ",$opts," in *,ro,*) continue ;; esac
  mount -o remount,bind,ro "$mp" || exit 97
done < <(list_mounts)
# 除外した場所以外に、読取り専用でないmountが1つも残っていないことを再確認する（残れば隔離不成立）。
while IFS=" " read -r opts raw; do
  mp="$(printf "%b" "$raw")"
  case "$mp" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*|"$home") continue ;; esac
  case ",$opts," in *,ro,*) ;; *) echo "mount is still writable: $mp" >&2; exit 97 ;; esac
done < <(list_mounts)
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
phase run-in-namespace
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

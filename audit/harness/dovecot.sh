#!/usr/bin/env bash
# Disposable Dovecot IMAP server for audit tests. Never touches real mail.
# Usage: audit/harness/dovecot.sh start|stop|reset [BASE_DIR] [PORT]
# BASE_DIR must be traversable by the dovecot user (default under /tmp is fine).
# Users: alice/alicepass, bob/bobpass (plaintext auth on 127.0.0.1 only).
# Supports IDLE, UIDPLUS, MOVE, CONDSTORE, QRESYNC (Dovecot 2.3 defaults).
set -euo pipefail
CMD=${1:-start}
BASE=${2:-${AUDIT_IMAP_DIR:-/tmp/stork-audit-imap}}
PORT=${3:-${AUDIT_IMAP_PORT:-14143}}
CONF="$BASE/dovecot.conf"
case "$CMD" in
  stop)  [ -f "$CONF" ] && doveadm -c "$CONF" stop 2>/dev/null || true; exit 0 ;;
  reset) "$0" stop "$BASE" "$PORT"; rm -rf "$BASE"; exec "$0" start "$BASE" "$PORT" ;;
esac
mkdir -p "$BASE"/{run,mail,state}
# Dovecot refuses to run login/mail processes as root, so when run as root
# (typical in containers) use the package's service users and a throwaway
# unprivileged mail owner.
if [ "$(id -u)" = 0 ]; then
  id storkaudit >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin storkaudit
  MU=$(id -u storkaudit); MG=$(id -g storkaudit)
  U=dovecot; G=dovecot; LU=dovenull
  chown -R storkaudit:storkaudit "$BASE/mail"; chmod 755 "$BASE"
else
  MU=$(id -u); MG=$(id -g); U=$(id -un); G=$(id -gn); LU=$U
fi
cat > "$BASE/users" <<USERS
alice:{PLAIN}alicepass:$MU:$MG::$BASE/mail/alice
bob:{PLAIN}bobpass:$MU:$MG::$BASE/mail/bob
USERS
cat > "$CONF" <<CONFEOF
base_dir = $BASE/run
state_dir = $BASE/state
instance_name = stork-audit-$PORT
protocols = imap
listen = 127.0.0.1
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
log_path = $BASE/dovecot.log
default_internal_user = $U
default_internal_group = $G
default_login_user = $LU
first_valid_uid = 1
mail_location = maildir:~/Maildir
service imap-login {
  inet_listener imap {
    address = 127.0.0.1
    port = $PORT
  }
  inet_listener imaps {
    port = 0
  }
  chroot =
}
service anvil {
  chroot =
}
passdb {
  driver = passwd-file
  args = $BASE/users
}
userdb {
  driver = passwd-file
  args = $BASE/users
}
namespace inbox {
  inbox = yes
  separator = /
  mailbox Sent {
    special_use = \\Sent
    auto = create
  }
  mailbox Trash {
    special_use = \\Trash
    auto = create
  }
  mailbox Archive {
    special_use = \\Archive
    auto = create
  }
}
CONFEOF
dovecot -c "$CONF"
for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && { echo "dovecot up on 127.0.0.1:$PORT (base $BASE)"; exit 0; }; sleep 0.1; done
echo "dovecot failed to start; see $BASE/dovecot.log" >&2; tail -20 "$BASE/dovecot.log" >&2; exit 1

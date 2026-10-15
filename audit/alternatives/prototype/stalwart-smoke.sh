#!/usr/bin/env bash
# THROWAWAY PROTOTYPE (audit only). Option D smoke test:
#   Dovecot (stand-in for Namecheap, port 14204) <-mbsync IMAP<->IMAP-> Stalwart (local binary)
# Prereqs: Stalwart binary at $STALWART (download github.com/stalwartlabs/stalwart releases v0.16.26
#   stalwart-x86_64-unknown-linux-gnu.tar.gz), started as:
#   STALWART_RECOVERY_ADMIN=admin:auditpass-1234 stalwart -c c.json   with c.json = {"@type":"RocksDb","path":"..."}
#   (binds 25/443/465/993/995/4190/8080 by default — throwaway container only)
# Also needs /tmp/stork-audit-maildir/namecheap from gen-maildir.ts (500 msgs, Maildir++ = Dovecot layout).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
BASE=/tmp/stork-audit-imap-alt; PORT=14204; W=/tmp/stork-audit-stalwart-mbsync
CONF=$BASE/dovecot.conf
bash "$REPO/audit/harness/dovecot.sh" reset $BASE $PORT
mkdir -p $BASE/mail/alice/Maildir && cp -a /tmp/stork-audit-maildir/namecheap/. $BASE/mail/alice/Maildir/
# strip mbsync ,U= from the copied names (Dovecot assigns its own UIDs)
find $BASE/mail/alice/Maildir -type f -name '*,U=*' | while read -r f; do mv "$f" "${f/,U=[0-9]*:/:}"; done
chown -R storkaudit:storkaudit $BASE/mail
doveadm -c $CONF mailbox status -u alice 'messages' '*'
rm -rf $W; mkdir -p $W
openssl s_client -connect 127.0.0.1:993 </dev/null 2>/dev/null | openssl x509 > $W/stalwart.pem
cat > $W/mbsyncrc <<EOF
IMAPAccount dove
Host 127.0.0.1
Port $PORT
User alice
Pass alicepass
SSLType None
AuthMechs LOGIN

IMAPStore far
Account dove

IMAPAccount stal
Host 127.0.0.1
Port 993
User admin
Pass auditpass-1234
SSLType IMAPS
CertificateFile $W/stalwart.pem
AuthMechs LOGIN

IMAPStore near
Account stal

Channel c
Far :far:
Near :near:
Patterns * !"Deleted Items" !"Sent Items" !"Junk Mail" !Drafts
Create Near
# Stalwart pre-creates 'Deleted Items','Sent Items','Junk Mail','Drafts' — exclude, map special-use by hand
Expunge Both
Sync All
SyncState $W/state/
EOF
mkdir -p $W/state
t0=$(date +%s.%N); mbsync -c $W/mbsyncrc -a -q 2>&1 | grep -v 'in the clear' || true; t1=$(date +%s.%N)
echo "initial IMAP->IMAP copy: $(echo "$t1 - $t0" | bc) s"
python3 - <<'PY'
import imaplib, ssl
c=ssl.create_default_context(); c.check_hostname=False; c.verify_mode=ssl.CERT_NONE
M=imaplib.IMAP4_SSL('127.0.0.1',993,ssl_context=c); M.login('admin','auditpass-1234')
for box in ['INBOX','Archive','Sent']:
    typ,d=M.select(box, readonly=True); print('stalwart', box, d)
M.select('INBOX'); print('stalwart before:', M.search(None,'FLAGGED'))
print(M.store('1', '+FLAGS', '(\\Flagged \\Seen)')); print('stalwart: flagged seq 1')
PY
mbsync -c $W/mbsyncrc -a -q 2>&1 | grep -v 'in the clear' || true
echo "dovecot flags after near->far sync (expect one \\Flagged \\Seen more):"
doveadm -c $CONF search -u alice mailbox INBOX FLAGGED | wc -l
t2=$(date +%s.%N); mbsync -c $W/mbsyncrc -a -q 2>&1 | grep -v 'in the clear' || true; t3=$(date +%s.%N)
echo "no-op resync: $(echo "$t3 - $t2" | bc) s"

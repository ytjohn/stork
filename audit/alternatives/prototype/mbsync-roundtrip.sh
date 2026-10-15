#!/usr/bin/env bash
# THROWAWAY PROTOTYPE (audit only). Proves the write-back contract end to end:
#   Dovecot (stand-in for Namecheap) <-mbsync-> local Maildir <- Stork-style renames
# Usage: bash audit/alternatives/prototype/mbsync-roundtrip.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
BASE=/tmp/stork-audit-imap-alt; PORT=14204; LOCAL=/tmp/stork-audit-mbsync-local
CONF=$BASE/dovecot.conf
bash "$REPO/audit/harness/dovecot.sh" reset $BASE $PORT
rm -rf $LOCAL; mkdir -p $LOCAL/mail
# Seed the "server" with 3 messages via doveadm (real IMAP UIDs assigned by Dovecot).
for i in 1 2 3; do
  printf 'From: a@example.com\r\nTo: alice@example.com\r\nSubject: rt %s\r\nMessage-ID: <rt%s@audit>\r\nDate: Mon, 05 Oct 2026 10:00:0%s +0000\r\n\r\nbody %s\r\n' $i $i $i $i \
    | doveadm -c $CONF save -u alice -m INBOX
done
cat > $LOCAL/mbsyncrc <<EOF
IMAPAccount t
Host 127.0.0.1
Port $PORT
User alice
Pass alicepass
SSLType None
AuthMechs LOGIN

IMAPStore far
Account t

MaildirStore near
Path $LOCAL/mail/
Inbox $LOCAL/mail/INBOX
SubFolders Verbatim

Channel c
Far :far:
Near :near:
Patterns *
Create Both
Expunge Both
Sync All
SyncState *
EOF
mb() { mbsync -c $LOCAL/mbsyncrc -a -q; }
flags() { doveadm -c $CONF fetch -u alice 'mailbox uid flags hdr.subject' ALL 2>/dev/null | tr '\n' ' ' | sed 's/mailbox: /\n  /g'; echo; }
mb
echo "== after initial pull"; find $LOCAL/mail -type f -path '*/cur/*' -o -type f -path '*/new/*' | sed "s|$LOCAL/mail/||"
# 1. Stork-style flag write-back: rename file suffix (msg 1 -> Seen+Flagged)
f1=$(grep -rl 'Subject: rt 1' $LOCAL/mail/INBOX | head -1)
base=$(basename "$f1"); base=${base%%:2,*}
mv "$f1" "$LOCAL/mail/INBOX/cur/$base:2,FS"
# 2. Stork-style move: msg 2 INBOX -> Archive, stripping ,U=<uid>
f2=$(grep -rl 'Subject: rt 2' $LOCAL/mail/INBOX | head -1)
b2=$(basename "$f2"); u2=${b2%%,*}
mkdir -p $LOCAL/mail/Archive/{cur,new,tmp}
mv "$f2" "$LOCAL/mail/Archive/cur/$u2.stork-mv:2,S"
# 3. Stork-style delete: msg 3 gets T flag (mbsync Expunge Both removes it upstream)
f3=$(grep -rl 'Subject: rt 3' $LOCAL/mail/INBOX | head -1)
b3=$(basename "$f3"); b3=${b3%%:2,*}
mv "$f3" "$LOCAL/mail/INBOX/cur/$b3:2,T"
mb
echo "== server state after push (expect rt1 \\Seen \\Flagged in INBOX; rt2 in Archive w/ NEW uid; rt3 gone)"; flags
echo "== local after push"; find $LOCAL/mail -type f \( -path '*/cur/*' -o -path '*/new/*' \) | sed "s|$LOCAL/mail/||"
# 4. Server-side change (phone marks rt1 unread) -> mbsync renames local file -> Stork rescan would see it
doveadm -c $CONF flags remove -u alice '\Seen' mailbox INBOX HEADER Subject 'rt 1'
mb
echo "== local after server-side unflag (expect rt1 suffix :2,F)"; ls $LOCAL/mail/INBOX/cur/

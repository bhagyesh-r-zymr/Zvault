#!/usr/bin/env bash
# Run on your Mac (not the box). Lists the landing-page waitlist from the
# database, and with --verify asks Amazon SES to verify each new joiner's
# email so they can receive Zvault's sign-up code while SES is in sandbox
# mode. SES emails them a confirmation link; mail reaches them once clicked.
#
#   deploy/ec2/waitlist.sh             # list sign-ups; refresh who has verified
#   deploy/ec2/waitlist.sh --verify    # also send SES links to everyone pending
#
# Each row's status in the database moves pending -> verification_sent ->
# verified, so --verify only touches new joiners. Uses your SSH alias for the
# box and your AWS profile; no new credentials. Override with ZVAULT_SSH_HOST,
# AWS_PROFILE, AWS_REGION.
set -euo pipefail

host=${ZVAULT_SSH_HOST:-demo-ec2}
export AWS_PROFILE=${AWS_PROFILE:-bhagyesh-personal}
export AWS_REGION=${AWS_REGION:-ap-south-1}
verify=false
case "${1:-}" in
  --verify) verify=true ;;
  '') ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

# Runs SQL from stdin in the demo database.
psql_box() {
  ssh "$host" 'cd ~/zvault && docker compose exec -T postgres psql -U zvault -d zvault -v ON_ERROR_STOP=1 -q -At -F "$(printf "\t")"'
}

# Tab-separated: email, status, name, joined, note. The note (which may be
# empty) is last because read collapses adjacent tabs.
rows=$(psql_box <<'SQL'
select email, status, name, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), note
from waitlist order by created_at;
SQL
)

if [ -z "$rows" ]; then
  echo 'Nobody has joined the waitlist yet.'
  exit 0
fi

ses_status() {
  aws sesv2 get-email-identity --email-identity "$1" \
    --query 'VerificationStatus' --output text 2>/dev/null || echo 'NOT_ADDED'
}
sql_str() { printf "'%s'" "${1//\'/\'\'}"; }

updates=''
set_status() {
  updates+="update waitlist set status = '$2', updated_at = now() where email = $(sql_str "$1");"$'\n'
}

printf '%-17s  %-32s  %-24s  %-18s  %s\n' 'JOINED (UTC)' 'EMAIL' 'NAME' 'STATUS' 'TEAM OR REASON'
total=0 sent=0 pending=0
while IFS=$'\t' read -r email status name joined note; do
  total=$((total + 1))
  if [ "$status" != 'verified' ]; then
    ses=$(ses_status "$email")
    if [ "$ses" = 'SUCCESS' ]; then
      status=verified
      set_status "$email" verified
    elif [ "$ses" = 'NOT_ADDED' ] && $verify; then
      aws sesv2 create-email-identity --email-identity "$email" >/dev/null
      status=verification_sent
      set_status "$email" verification_sent
      sent=$((sent + 1))
    elif [ "$ses" != 'NOT_ADDED' ] && [ "$status" = 'pending' ]; then
      # Added to SES some other way (e.g. the console).
      status=verification_sent
      set_status "$email" verification_sent
    fi
  fi
  [ "$status" = 'pending' ] && pending=$((pending + 1))
  printf '%-17s  %-32s  %-24s  %-18s  %s\n' "$joined" "$email" "$name" "$status" "$note"
done <<<"$rows"

[ -n "$updates" ] && psql_box <<<"$updates"

echo
echo "$total on the waitlist, $pending pending."
if $verify; then
  echo "Sent SES verification links to $sent new address(es). They can sign up once they click it."
elif [ "$pending" -gt 0 ]; then
  echo 'Run with --verify to send SES verification links to everyone pending.'
fi

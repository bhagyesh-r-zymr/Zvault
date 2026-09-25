#!/usr/bin/env bash
# Run on your Mac (not the box). Lists the landing-page waitlist, and with
# --verify asks Amazon SES to verify each joiner's email, so they can receive
# Zvault's sign-up code while SES is in sandbox mode. SES emails each new
# address a confirmation link; they must click it before Zvault mail arrives.
#
#   deploy/ec2/waitlist.sh             # list sign-ups and their SES status
#   deploy/ec2/waitlist.sh --verify    # also send SES verification to new ones
#
# Uses your existing SSH alias for the box and your AWS profile; no new
# credentials. Override with ZVAULT_SSH_HOST, AWS_PROFILE, AWS_REGION.
set -euo pipefail

host=${ZVAULT_SSH_HOST:-demo-ec2}
export AWS_PROFILE=${AWS_PROFILE:-bhagyesh-personal}
export AWS_REGION=${AWS_REGION:-ap-south-1}
verify=false
case "${1:-}" in
  --verify) verify=true ;;
  '') ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

# Tab-separated: email, name, joined, note. The note (which may be empty) is
# last because read collapses adjacent tabs.
rows=$(ssh "$host" 'cd ~/zvault && docker compose exec -T postgres psql -U zvault -d zvault -At -F "$(printf "\t")" -c "select email, name, to_char(created_at at time zone '"'"'UTC'"'"', '"'"'YYYY-MM-DD HH24:MI'"'"'), note from waitlist order by created_at"')

if [ -z "$rows" ]; then
  echo 'Nobody has joined the waitlist yet.'
  exit 0
fi

ses_status() {
  aws sesv2 get-email-identity --email-identity "$1" \
    --query 'VerificationStatus' --output text 2>/dev/null || echo 'NOT_ADDED'
}

printf '%-17s  %-32s  %-24s  %-12s  %s\n' 'JOINED (UTC)' 'EMAIL' 'NAME' 'SES' 'TEAM OR REASON'
count=0 sent=0
while IFS=$'\t' read -r email name joined note; do
  count=$((count + 1))
  status=$(ses_status "$email")
  if $verify && [ "$status" = 'NOT_ADDED' ]; then
    aws sesv2 create-email-identity --email-identity "$email" >/dev/null
    status='LINK_SENT'
    sent=$((sent + 1))
  fi
  printf '%-17s  %-32s  %-24s  %-12s  %s\n' "$joined" "$email" "$name" "$status" "$note"
done <<<"$rows"

echo
echo "$count on the waitlist."
if $verify; then
  echo "Sent SES verification links to $sent new address(es). They can sign up once they click it (status SUCCESS)."
else
  echo 'Run with --verify to send SES verification links to anyone NOT_ADDED.'
fi

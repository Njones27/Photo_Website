#!/usr/bin/env bash
# Prepares a Route 53 hosted zone for the site's domain in the prod account, ready for the nameserver switch.
#
#   infra/script/setup_domain.sh [domain] [aws-profile]      (defaults: nathanjonesphoto.co photo-prod)
#
# Safe to re-run. It:
#   1. creates the public hosted zone (or finds the one already there)
#   2. creates the SES domain identity, so booking emails and confirmations are DKIM-signed for the domain
#   3. copies the mail records live in DNS today into the zone (apex MX and TXT, Google's DKIM key, DMARC), adds an
#      SPF record for Google if there is none, and adds the three SES DKIM CNAMEs
#   4. prints the zone id for config/app-config-prod.json and the four nameservers to set at the registrar
#
# It never writes the apex or www A/AAAA records: the Web stack owns those. Records on other subdomains are not
# copied, so check the registrar's DNS page for any before switching nameservers.
set -euo pipefail

DOMAIN="${1:-nathanjonesphoto.co}"
PROFILE="${2:-photo-prod}"
aws_() { aws --profile "$PROFILE" --region us-east-1 "$@"; }

command -v dig >/dev/null || { echo "dig is required" >&2; exit 1; }

zone="$(aws_ route53 list-hosted-zones-by-name --dns-name "$DOMAIN." \
    --query "HostedZones[?Name=='$DOMAIN.' && !Config.PrivateZone].Id | [0]" --output text)"
if [ "$zone" = "None" ] || [ -z "$zone" ]; then
    echo "Creating the hosted zone for $DOMAIN"
    zone="$(aws_ route53 create-hosted-zone --name "$DOMAIN" --caller-reference "photo-$(date +%s)" \
        --query HostedZone.Id --output text)"
else
    echo "Using the existing hosted zone for $DOMAIN"
fi
zone="${zone#/hostedzone/}"

if ! tokens="$(aws_ sesv2 get-email-identity --email-identity "$DOMAIN" --query 'DkimAttributes.Tokens' --output text 2>/dev/null)"; then
    echo "Creating the SES identity for $DOMAIN"
    tokens="$(aws_ sesv2 create-email-identity --email-identity "$DOMAIN" --query 'DkimAttributes.Tokens' --output text)"
fi

batch="$(mktemp)"
trap 'rm -f "$batch"' EXIT
DOMAIN="$DOMAIN" TOKENS="$tokens" \
MX="$(dig +short MX "$DOMAIN")" \
TXT="$(dig +short TXT "$DOMAIN")" \
GDKIM="$(dig +short TXT "google._domainkey.$DOMAIN")" \
DMARC="$(dig +short TXT "_dmarc.$DOMAIN")" \
python3 - >"$batch" <<'PY'
import json, os

domain = os.environ["DOMAIN"]
lines = lambda name: [l.strip() for l in os.environ[name].splitlines() if l.strip()]
changes = []

def upsert(name, rtype, values):
    if values:
        changes.append({"Action": "UPSERT", "ResourceRecordSet": {
            "Name": name, "Type": rtype, "TTL": 300, "ResourceRecords": [{"Value": v} for v in values]}})

mx = lines("MX")
upsert(domain, "MX", mx)
txt = lines("TXT")
if mx and not any("v=spf1" in t for t in txt) and any("google.com" in m for m in mx):
    txt.append('"v=spf1 include:_spf.google.com ~all"')
upsert(domain, "TXT", txt)
# dig prints a long TXT value as several quoted strings on one line, which is how Route 53 takes it too.
upsert(f"google._domainkey.{domain}", "TXT", lines("GDKIM"))
upsert(f"_dmarc.{domain}", "TXT", lines("DMARC") or ['"v=DMARC1; p=none"'])
for token in os.environ["TOKENS"].split():
    upsert(f"{token}._domainkey.{domain}", "CNAME", [f"{token}.dkim.amazonses.com"])

json.dump({"Comment": "Mail and SES records copied before the nameserver switch", "Changes": changes}, open(1, "w"), indent=2)
PY

echo "Writing these records:"
python3 -c 'import json,sys; [print(" ", c["ResourceRecordSet"]["Type"].ljust(5), c["ResourceRecordSet"]["Name"], "->", " | ".join(r["Value"] for r in c["ResourceRecordSet"]["ResourceRecords"])) for c in json.load(open(sys.argv[1]))["Changes"]]' "$batch"
aws_ route53 change-resource-record-sets --hosted-zone-id "$zone" --change-batch "file://$batch" --query ChangeInfo.Status --output text

echo
echo "HostedZoneId for config/app-config-prod.json: $zone"
echo "Set these nameservers at the registrar:"
aws_ route53 get-hosted-zone --id "$zone" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sed 's/^/  /'

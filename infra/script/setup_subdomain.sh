#!/usr/bin/env bash
# Gives a stage its own subdomain: a hosted zone in that stage's account, delegated from the parent zone in prod.
#
#   infra/script/setup_subdomain.sh [subdomain] [stage-profile] [parent-profile]
#   (defaults: dev.nathanjonesphoto.co photo-beta photo-prod)
#
# Safe to re-run. It creates (or finds) the public zone for the subdomain in the stage account, writes an NS record
# for it in the parent zone so the world can find it, and prints the zone id for that stage's config. The Web stack
# then adds the certificate and the A/AAAA records inside the subdomain's zone.
set -euo pipefail

SUB="${1:-dev.nathanjonesphoto.co}"
STAGE_PROFILE="${2:-photo-beta}"
PARENT_PROFILE="${3:-photo-prod}"
PARENT="${SUB#*.}"

find_zone() { # profile name
    aws --profile "$1" route53 list-hosted-zones-by-name --dns-name "$2." \
        --query "HostedZones[?Name=='$2.' && Config.PrivateZone==`false`].Id | [0]" --output text
}

zone="$(find_zone "$STAGE_PROFILE" "$SUB")"
if [ "$zone" = "None" ] || [ -z "$zone" ]; then
    echo "Creating the hosted zone for $SUB with $STAGE_PROFILE"
    zone="$(aws --profile "$STAGE_PROFILE" route53 create-hosted-zone --name "$SUB" \
        --caller-reference "photo-$(date +%s)" --query HostedZone.Id --output text)"
else
    echo "Using the existing hosted zone for $SUB"
fi
zone="${zone#/hostedzone/}"

parent_zone="$(find_zone "$PARENT_PROFILE" "$PARENT")"
if [ "$parent_zone" = "None" ] || [ -z "$parent_zone" ]; then
    echo "No hosted zone for $PARENT under $PARENT_PROFILE: run setup_domain.sh first" >&2
    exit 1
fi
parent_zone="${parent_zone#/hostedzone/}"

ns_values="$(aws --profile "$STAGE_PROFILE" route53 get-hosted-zone --id "$zone" \
    --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' \
    | sed 's/.*/{"Value":"&."}/' | paste -sd, -)"
echo "Delegating $SUB from the $PARENT zone"
aws --profile "$PARENT_PROFILE" route53 change-resource-record-sets --hosted-zone-id "$parent_zone" \
    --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$SUB\",\"Type\":\"NS\",\"TTL\":300,\"ResourceRecords\":[$ns_values]}}]}" \
    --query ChangeInfo.Status --output text

echo
echo "HostedZoneId for the stage config: $zone"

#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-us-west-1}"
API_EIP="${API_EIP:-184.169.192.250}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"
NAME="${NAME:-praxis-worker}"
ROOT_GB="${ROOT_GB:-40}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
HERE="$(cd "$(dirname "$0")" && pwd)"

aws_() { aws --region "$REGION" "$@"; }

if [ -n "$(aws_ ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text)" ]; then
  echo "An instance tagged Name=$NAME already exists. Refusing to create a second worker (one worker until boot-reap is owner-aware)." >&2
  exit 1
fi

read -r SUBNET SG KEY PROFILE < <(aws_ ec2 describe-instances \
  --filters "Name=ip-address,Values=$API_EIP" \
  --query 'Reservations[0].Instances[0].[SubnetId, SecurityGroups[0].GroupId, KeyName, IamInstanceProfile.Arn]' \
  --output text)
[ -n "${SUBNET:-}" ] && [ "$SUBNET" != "None" ] || { echo "Could not find the API host by $API_EIP" >&2; exit 1; }

AMI="$(aws_ ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text 2>/dev/null || true)"
if [ -z "$AMI" ]; then
  AMI="$(aws_ ec2 describe-images --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)"
fi
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { echo "Could not resolve an Ubuntu 24.04 AMI" >&2; exit 1; }

cat <<PLAN
Worker host to create (region $REGION):
  name             $NAME
  type             $INSTANCE_TYPE (8 GB)
  ami              $AMI (Ubuntu 24.04)
  root disk        ${ROOT_GB} GB gp3
  subnet           $SUBNET          (same as the API host)
  security group   $SG              (same as the API host)
  key pair         $KEY             (deploy.yml's EC2_SSH_KEY_PRAXIS)
  instance profile $PROFILE
  user-data        infra/scripts/worker-user-data.sh
  + one new Elastic IP
PLAN

if [ "$APPLY" != "1" ]; then
  echo
  echo "Dry run. Re-run with --apply to create it."
  exit 0
fi

ID="$(aws_ ec2 run-instances \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" --key-name "$KEY" \
  --iam-instance-profile "Arn=$PROFILE" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$ROOT_GB,VolumeType=gp3}" \
  --metadata-options "HttpTokens=required" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --user-data "file://$HERE/worker-user-data.sh" \
  --query 'Instances[0].InstanceId' --output text)"
echo "Created $ID; waiting for it to run..."
aws_ ec2 wait instance-running --instance-ids "$ID"

ALLOC="$(aws_ ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)"
aws_ ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
EIP="$(aws_ ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)"
echo "Elastic IP $EIP attached."

echo "Waiting for user-data to finish (up to ~10 min)..."
OUT=""
for _ in $(seq 1 40); do
  OUT="$(aws_ ec2 get-console-output --instance-id "$ID" --latest --output text 2>/dev/null || true)"
  printf '%s' "$OUT" | grep -q "=== ZAVI-WORKER-END ===" && break
  sleep 15
done
if ! printf '%s' "$OUT" | grep -q "=== ZAVI-WORKER-END ==="; then
  echo "User-data has not printed its keys yet. Re-read later with:" >&2
  echo "  aws --region $REGION ec2 get-console-output --instance-id $ID --latest --output text" >&2
  exit 1
fi

DEPLOY_KEY="$(printf '%s\n' "$OUT" | sed -n '/=== ZAVI-WORKER-DEPLOY-KEY/,/=== ZAVI-WORKER-HOST-KEYS/p' | grep '^ssh-')"
KNOWN_HOSTS="$(printf '%s\n' "$OUT" | sed -n '/=== ZAVI-WORKER-HOST-KEYS/,/=== ZAVI-WORKER-END/p' | grep -E '^(ssh-ed25519|ecdsa-sha2-)' | awk -v ip="$EIP" '{print ip" "$1" "$2}')"

cat <<NEXT

Worker $ID is up at $EIP. Do these before the first worker deploy:

0. AWS secret zavi-prod-worker (the worker reads praxis-envprod-1, then this;
   only the keys that differ on the worker):
   aws --region $REGION secretsmanager create-secret --name zavi-prod-worker \
     --secret-string '{"INNGEST_SERVE_HOST":"https://jobs.zaviagent.com","INNGEST_SELF_SYNC_URL":"https://jobs.zaviagent.com/api/inngest"}'
   Check the instance profile above may read it (IAM console: its policy must
   allow secretsmanager:GetSecretValue on zavi-prod-worker, not only on
   praxis-envprod-1). Without it the worker container refuses to start.

1. DNS: add an A record  jobs.zaviagent.com -> $EIP

2. GitHub: add this as a READ-ONLY deploy key on the repo deploy.yml clones:
   $DEPLOY_KEY

3. Repo variables (full known_hosts lines, never ssh-keyscan at deploy time):
   gh variable set WORKER_EC2_HOST --body '$EIP'
   gh variable set WORKER_EC2_KNOWN_HOSTS --body '$KNOWN_HOSTS'

4. Prod Supabase DB allowlist (today: the API host + one home IP). Re-run with
   every CIDR you keep plus the worker:
   supabase network-restrictions get --project-ref wmycgyjsenvgtczlupoe --experimental
   supabase network-restrictions update --project-ref wmycgyjsenvgtczlupoe --experimental \\
     --db-allow-cidr 184.169.192.250/32 --db-allow-cidr $EIP/32 --db-allow-cidr <each other CIDR from get>
   Repeat for any site shard project that restricts by IP.
NEXT

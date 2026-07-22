#!/usr/bin/env bash
#
# Stand up a single EC2 box for the Metis demo: a key pair, a security group
# (SSH from you, HTTP/HTTPS from anywhere), an Amazon Linux 2023 instance with
# Docker installed by cloud-init, and a stable Elastic IP. Idempotent-ish: it
# reuses a key pair / security group / instance of the same name if they exist.
#
# Usage:  REGION=eu-west-1 ./provision.sh
# Writes: ./.state (INSTANCE_ID, EIP, allocation id) and ./<KEY_NAME>.pem
#
set -euo pipefail

REGION="${REGION:-eu-west-1}"
NAME="${NAME:-metis-demo}"
KEY_NAME="${KEY_NAME:-metis-demo-key}"
# Match ARCH to the architecture your local Metis image was built for (docker
# build arch): amd64 -> Intel t3.small, arm64 -> Graviton t4g.small (cheaper,
# and the right choice when you build on an Apple Silicon Mac).
ARCH="${ARCH:-amd64}"
if [ "$ARCH" = "arm64" ]; then
  INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
  AMI_PARAM=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64
else
  INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
  AMI_PARAM=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
fi
SSH_CIDR="${SSH_CIDR:-$(curl -fsS https://checkip.amazonaws.com)/32}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PEM="${PEM:-$HERE/$KEY_NAME.pem}"
aws() { command aws --region "$REGION" "$@"; }

AMI=$(aws ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)

# Key pair (private key saved locally, chmod 400).
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial --output text > "$PEM"
  chmod 400 "$PEM"
  echo "key pair created -> $PEM"
fi

# Security group: 22 from you, 80/443 from the world.
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Metis demo" --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$SSH_CIDR" >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  echo "security group created -> $SG"
fi

# Instance (reuse a running one of this Name tag if present).
INSTANCE_ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" "Name=instance-state-name,Values=pending,running" --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)
if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --security-group-ids "$SG" --subnet-id "$SUBNET" \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3}' \
    --user-data "file://$HERE/user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "instance launched -> $INSTANCE_ID"
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# Elastic IP: allocate + associate so the URL survives reboots.
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)
if [ "$ALLOC" = "None" ] || [ -z "$ALLOC" ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)
fi
aws ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC" >/dev/null
EIP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)

printf 'INSTANCE_ID=%s\nALLOC=%s\nEIP=%s\nREGION=%s\nPEM=%s\n' "$INSTANCE_ID" "$ALLOC" "$EIP" "$REGION" "$PEM" > "$HERE/.state"
echo "READY  EIP=$EIP  host=metis.${EIP//./-}.sslip.io"

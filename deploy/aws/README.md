# Metis demo on AWS

One small EC2 box running the compose stack behind Caddy (automatic HTTPS). No
Terraform: it is a single instance, so two shell scripts and cloud-init do the
job. Add IaC when there is a second environment.

## Stand it up

```bash
cd deploy/aws

# 1. Provision: key pair, security group (SSH from you, 80/443 from the world),
#    an Amazon Linux 2023 box with Docker, and a stable Elastic IP.
REGION=eu-west-1 ./provision.sh          # prints the Elastic IP + sslip.io host

# 2. Secrets: copy the template and fill in strong values. Set METIS_DEMO_HOST
#    to the sslip.io host printed above (metis.<dashed-eip>.sslip.io).
cp ../../compose/.env.example .env
$EDITOR .env

# 3. Ship the locally-built image + compose files and bring it up.
./ship.sh                                 # prints the https URL
```

The image is whatever you have built locally as `metis-metis:latest` (the same
one the local `docker compose` produces). `ship.sh` doubles as redeploy: rebuild
locally, re-run it.

## TLS

Caddy fetches a Let's Encrypt certificate for `METIS_DEMO_HOST` on first request.
`sslip.io` resolves `metis.<dashed-ip>.sslip.io` to that IP with no DNS setup, so
HTTPS works out of the box. To use a real domain instead, point an A record at
the Elastic IP and set `METIS_DEMO_HOST` to it.

## Operate

```bash
source .state                                             # EIP, PEM
ssh -i "$PEM" ec2-user@"$EIP"                             # onto the box
#   cd ~/metis && docker compose ... logs -f              # tail logs
#   ... down                                               # stop
```

## Tear it down

```bash
source .state
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
aws ec2 release-address     --region "$REGION" --allocation-id "$ALLOC"
```

`.state`, `.env` and `*.pem` are local only and git-ignored - they hold the
Elastic IP, secrets and the private key.

#!/bin/sh
# Counts what a deployed architecture is actually running on floci: VPCs, NAT
# gateways, Elastic IPs, RDS instances, Lambda functions, ECS services, load
# balancers, REST and HTTP APIs, queues, and stacks. Prints one JSON line.
set -eu
ARCH=${1:?usage: scripts/measure-live.sh <arch>}
set -a; . "infra/$ARCH/.env"; set +a
n() { "$@" --output json 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin) or []))'; }
printf '{"arch":"%s","vpcs":%s,"nat_gateways":%s,"elastic_ips":%s,"rds":%s,"lambdas":%s,"ecs_services":%s,"load_balancers":%s,"rest_apis":%s,"http_apis":%s,"queues":%s,"stacks":%s}\n' \
  "$ARCH" \
  "$(n aws ec2 describe-vpcs --filters Name=is-default,Values=false --query Vpcs)" \
  "$(n aws ec2 describe-nat-gateways --filter Name=state,Values=pending,available --query NatGateways)" \
  "$(n aws ec2 describe-addresses --query Addresses)" \
  "$(n aws rds describe-db-instances --query DBInstances)" \
  "$(n aws lambda list-functions --query Functions)" \
  "$(for c in $(aws ecs list-clusters --query clusterArns --output text); do aws ecs list-services --cluster "$c" --query serviceArns --output text; done | wc -w | tr -d ' ')" \
  "$(n aws elbv2 describe-load-balancers --query LoadBalancers)" \
  "$(n aws apigateway get-rest-apis --query items)" \
  "$(n aws apigatewayv2 get-apis --query Items)" \
  "$(n aws sqs list-queues --query QueueUrls)" \
  "$(n aws cloudformation describe-stacks --query 'Stacks[?StackName!=`CDKToolkit`]')"

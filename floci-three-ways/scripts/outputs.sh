#!/bin/sh
# Rebuild infra/<arch>/outputs.json from every deployed stack, so a partial
# deploy (deploy-apps) does not drop the base and messaging stack outputs.
set -eu
ARCH=${1:?usage: scripts/outputs.sh <arch>}
set -a; . "infra/$ARCH/.env"; set +a
aws cloudformation describe-stacks \
  --query 'Stacks[?StackName!=`CDKToolkit`].{name:StackName,outputs:Outputs}' --output json \
| python3 -c '
import json,sys
d={s["name"]:{o["OutputKey"]:o["OutputValue"] for o in (s["outputs"] or [])} for s in json.load(sys.stdin)}
print(json.dumps(d,indent=2))' > "infra/$ARCH/outputs.json"
python3 -c "import json;d=json.load(open('infra/$ARCH/outputs.json'));print({k:len(v) for k,v in d.items()})"

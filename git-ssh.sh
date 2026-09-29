#!/bin/bash
exec ssh -i /tmp/id_ed25519_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -p 443 "$@"

#!/usr/bin/env bash
set -euo pipefail

# Loads YoLink UAID + Secret Key from 1Password service account vault,
# exports them as env vars (without printing), then runs the Homey app.
#
# Prereqs:
# - OP_SERVICE_ACCOUNT_TOKEN is available in the environment (we load it from Keychain via .bashrc)
# - Vault: "AI Shared"
# - Item:  "YoLink"
# - Fields: "UAID" and "Secret Key"

VAULT_NAME="${OP_VAULT_NAME:-AI Shared}"
ITEM_NAME="${OP_YOLINK_ITEM_NAME:-YoLink}"

if ! command -v op >/dev/null 2>&1; then
  echo "error: 1Password CLI (op) not found on PATH" >&2
  exit 1
fi

# Sanity: ensure the service-account auth works.
op whoami >/dev/null

YOLINK_UAID="$(op item get "$ITEM_NAME" --vault "$VAULT_NAME" --fields 'label=UAID' | tr -d '\r\n')"
YOLINK_SECRET_KEY="$(op item get "$ITEM_NAME" --vault "$VAULT_NAME" --fields 'label=Secret Key' | tr -d '\r\n')"

if [[ -z "$YOLINK_UAID" || -z "$YOLINK_SECRET_KEY" ]]; then
  echo "error: missing UAID/Secret Key from 1Password item \"$ITEM_NAME\" in vault \"$VAULT_NAME\"" >&2
  exit 1
fi

export YOLINK_UAID
export YOLINK_SECRET_KEY

cd "$(dirname "$0")/.."

# Homey CLI still requires Athom login for app run/install.
exec npx homey app run


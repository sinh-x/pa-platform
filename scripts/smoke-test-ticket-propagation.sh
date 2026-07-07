#!/usr/bin/env bash
# Smoke test: verify --ticket flag propagates through to the opencode agent.
# Launches opencode in background mode and checks the agent confirms the ticket.
set -euo pipefail

RESULT=0
PA_TICKET="${1:-DG-211}"
OBJECTIVE="Smoke test only. Read the deployment-context block in your primer. Confirm it contains ticket_id: ${PA_TICKET}. If yes, write registry completion marker with status success and exit immediately. If not, write failed marker. Do NOT do any other work. Do NOT ask questions. Exit as fast as possible."

echo "=== Smoke test: ticket propagation ==="
echo "Ticket: ${PA_TICKET}"
echo ""

# Launch deployment
echo "[1/3] Launching deployment..."
DEPLOY_ID=$(opa deploy requirements --mode analyze-auto --background --ticket "${PA_TICKET}" --objective "${OBJECTIVE}" 2>&1 | grep -oP 'd-[a-f0-9]{6}')
if [[ -z "${DEPLOY_ID}" ]]; then
  echo "FAILED: could not get deployment ID"
  exit 1
fi
echo "  Deploy: ${DEPLOY_ID}"

# Wait for completion
echo "[2/3] Waiting for completion..."
if ! opa status "${DEPLOY_ID}" --wait 2>/dev/null; then
  echo "FAILED: deployment did not complete successfully"
  RESULT=1
fi

# Verify
echo "[3/3] Verifying result..."
STATUS=$(opa registry show "${DEPLOY_ID}" 2>/dev/null | grep "Status:" | awk '{print $2}')
PRIMER_TICKET=$(grep "ticket_id:" "${HOME}/Documents/ai-usage/deployments/${DEPLOY_ID}/primer.md" 2>/dev/null | awk '{print $2}')

echo "  Status:       ${STATUS}"
echo "  Primer ticket: ${PRIMER_TICKET}"

if [[ "${STATUS}" != "success" ]]; then
  echo "FAILED: deployment status is '${STATUS}', expected 'success'"
  RESULT=1
fi

if [[ "${PRIMER_TICKET}" != "${PA_TICKET}" ]]; then
  echo "FAILED: primer ticket_id is '${PRIMER_TICKET}', expected '${PA_TICKET}'"
  RESULT=1
fi

if [[ ${RESULT} -eq 0 ]]; then
  echo ""
  echo "PASSED: ticket ${PA_TICKET} propagated to deployment ${DEPLOY_ID}"
fi

exit ${RESULT}

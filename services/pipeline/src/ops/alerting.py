"""Deliver an operational alert to the operator's phone.

The pipeline is forbidden from calling an SMS provider itself. CLAUDE.md is
explicit that Python pipeline workers never call Instantly or ClickSend send
APIs directly, and there is already exactly one place in this system that
sends SMS to the operator: `escalate()` in `services/reply-agent`, which pages
`ESCALATION_PHONE` when a reply needs a human.

So this module does not send anything. It hands the message to the reply agent
over `POST /internal/ops-alert`, authenticated with a shared secret in the same
shape as the existing `/internal/preview-view` route, and the reply agent sends
it through the SMS client it already owns. One outbound SMS path, one place to
change the provider, and the service boundary stays where the PRD put it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, cast

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class OpsAlert:
    """One operational message, already written for a phone screen."""

    subject: str
    body: str


class OpsAlertDeliveryError(RuntimeError):
    """Raised when the reply agent did not accept the alert.

    Deliberately loud. A monitor that swallows delivery failures is a monitor
    that reports healthy while nobody is being told anything, which is the
    same class of silent failure the alarm exists to catch.
    """


class ReplyAgentAlertSink:
    """Posts ops alerts to the reply agent, which owns the SMS credentials."""

    def __init__(
        self,
        *,
        base_url: str,
        secret: str,
        source: str = "pipeline-stall-monitor",
        timeout_seconds: float = 15.0,
        http_client_factory: object | None = None,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/internal/ops-alert"
        self._secret = secret
        # Names the monitor that raised this, so `pm2 logs reply-agent` can
        # tell a stall page apart from a bounce page when a delivery fails.
        # There is more than one ops monitor now, and the reply agent only
        # ever logs this field, never the body.
        self._source = source
        self._timeout_seconds = timeout_seconds
        self._http_client_factory = http_client_factory

    async def send_ops_alert(self, alert: OpsAlert) -> None:
        client_factory = self._http_client_factory
        if client_factory is None:
            import httpx

            client_factory = httpx.AsyncClient

        async with cast(Any, client_factory)(timeout=self._timeout_seconds) as http_client:
            response = await http_client.post(
                self._url,
                headers={"x-ops-alert-secret": self._secret},
                json={
                    "source": self._source,
                    "subject": alert.subject,
                    "body": alert.body,
                },
            )

        status_code = int(response.status_code)
        if status_code >= 400:
            # No response body in the message: it is not ours, and this string
            # ends up in logs.
            raise OpsAlertDeliveryError(f"Reply agent rejected the ops alert with {status_code}")


class PrintingAlertSink:
    """Writes the alert to stdout instead of sending it.

    For `--dry-run`, so an operator can read the exact SMS the alarm would
    send without paying for one or waking anybody up. On a Twilio trial
    balance that is not only about noise: every dry run that would otherwise
    have been a real send is a real alert still available later.
    """

    def __init__(self) -> None:
        self.sent: list[OpsAlert] = []

    async def send_ops_alert(self, alert: OpsAlert) -> None:
        self.sent.append(alert)
        print(f"[dry-run] {alert.subject}: {alert.body}")


class LoggingAlertSink:
    """Writes the alert to the monitor's log instead of texting anyone.

    The operator turned alarm texts off on 2026-09-11 with
    OPS_ALERT_SMS_ENABLED=false, keeping texts for replies. Only the ops
    alarms come through this module; reply escalations are sent by
    `escalate()` inside the reply agent and never pass through here, so this
    cannot silence a reply.

    The alert is still written down, at warning level so `pm2 logs` shows it,
    because an alarm nobody can read anywhere is the silent failure this
    project keeps finding. The body is safe to log: alarm bodies carry counts
    and campaign ids, never a lead's name or email.
    """

    def __init__(self, *, source: str) -> None:
        self._source = source

    async def send_ops_alert(self, alert: OpsAlert) -> None:
        logger.warning(
            "Ops alert not texted, alarm SMS is off: source=%s %s: %s",
            self._source,
            alert.subject,
            alert.body,
        )

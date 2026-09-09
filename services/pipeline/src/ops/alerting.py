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

from dataclasses import dataclass
from typing import Any, cast


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
        timeout_seconds: float = 15.0,
        http_client_factory: object | None = None,
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/internal/ops-alert"
        self._secret = secret
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
                    "source": "pipeline-stall-monitor",
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
    send without paying for one or waking anybody up.
    """

    def __init__(self) -> None:
        self.sent: list[OpsAlert] = []

    async def send_ops_alert(self, alert: OpsAlert) -> None:
        self.sent.append(alert)
        print(f"[dry-run] {alert.subject}: {alert.body}")

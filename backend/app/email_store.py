from dataclasses import dataclass
from datetime import datetime
from typing import List
from uuid import uuid4


@dataclass
class Email:
    id: str
    sender: str
    sender_email: str
    subject: str
    body: str
    received_at: str
    unread: bool = True


class EmailStore:
    def __init__(self) -> None:
        self._inbox: List[Email] = [
            Email(
                id="coffee-jane",
                sender="Jane Cooper",
                sender_email="jane@example.com",
                subject="Coffee next week?",
                body=(
                    "Hi Julie,\n\nI'm going to be in town next week and was "
                    "wondering if we could grab a coffee?\n\nBest,\nJane"
                ),
                received_at="2026-08-18T09:15:00",
            ),
            Email(
                id="invoice-ops",
                sender="Avery from Ops",
                sender_email="avery@northstar.example",
                subject="Invoice approval needed",
                body=(
                    "Can you review the July contractor invoice and confirm "
                    "whether we should process it today?"
                ),
                received_at="2026-08-18T11:40:00",
            ),
            Email(
                id="design-review",
                sender="Maya Chen",
                sender_email="maya@studio.example",
                subject="Design review recap",
                body=(
                    "Thanks for the feedback. I updated the onboarding flow "
                    "and would love a second pass before Friday."
                ),
                received_at="2026-08-17T16:05:00",
                unread=False,
            ),
        ]
        self._sent: List[dict] = []

    def list_inbox(self) -> str:
        lines = []
        for email in self._inbox:
            status = "unread" if email.unread else "read"
            lines.append(
                f"[{email.id}] {email.subject} from {email.sender} "
                f"<{email.sender_email}> at {email.received_at} ({status})\n{email.body}"
            )
        return "\n\n".join(lines)

    def send_email(self, to: str, subject: str, body: str) -> str:
        sent = {
            "id": str(uuid4()),
            "to": to,
            "subject": subject,
            "body": body,
            "sent_at": datetime.utcnow().isoformat(),
        }
        self._sent.append(sent)
        return f"Email sent to {to} with subject '{subject}'."

    def snapshot(self) -> dict:
        return {
            "inbox": [email.__dict__ for email in self._inbox],
            "sent": self._sent,
        }


email_store = EmailStore()

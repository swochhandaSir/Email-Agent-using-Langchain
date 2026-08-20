import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any

os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parents[1]
CREDENTIALS_FILE = BASE_DIR / "credentials.json"
TOKEN_FILE = BASE_DIR / "token.json"
STATE_FILE = BASE_DIR / "oauth_state.txt"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


class GmailNotConnectedError(RuntimeError):
    pass


def _redirect_uri() -> str:
    return os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8001/api/gmail/callback")


def _flow(state: str | None = None) -> Flow:
    credentials_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if credentials_json:
        try:
            client_config = json.loads(credentials_json)
        except json.JSONDecodeError as exc:
            raise GmailNotConnectedError("GOOGLE_CREDENTIALS_JSON is not valid JSON.") from exc

        return Flow.from_client_config(
            client_config,
            scopes=SCOPES,
            redirect_uri=_redirect_uri(),
            state=state,
        )

    if not CREDENTIALS_FILE.exists():
        raise GmailNotConnectedError(
            "Missing backend/credentials.json or GOOGLE_CREDENTIALS_JSON. Create an OAuth web client in Google Cloud and provide it."
        )

    flow = Flow.from_client_secrets_file(
        str(CREDENTIALS_FILE),
        scopes=SCOPES,
        redirect_uri=_redirect_uri(),
        state=state,
    )
    return flow


def get_authorization_url() -> str:
    flow = _flow()
    authorization_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    STATE_FILE.write_text(
        json.dumps({"state": state, "code_verifier": flow.code_verifier}),
        encoding="utf-8",
    )
    return authorization_url


def _load_oauth_state() -> dict[str, str | None]:
    if not STATE_FILE.exists():
        return {"state": None, "code_verifier": None}

    raw_state = STATE_FILE.read_text(encoding="utf-8")
    try:
        state_data = json.loads(raw_state)
    except json.JSONDecodeError:
        return {"state": raw_state, "code_verifier": None}

    return {
        "state": state_data.get("state"),
        "code_verifier": state_data.get("code_verifier"),
    }


def save_callback_token(authorization_response: str, state: str | None = None) -> None:
    oauth_state = _load_oauth_state()
    saved_state = oauth_state["state"]
    if saved_state and state != saved_state:
        raise GmailNotConnectedError("OAuth state mismatch. Start Gmail authorization again.")
    if not oauth_state["code_verifier"]:
        raise GmailNotConnectedError("OAuth session is missing its code verifier. Start Gmail authorization again.")

    flow = _flow(state=saved_state or state)
    flow.code_verifier = oauth_state["code_verifier"]
    flow.fetch_token(authorization_response=authorization_response)
    TOKEN_FILE.write_text(flow.credentials.to_json(), encoding="utf-8")
    STATE_FILE.unlink(missing_ok=True)


def load_credentials() -> Credentials:
    if not TOKEN_FILE.exists():
        raise GmailNotConnectedError("Gmail is not connected yet.")

    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")

    if not creds.valid:
        raise GmailNotConnectedError("Gmail token is invalid. Reconnect Gmail.")

    return creds


def gmail_status() -> dict[str, Any]:
    try:
        service = build("gmail", "v1", credentials=load_credentials())
        profile = service.users().getProfile(userId="me").execute()
        return {
            "connected": True,
            "email": profile.get("emailAddress"),
            "messages_total": profile.get("messagesTotal"),
        }
    except Exception as exc:
        return {"connected": False, "reason": str(exc)}


def disconnect_gmail() -> None:
    TOKEN_FILE.unlink(missing_ok=True)
    STATE_FILE.unlink(missing_ok=True)


def _service():
    return build("gmail", "v1", credentials=load_credentials())


def _parallel_map(items: list[Any], worker, max_workers: int = 8) -> list[Any]:
    if not items:
        return []

    with ThreadPoolExecutor(max_workers=min(max_workers, len(items))) as executor:
        return list(executor.map(worker, items))


def _metadata_message(service: Any, message_id: str) -> dict[str, Any]:
    return (
        service.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["From", "To", "Subject", "Date"],
        )
        .execute()
    )


def _header(payload: dict[str, Any], name: str) -> str:
    for header in payload.get("headers", []):
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def _decode_body(data: str) -> str:
    return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="replace")


def _body_from_payload(payload: dict[str, Any]) -> str:
    body_data = payload.get("body", {}).get("data")
    if body_data:
        return _decode_body(body_data)

    for part in payload.get("parts", []):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return _decode_body(part["body"]["data"])

    for part in payload.get("parts", []):
        nested = _body_from_payload(part)
        if nested:
            return nested

    return ""


def _message_local_date(message: dict[str, Any]) -> str | None:
    internal_date = message.get("internalDate")
    if not internal_date:
        return None

    return datetime.fromtimestamp(int(internal_date) / 1000).date().isoformat()


def _message_summary(message: dict[str, Any]) -> dict[str, Any]:
    payload = message.get("payload", {})
    sender = _header(payload, "From")
    label_ids = message.get("labelIds", [])
    return {
        "id": message.get("id"),
        "thread_id": message.get("threadId"),
        "sender": sender or _header(payload, "To"),
        "sender_email": sender,
        "to": _header(payload, "To"),
        "subject": _header(payload, "Subject") or "(No subject)",
        "body": message.get("snippet", ""),
        "snippet": message.get("snippet", ""),
        "received_at": _header(payload, "Date"),
        "local_date": _message_local_date(message),
        "unread": "UNREAD" in label_ids,
    }


def _recent_query(days: int = 14) -> str:
    return f"newer_than:{days}d"


def _is_today(message: dict[str, Any]) -> bool:
    return _message_local_date(message) == datetime.now().date().isoformat()


def list_mailbox(max_results: int = 20, day_query: str | None = None) -> dict[str, Any]:
    query = day_query or _recent_query()

    def list_messages(label: str) -> list[dict[str, Any]]:
        service = _service()
        response = (
            service.users()
            .messages()
            .list(userId="me", labelIds=[label], q=query, maxResults=max_results)
            .execute()
        )
        message_refs = response.get("messages", [])

        def fetch_summary(item: dict[str, Any]) -> dict[str, Any] | None:
            message = _metadata_message(_service(), item["id"])
            return _message_summary(message)

        summaries = _parallel_map(message_refs, fetch_summary)
        return [summary for summary in summaries if summary is not None][:max_results]

    with ThreadPoolExecutor(max_workers=2) as executor:
        inbox_future = executor.submit(list_messages, "INBOX")
        sent_future = executor.submit(list_messages, "SENT")

    return {
        "inbox": inbox_future.result(),
        "sent": sent_future.result(),
        "date": "recent mail",
        "query": query,
    }


def search_messages(query: str = "in:inbox newer_than:14d", max_results: int = 10) -> str:
    service = _service()
    response = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=min(max_results, 20))
        .execute()
    )
    messages = response.get("messages", [])
    if not messages:
        return "No Gmail messages matched that search."

    def fetch_result(item: dict[str, Any]) -> dict[str, Any]:
        message = _metadata_message(_service(), item["id"])
        payload = message.get("payload", {})
        return {
            "id": message.get("id"),
            "thread_id": message.get("threadId"),
            "from": _header(payload, "From"),
            "subject": _header(payload, "Subject"),
            "date": _header(payload, "Date"),
            "snippet": message.get("snippet", ""),
        }

    results = _parallel_map(messages, fetch_result)
    return str(results)


def read_message(message_id: str) -> str:
    return str(get_message(message_id))


def get_message(message_id: str) -> dict[str, Any]:
    service = _service()
    message = service.users().messages().get(userId="me", id=message_id, format="full").execute()
    payload = message.get("payload", {})
    return {
        "id": message.get("id"),
        "thread_id": message.get("threadId"),
        "from": _header(payload, "From"),
        "to": _header(payload, "To"),
        "subject": _header(payload, "Subject") or "(No subject)",
        "date": _header(payload, "Date"),
        "body": _body_from_payload(payload),
        "snippet": message.get("snippet", ""),
        "unread": "UNREAD" in message.get("labelIds", []),
    }


def send_message(to: str, subject: str, body: str) -> str:
    service = _service()
    email = EmailMessage()
    email["To"] = to
    email["Subject"] = subject
    email.set_content(body)
    encoded = base64.urlsafe_b64encode(email.as_bytes()).decode("utf-8")
    sent = service.users().messages().send(userId="me", body={"raw": encoded}).execute()
    return f"Sent Gmail message {sent.get('id')} to {to}."

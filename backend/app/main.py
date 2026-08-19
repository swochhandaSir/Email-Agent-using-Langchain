import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .agent import run_email_agent
from .gmail_service import (
    GmailNotConnectedError,
    disconnect_gmail,
    get_authorization_url,
    get_message,
    gmail_status,
    list_mailbox,
    save_callback_token,
    send_message,
)

load_dotenv()


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    history: list[ChatMessage] = []


class ChatResponse(BaseModel):
    reply: str
    mailbox: dict
    pending_email: dict | None = None


class ApprovedEmailRequest(BaseModel):
    to: str = Field(min_length=1)
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)


app = FastAPI(title="PulseMail Email Assistant API")

origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/mailbox")
def mailbox() -> dict:
    try:
        return list_mailbox()
    except GmailNotConnectedError as exc:
        return {"inbox": [], "sent": [], "connected": False, "reason": str(exc)}


@app.get("/api/mailbox/messages/{message_id}")
def mailbox_message(message_id: str) -> dict:
    try:
        return get_message(message_id)
    except GmailNotConnectedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not load Gmail message: {exc}") from exc


@app.get("/api/gmail/status")
def gmail_connection_status() -> dict:
    return gmail_status()


@app.get("/api/gmail/authorize")
def gmail_authorize() -> dict:
    try:
        return {"authorization_url": get_authorization_url()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/gmail/logout")
def gmail_logout() -> dict:
    disconnect_gmail()
    return {"connected": False}


@app.get("/api/gmail/callback", response_class=HTMLResponse)
def gmail_callback(request: Request) -> str:
    try:
        save_callback_token(str(request.url), request.query_params.get("state"))
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        return f"""
        <html>
          <body style="font-family: system-ui; padding: 32px;">
            <h1>Gmail connection failed</h1>
            <p>{message}</p>
          </body>
        </html>
        """

    return """
    <html>
      <body style="font-family: system-ui; padding: 32px;">
        <h1>Gmail connected</h1>
        <p>You can close this tab and return to PulseMail.</p>
      </body>
    </html>
    """


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key or groq_api_key == "your_groq_api_key_here":
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY is not set. Add it to backend/.env or your environment.",
        )

    try:
        agent_result = run_email_agent(
            request.message,
            [message.model_dump() for message in request.history],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}") from exc

    try:
        mailbox_snapshot = list_mailbox()
    except GmailNotConnectedError:
        mailbox_snapshot = {"inbox": [], "sent": []}

    return ChatResponse(
        reply=agent_result["reply"],
        mailbox=mailbox_snapshot,
        pending_email=agent_result.get("pending_email"),
    )


@app.post("/api/mailbox/send-approved", response_model=ChatResponse)
def send_approved_email(request: ApprovedEmailRequest) -> ChatResponse:
    try:
        reply = send_message(to=request.to, subject=request.subject, body=request.body)
        mailbox_snapshot = list_mailbox()
    except GmailNotConnectedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not send Gmail message: {exc}") from exc

    return ChatResponse(reply=reply, mailbox=mailbox_snapshot, pending_email=None)

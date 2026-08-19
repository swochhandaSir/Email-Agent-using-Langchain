import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .agent import run_email_agent
from .email_store import email_store

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
    return email_store.snapshot()


@app.post("/api/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key or groq_api_key == "your_groq_api_key_here":
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY is not set. Add it to backend/.env or your environment.",
        )

    try:
        reply = run_email_agent(
            request.message,
            [message.model_dump() for message in request.history],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}") from exc

    return ChatResponse(reply=reply, mailbox=email_store.snapshot())

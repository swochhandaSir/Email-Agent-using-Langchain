import os

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_groq import ChatGroq

from .email_store import email_store

load_dotenv()


@tool
def check_inbox() -> str:
    """Check the user's current inbox and return recent emails."""
    return email_store.list_inbox()


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email after the assistant has drafted a clear response."""
    return email_store.send_email(to=to, subject=subject, body=body)


SYSTEM_PROMPT = """You are PulseMail, a polished email assistant.

You help the user triage messages, summarize inbox state, draft replies, and send email.
Be concise, practical, and explicit about any assumptions. If the user asks to send an
email and the recipient or content is ambiguous, ask one focused follow-up question.
"""


TOOLS = [check_inbox, send_email]
TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


def get_model():
    return ChatGroq(
        model=os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
        temperature=0.2,
        max_retries=2,
    ).bind_tools(TOOLS)


def run_email_agent(message: str, history: list[dict] | None = None) -> str:
    messages: list[BaseMessage] = [SystemMessage(content=SYSTEM_PROMPT)]
    for item in history or []:
        role = item.get("role")
        content = item.get("content", "")
        if role == "assistant":
            messages.append(AIMessage(content=content))
        elif role == "user":
            messages.append(HumanMessage(content=content))

    messages.append(HumanMessage(content=message))
    model = get_model()

    for _ in range(4):
        response = model.invoke(messages)
        messages.append(response)
        tool_calls = getattr(response, "tool_calls", None) or []
        if not tool_calls:
            final = response
            break

        for call in tool_calls:
            selected_tool = TOOLS_BY_NAME[call["name"]]
            result = selected_tool.invoke(call["args"])
            messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))
    else:
        final = AIMessage(content="I could not finish the email workflow. Please try again.")

    return final.content if isinstance(final.content, str) else str(final.content)

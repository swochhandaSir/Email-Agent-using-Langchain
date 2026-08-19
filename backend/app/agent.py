import os
from contextvars import ContextVar
from typing import Annotated, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_groq import ChatGroq
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from .gmail_service import read_message, search_messages

load_dotenv()

pending_email_preview: ContextVar[dict | None] = ContextVar("pending_email_preview", default=None)


class EmailAgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


@tool
def search_email(query: str = "in:inbox newer_than:14d", max_results: int = 10) -> str:
    """Search the connected Gmail account. Use Gmail search syntax in the query."""
    return search_messages(query=query, max_results=max_results)


@tool
def read_email(message_id: str) -> str:
    """Read one Gmail message by id. Use this after search_email returns a message id."""
    return read_message(message_id=message_id)


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Prepare an email draft for user approval. This tool never sends the email."""
    pending_email_preview.set({"to": to, "subject": subject, "body": body})
    return "Email draft prepared. Do not say it was sent. Tell the user to review and approve the preview before sending."


SYSTEM_PROMPT = """You are PulseMail, a polished email assistant.

You help the user triage Gmail, summarize inbox state, draft replies, and prepare email drafts.
Be concise, practical, and explicit about any assumptions. If the user asks to send an
email and the recipient or content is ambiguous, ask one focused follow-up question.
You must never say an email was sent after using send_email. The app will show a required
editable preview and the user must approve it before the backend sends the email.
Never ask the user for Gmail passwords or OAuth tokens. Never invent message ids.
"""


TOOLS = [search_email, read_email, send_email]


def get_model():
    return ChatGroq(
        model=os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
        temperature=0.2,
        max_retries=2,
    ).bind_tools(TOOLS)


def call_model(state: EmailAgentState) -> dict:
    response = get_model().invoke(state["messages"])
    return {"messages": [response]}


def should_continue(state: EmailAgentState) -> str:
    last_message = state["messages"][-1]
    if getattr(last_message, "tool_calls", None):
        return "tools"
    return END


def build_graph():
    graph = StateGraph(EmailAgentState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", ToolNode(TOOLS))
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile()


email_graph = build_graph()


def run_email_agent(message: str, history: list[dict] | None = None) -> dict:
    pending_email_preview.set(None)
    messages: list[BaseMessage] = [SystemMessage(content=SYSTEM_PROMPT)]
    for item in history or []:
        role = item.get("role")
        content = item.get("content", "")
        if role == "assistant":
            messages.append(AIMessage(content=content))
        elif role == "user":
            messages.append(HumanMessage(content=content))

    messages.append(HumanMessage(content=message))
    result = email_graph.invoke({"messages": messages}, {"recursion_limit": 8})
    final = result["messages"][-1]
    if not isinstance(final, AIMessage):
        final = AIMessage(content="I could not finish the email workflow. Please try again.")
    return {
        "reply": final.content if isinstance(final.content, str) else str(final.content),
        "pending_email": pending_email_preview.get(),
    }

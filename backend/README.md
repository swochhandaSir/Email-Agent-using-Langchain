# PulseMail Backend

FastAPI service for the React email assistant. It exposes:

- `GET /health`
- `GET /api/mailbox`
- `POST /api/chat`

Default Groq model: `openai/gpt-oss-20b`.

## Setup

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Set `GROQ_API_KEY` in `.env`, then run:

```powershell
uvicorn app.main:app --reload --port 8001
```

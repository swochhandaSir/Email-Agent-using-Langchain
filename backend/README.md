# PulseMail Backend

FastAPI service for the React email assistant. It exposes:

- `GET /health`
- `GET /api/mailbox`
- `POST /api/chat`

Default Groq model: `openai/gpt-oss-20b`.

## Gmail OAuth

The LLM never receives Gmail credentials or a Gmail API client. It can only call
backend tools:

- `search_email`
- `read_email`
- `send_email`

Those tools call Gmail API from FastAPI using your OAuth token.

### Google Cloud Setup

1. Open Google Cloud Console.
2. Create or select a project.
3. Enable the Gmail API.
4. Configure the OAuth consent screen.
5. Create an OAuth 2.0 Client ID with application type `Web application`.
6. Add this authorized redirect URI:

```text
http://localhost:8001/api/gmail/callback
```

7. Download the client JSON and save it here:

```text
backend/credentials.json
```

8. Make sure `.env` contains:

```env
GOOGLE_REDIRECT_URI=http://localhost:8001/api/gmail/callback
```

9. Start the backend and frontend, then click `Authorize` in the app.

The backend stores the OAuth token in `backend/token.json`, which is ignored by git.

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

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  Mail,
  PenLine,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8001';

const starterPrompts = [
  'Summarize my unread email and suggest what needs action.',
  'Draft a warm reply to Jane saying coffee next Thursday works.',
  'What should I handle first from the inbox?',
];

function App() {
  const [mailbox, setMailbox] = useState({ inbox: [], sent: [] });
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'I can triage your inbox, draft replies, and send messages when you ask me to.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const unreadCount = useMemo(
    () => mailbox.inbox.filter((email) => email.unread).length,
    [mailbox.inbox],
  );

  useEffect(() => {
    refreshMailbox();
  }, []);

  async function refreshMailbox() {
    try {
      const response = await fetch(`${API_URL}/api/mailbox`);
      if (!response.ok) throw new Error('Mailbox unavailable');
      setMailbox(await response.json());
    } catch (err) {
      setError(err.message);
    }
  }

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const nextMessages = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: messages.filter((message) => message.role !== 'system'),
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || 'Assistant request failed');
      }

      const payload = await response.json();
      setMessages([...nextMessages, { role: 'assistant', content: payload.reply }]);
      setMailbox(payload.mailbox);
    } catch (err) {
      setError(err.message);
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: 'I could not reach the backend. Check the API server and Groq key.',
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    sendMessage();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={22} />
          </div>
          <div>
            <h1>PulseMail</h1>
            <span>AI email desk</span>
          </div>
        </div>

        <section className="metric-grid">
          <div className="metric">
            <Mail size={18} />
            <strong>{mailbox.inbox.length}</strong>
            <span>Inbox</span>
          </div>
          <div className="metric accent">
            <Clock3 size={18} />
            <strong>{unreadCount}</strong>
            <span>Unread</span>
          </div>
          <div className="metric">
            <Send size={18} />
            <strong>{mailbox.sent.length}</strong>
            <span>Sent</span>
          </div>
        </section>

        <section className="mail-list">
          <div className="section-title">
            <h2>Priority Inbox</h2>
            <button onClick={refreshMailbox} aria-label="Refresh mailbox">
              <RefreshCw size={16} />
            </button>
          </div>
          {mailbox.inbox.map((email) => (
            <article className={email.unread ? 'mail unread' : 'mail'} key={email.id}>
              <div>
                <strong>{email.sender}</strong>
                <span>{email.subject}</span>
              </div>
              {email.unread ? <b>New</b> : <CheckCircle2 size={15} />}
            </article>
          ))}
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">LangChain + Groq</span>
            <h2>Command center for your email flow</h2>
          </div>
          <div className="status-pill">
            <span />
            API connected
          </div>
        </header>

        <section className="composer-layout">
          <div className="conversation">
            {messages.map((message, index) => (
              <div className={`bubble ${message.role}`} key={`${message.role}-${index}`}>
                <div className="bubble-icon">
                  {message.role === 'assistant' ? <Bot size={17} /> : <PenLine size={17} />}
                </div>
                <p>{message.content}</p>
              </div>
            ))}
            {loading && (
              <div className="bubble assistant">
                <div className="bubble-icon">
                  <Bot size={17} />
                </div>
                <p>Thinking through your mailbox...</p>
              </div>
            )}
          </div>

          <div className="action-panel">
            <div className="quick-prompts">
              {starterPrompts.map((prompt) => (
                <button key={prompt} onClick={() => sendMessage(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>

            <form className="composer" onSubmit={submit}>
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask PulseMail to summarize, draft, prioritize, or send..."
              />
              <button disabled={loading || !input.trim()} type="submit">
                <Send size={18} />
                Send
              </button>
            </form>
            {error && <p className="error">{error}</p>}
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

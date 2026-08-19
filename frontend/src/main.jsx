import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  History,
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
  'What should I handle first from the inbox?',
];

function summarizeTask(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
}

function formatInline(text) {
  return text.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^["']|["']$/g, '').trim();
}

function parseTableLine(line) {
  if (!line.includes('|')) return null;
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(formatInline);
}

function isTableDivider(line) {
  return /^[\s|:-]+$/.test(line) && line.includes('-');
}

function TableCards({ headers, rows }) {
  const usefulHeaders = headers.map((header) => header.replace(/^#$/, 'No.'));

  return (
    <div className="message-table-cards">
      {rows.map((row, rowIndex) => (
        <article className="message-table-card" key={`${row.join('-')}-${rowIndex}`}>
          {row.map((cell, cellIndex) => {
            if (!cell) return null;
            const label = usefulHeaders[cellIndex] || `Detail ${cellIndex + 1}`;
            return (
              <div className="table-card-row" key={`${label}-${cellIndex}`}>
                <span>{label}</span>
                <strong>{cell}</strong>
              </div>
            );
          })}
        </article>
      ))}
    </div>
  );
}

function MessageContent({ message }) {
  if (message.role === 'user') {
    return <p className="message-text">{message.content}</p>;
  }

  const lines = message.content.split('\n');
  const blocks = [];
  let listItems = [];
  let listType = null;
  let tableHeaders = null;
  let tableRows = [];

  function flushList() {
    if (listItems.length === 0) return;
    const ListTag = listType === 'numbered' ? 'ol' : 'ul';
    blocks.push(
      <ListTag className="message-list" key={`list-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li key={`${item}-${index}`}>{formatInline(item)}</li>
        ))}
      </ListTag>,
    );
    listItems = [];
    listType = null;
  }

  function flushTable() {
    if (!tableHeaders || tableRows.length === 0) {
      tableHeaders = null;
      tableRows = [];
      return;
    }

    blocks.push(
      <TableCards
        headers={tableHeaders}
        rows={tableRows}
        key={`table-${blocks.length}`}
      />,
    );
    tableHeaders = null;
    tableRows = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      flushTable();
      return;
    }

    const tableCells = parseTableLine(trimmed);
    if (tableCells && tableCells.length >= 2) {
      flushList();
      if (isTableDivider(trimmed)) return;
      if (!tableHeaders) {
        tableHeaders = tableCells;
      } else {
        tableRows.push(tableCells);
      }
      return;
    }

    flushTable();

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);

    if (bulletMatch || numberedMatch) {
      const nextType = numberedMatch ? 'numbered' : 'bullet';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(bulletMatch?.[1] ?? numberedMatch[1]);
      return;
    }

    flushList();

    const labelMatch = trimmed.match(/^([A-Z][A-Za-z ]{1,24}):\s+(.+)$/);
    if (labelMatch) {
      blocks.push(
        <p className="message-line" key={`line-${index}`}>
          <strong>{labelMatch[1]}:</strong> {formatInline(labelMatch[2])}
        </p>,
      );
      return;
    }

    if (trimmed.endsWith(':') || trimmed.startsWith('##')) {
      blocks.push(
        <h3 className="message-heading" key={`heading-${index}`}>
          {formatInline(trimmed.replace(/:$/, ''))}
        </h3>,
      );
      return;
    }

    blocks.push(
      <p className="message-line" key={`line-${index}`}>
        {formatInline(trimmed)}
      </p>,
    );
  });

  flushList();
  flushTable();

  return <div className="message-content">{blocks}</div>;
}

function App() {
  const [activeView, setActiveView] = useState('mails');
  const [mailbox, setMailbox] = useState({ inbox: [], sent: [] });
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'I can triage your inbox, draft replies, and send messages when you ask me to.',
    },
  ]);
  const [input, setInput] = useState('');
  const [gmail, setGmail] = useState({ connected: false });
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const unreadCount = useMemo(
    () => mailbox.inbox.filter((email) => email.unread).length,
    [mailbox.inbox],
  );

  const chatHistory = useMemo(() => {
    const taskItems = messages
      .filter((message) => message.role === 'user')
      .slice(-5)
      .reverse()
      .map((message, index) => ({
        id: `${index}-${message.content}`,
        title: summarizeTask(message.content),
        meta: 'Requested',
      }));

    if (taskItems.length > 0) 
      return taskItems;

    return [
      {
        id: 'sent-example',
        title: 'No Tasks Yet',
        meta: 'give me a prompt to get started',
      },
    ];
  }, [messages]);

  useEffect(() => {
    refreshMailbox();
    refreshGmailStatus();
  }, []);

  async function refreshGmailStatus() {
    try {
      const response = await fetch(`${API_URL}/api/gmail/status`);
      if (!response.ok) throw new Error('Gmail status unavailable');
      setGmail(await response.json());
    } catch (err) {
      setGmail({ connected: false, reason: err.message });
    }
  }

  async function connectGmail() {
    try {
      setError('');
      const response = await fetch(`${API_URL}/api/gmail/authorize`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'Could not start Gmail OAuth');
      window.open(payload.authorization_url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    }
  }

  async function logoutGmail() {
    try {
      setError('');
      const response = await fetch(`${API_URL}/api/gmail/logout`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not log out');
      setGmail({ connected: false });
      setMailbox({ inbox: [], sent: [] });
      setSelectedEmail(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshMailbox() {
    try {
      const response = await fetch(`${API_URL}/api/mailbox`);
      if (!response.ok) throw new Error('Mailbox unavailable');
      const payload = await response.json();
      setMailbox(payload);
      if (selectedEmail && !payload.inbox.some((email) => email.id === selectedEmail.id)) {
        setSelectedEmail(null);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function openEmail(email) {
    setSelectedEmail({ ...email, body: email.snippet || email.body || '' });
    setEmailLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/mailbox/messages/${email.id}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || 'Could not load email');
      setSelectedEmail(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setEmailLoading(false);
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
      if (payload.pending_email) {
        setPendingEmail(payload.pending_email);
      }
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

  async function sendApprovedEmail() {
    if (!pendingEmail || loading) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/api/mailbox/send-approved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingEmail),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || 'Could not send email');

      setPendingEmail(null);
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: payload.reply || `Sent email to ${pendingEmail.to}.` },
      ]);
      setMailbox(payload.mailbox);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function cancelPendingEmail() {
    const recipient = pendingEmail?.to;
    setPendingEmail(null);
    setMessages((current) => [
      ...current,
      {
        role: 'assistant',
        content: recipient
          ? `I did not send the email to ${recipient}.`
          : 'I did not send the email.',
      },
    ]);
  }

  function submit(event) {
    event.preventDefault();
    sendMessage();
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="app-topbar">
          <div className="brand">
            <div className="brand-mark">
              <Sparkles size={22} />
            </div>
            <div>
              <h1>Mail Assistant</h1>
              <span>{gmail.connected ? gmail.email : 'AI email desk'}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="view-tabs" role="tablist" aria-label="Workspace views">
              <button
                className={activeView === 'mails' ? 'active' : ''}
                onClick={() => setActiveView('mails')}
                type="button"
              >
                <Mail size={17} />
                Mails
              </button>
              <button
                className={activeView === 'chat' ? 'active' : ''}
                onClick={() => setActiveView('chat')}
                type="button"
              >
                <Bot size={17} />
                AI Chat
              </button>
            </div>
            <button
              className={gmail.connected ? 'auth-button logout' : 'auth-button'}
              onClick={gmail.connected ? logoutGmail : connectGmail}
              type="button"
            >
              {gmail.connected ? 'Logout' : 'Login'}
            </button>
          </div>
        </header>

        {/* <section className="metric-grid">
          <div className="metric">
            <Mail size={18} />
            <strong>{mailbox.inbox.length}</strong>
            <span>Inbox today</span>
          </div>
          <div className="metric accent">
            <Clock3 size={18} />
            <strong>{unreadCount}</strong>
            <span>Unread</span>
          </div>
          <div className="metric">
            <Send size={18} />
            <strong>{mailbox.sent.length}</strong>
            <span>Sent today</span>
          </div>
        </section> */}

        {activeView === 'mails' ? (
          <section className="mail-workspace">
            <div className="mail-list main-list">
              <div className="section-title">
                <h2>Today&apos;s Inbox</h2>
                <button onClick={refreshMailbox} aria-label="Refresh mailbox">
                  <RefreshCw size={16} />
                </button>
              </div>
              {mailbox.date && <p className="mail-date">Showing {mailbox.date}</p>}
              {mailbox.inbox.map((email) => (
                <button
                  className={`mail ${email.unread ? 'unread' : ''} ${
                    selectedEmail?.id === email.id ? 'selected' : ''
                  }`}
                  key={email.id}
                  onClick={() => openEmail(email)}
                  type="button"
                >
                  <div>
                    <strong>{email.sender}</strong>
                    <span>{email.subject}</span>
                  </div>
                  {email.unread ? <b>New</b> : <CheckCircle2 size={15} />}
                </button>
              ))}
              {mailbox.inbox.length === 0 && (
                <p className="empty-state">
                  {gmail.connected ? 'No mails for today.' : "Login to load today's mails."}
                </p>
              )}
            </div>

            <div className="reader-shell">
              {selectedEmail ? (
                <article className="email-reader">
                  <div className="email-reader-header">
                    <div>
                      <span className="eyebrow">Selected Email</span>
                      <h3>{selectedEmail.subject}</h3>
                    </div>
                    <Archive size={18} />
                  </div>
                  <dl>
                    <div>
                      <dt>From</dt>
                      <dd>{selectedEmail.from || selectedEmail.sender}</dd>
                    </div>
                    <div>
                      <dt>To</dt>
                      <dd>{selectedEmail.to || 'Me'}</dd>
                    </div>
                    <div>
                      <dt>Date</dt>
                      <dd>{selectedEmail.date || selectedEmail.received_at}</dd>
                    </div>
                  </dl>
                  <p className="email-body">
                    {emailLoading ? 'Loading full email...' : selectedEmail.body || selectedEmail.snippet}
                  </p>
                </article>
              ) : (
                <div className="empty-reader">
                  <Mail size={22} />
                  <p>Select a mail to read it.</p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="chat-workspace">
            <aside className="chat-history" aria-label="Recent AI tasks">
              <div className="section-title">
                <h2>Recent Tasks</h2>
                <History size={17} />
              </div>
              <div className="history-list">
                {chatHistory.map((item) => (
                  <div className="history-item" key={item.id}>
                    <div className="history-icon">
                      <CheckCircle2 size={16} />
                    </div>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.meta}</span>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            <div className="chat-panel">
              <div className="conversation">
                {messages.map((message, index) => (
                  <div className={`bubble ${message.role}`} key={`${message.role}-${index}`}>
                    <div className="bubble-icon">
                      {message.role === 'assistant' ? <Bot size={17} /> : <PenLine size={17} />}
                    </div>
                    <MessageContent message={message} />
                  </div>
                ))}
                {loading && (
                  <div className="bubble assistant">
                    <div className="bubble-icon">
                      <Bot size={17} />
                    </div>
                    <div className="message-content">
                      <p className="message-line">Thinking through your mailbox...</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="chat-bottom">
                {pendingEmail && (
                  <section className="email-preview" aria-label="Email approval preview">
                    <div className="email-preview-header">
                      <div>
                        <span className="eyebrow">Review Before Sending</span>
                        <h3>Email Preview</h3>
                      </div>
                      <Mail size={18} />
                    </div>

                    <label>
                      To
                      <input
                        value={pendingEmail.to}
                        onChange={(event) =>
                          setPendingEmail({ ...pendingEmail, to: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Subject
                      <input
                        value={pendingEmail.subject}
                        onChange={(event) =>
                          setPendingEmail({ ...pendingEmail, subject: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Message
                      <textarea
                        value={pendingEmail.body}
                        onChange={(event) =>
                          setPendingEmail({ ...pendingEmail, body: event.target.value })
                        }
                      />
                    </label>

                    <div className="email-preview-actions">
                      <button
                        className="send-approval"
                        disabled={loading || !pendingEmail.to.trim() || !pendingEmail.body.trim()}
                        onClick={sendApprovedEmail}
                        type="button"
                      >
                        Approve
                      </button>
                      <button
                        className="cancel-approval"
                        disabled={loading}
                        onClick={cancelPendingEmail}
                        type="button"
                      >
                        Reject
                      </button>
                    </div>
                  </section>
                )}

                <div className="quick-prompts" aria-label="Suggested prompts">
                  {starterPrompts.map((prompt) => (
                    <button key={prompt} onClick={() => sendMessage(prompt)} type="button">
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
                  <button disabled={loading || !input.trim()} type="submit" aria-label="Send message">
                    <Send size={18} />
                  </button>
                </form>
              </div>
            </div>
          </section>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

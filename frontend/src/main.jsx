import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  Edit3,
  Forward,
  History,
  Inbox,
  Mail,
  MoreVertical,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8001';

const starterPrompts = [
  '📊 Summarize my unread emails',
  '🔥 What needs my attention?',
  "✉️ Draft a reply to John's email",
  "📅 Find emails about tomorrow's meeting",
  '🧹 Clean up my inbox',
  '⭐ Show my important emails',
];

const folders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: Edit3 },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'trash', label: 'Trash', icon: Trash2 },
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
  const [activeFolder, setActiveFolder] = useState('inbox');
  const [mailbox, setMailbox] = useState({ inbox: [], sent: [] });
  const [messages, setMessages] = useState([]);
  const [streamingReply, setStreamingReply] = useState('');
  const [input, setInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [gmail, setGmail] = useState({ connected: false });
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [authChecking, setAuthChecking] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const pendingBodyRef = useRef(null);
  const toastTimerRef = useRef(null);

  const unreadCount = useMemo(
    () => mailbox.inbox.filter((email) => email.unread).length,
    [mailbox.inbox],
  );

  const folderCounts = useMemo(
    () => ({
      inbox: mailbox.inbox.length,
      sent: mailbox.sent.length,
      drafts: pendingEmail ? 1 : 0,
      starred: mailbox.inbox.filter((email) => isImportant(email)).length,
      trash: 0,
    }),
    [mailbox, pendingEmail],
  );

  const visibleEmails = useMemo(() => {
    const source = activeFolder === 'sent' ? mailbox.sent : mailbox.inbox;
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const filtered =
      activeFolder === 'starred'
        ? source.filter((email) => isImportant(email))
        : activeFolder === 'drafts' || activeFolder === 'trash'
          ? []
          : source;

    if (!normalizedQuery) return filtered;
    return filtered.filter((email) =>
      [email.sender, email.from, email.to, email.subject, email.body, email.snippet]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [activeFolder, mailbox, searchQuery]);

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

  useEffect(() => {
    async function refreshAfterAuthReturn() {
      const status = await refreshGmailStatus();
      if (status.connected) refreshMailbox();
    }

    window.addEventListener('focus', refreshAfterAuthReturn);
    document.addEventListener('visibilitychange', refreshAfterAuthReturn);

    return () => {
      window.removeEventListener('focus', refreshAfterAuthReturn);
      document.removeEventListener('visibilitychange', refreshAfterAuthReturn);
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  function showToast(message, tone = 'success') {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }

  async function refreshGmailStatus() {
    try {
      const response = await fetch(`${API_URL}/api/gmail/status`);
      if (!response.ok) throw new Error('Gmail status unavailable');
      const status = await response.json();
      setGmail(status);
      return status;
    } catch (err) {
      const status = { connected: false, reason: err.message };
      setGmail(status);
      return status;
    }
  }

  async function connectGmail() {
    try {
      setError('');
      setAuthChecking(true);
      const response = await fetch(`${API_URL}/api/gmail/authorize`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'Could not start Gmail OAuth');
      const authWindow = window.open(payload.authorization_url, '_blank', 'noopener,noreferrer');
      showToast('Complete Gmail login in the opened tab.', 'info');

      let attempts = 0;
      const pollForLogin = window.setInterval(async () => {
        attempts += 1;
        const status = await refreshGmailStatus();
        if (status.connected) {
          window.clearInterval(pollForLogin);
          setAuthChecking(false);
          await refreshMailbox();
          showToast('Gmail connected successfully.', 'success');
        } else if (attempts >= 45 || authWindow?.closed) {
          window.clearInterval(pollForLogin);
          setAuthChecking(false);
        }
      }, 2000);
    } catch (err) {
      setAuthChecking(false);
      setError(err.message);
      showToast(err.message, 'error');
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
      showToast('Logged out successfully.', 'success');
    } catch (err) {
      setError(err.message);
      showToast(err.message, 'error');
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
    setSendingEmail(true);
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
      streamAssistantReply(payload.reply, nextMessages);
      setMailbox(payload.mailbox);
      if (payload.pending_email) {
        setPendingEmail(payload.pending_email);
      }
    } catch (err) {
      setError(err.message);
      streamAssistantReply(
        'I could not reach the backend. Check the API server and Groq key.',
        nextMessages,
      );
    }
  }

  function streamAssistantReply(reply, baseMessages) {
    setStreamingReply('');
    let index = 0;
    const timer = window.setInterval(() => {
      index += 8;
      setStreamingReply(reply.slice(0, index));
      if (index >= reply.length) {
        window.clearInterval(timer);
        setStreamingReply('');
        setMessages([...baseMessages, { role: 'assistant', content: reply }]);
        setLoading(false);
      }
    }, 18);
  }

  function runAiSearch(event) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setActiveView('chat');
    sendMessage(`Find ${query} in my mailbox and explain the matching emails.`);
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
      showToast('Email sent successfully.', 'success');
    } catch (err) {
      setError(err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
      setSendingEmail(false);
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

  function isImportant(email) {
    const content = `${email.subject || ''} ${email.body || ''}`.toLowerCase();
    return /urgent|approval|needed|meeting|review|important|tomorrow/.test(content);
  }

  function hasAttachment(email) {
    return /invoice|attachment|attached|contract|pdf|doc/.test(
      `${email.subject || ''} ${email.body || ''}`.toLowerCase(),
    );
  }

  function formatEmailTime(email) {
    const raw = email.received_at || email.sent_at || email.date;
    if (!raw) return 'Now';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function senderInitial(email) {
    return (email.sender || email.to || email.from || '?').trim().charAt(0).toUpperCase();
  }

  function askForDraft(email = selectedEmail) {
    if (!email) return;
    setActiveView('chat');
    sendMessage(`Draft a concise reply to ${email.sender || email.from} about "${email.subject}".`);
  }

  function emailAiSummary(email) {
    const subject = email.subject || 'this email';
    const body = email.body || email.snippet || '';
    const actionRequired = isImportant(email);
    return {
      summary: body
        ? `${email.sender || email.from || 'The sender'} is asking about ${subject.toLowerCase()}.`
        : `${subject} is ready for AI review once the full message loads.`,
      action: actionRequired ? 'Yes - respond before tomorrow' : 'No immediate response detected',
      response: actionRequired ? 'That works for me. Thanks!' : 'Thanks for the update.',
    };
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
                Inbox
              </button>
              <button
                className={activeView === 'chat' ? 'active' : ''}
                onClick={() => setActiveView('chat')}
                type="button"
              >
                <Bot size={17} />
                AI Assistant
              </button>
            </div>
            <button className="top-search" onClick={() => setActiveView('mails')} type="button">
              <Search size={18} />
            </button>
            {gmail.connected ? (
              <details className="account-menu">
                <summary>
                  <span>{(gmail.email || 'S').charAt(0).toUpperCase()}</span>
                  <MoreVertical size={16} />
                </summary>
                <div className="account-popover">
                  <strong>{gmail.email || 'My Account'}</strong>
                  <button type="button">Settings</button>
                  <button type="button">Connected Accounts</button>
                  <button onClick={logoutGmail} type="button">Logout</button>
                </div>
              </details>
            ) : (
              <button
                className={`auth-button ${authChecking ? 'is-loading' : ''}`}
                disabled={authChecking}
                onClick={connectGmail}
                type="button"
              >
                {authChecking ? 'Connecting' : 'Login'}
              </button>
            )}
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
            <aside className="folder-rail">
              {folders.map(({ id, label, icon: Icon }) => (
                <button
                  className={activeFolder === id ? 'active' : ''}
                  key={id}
                  onClick={() => setActiveFolder(id)}
                  type="button"
                >
                  <Icon size={17} />
                  <span>{label}</span>
                  <b>{id === 'inbox' ? unreadCount : folderCounts[id]}</b>
                </button>
              ))}
              <div className="labels">
                <span>Labels</span>
                <p><i /> Work</p>
                <p><i /> Important</p>
              </div>
            </aside>

            <div className="mail-list main-list">
              <div className="section-title">
                <h2>{folders.find((folder) => folder.id === activeFolder)?.label}</h2>
                <button onClick={refreshMailbox} aria-label="Refresh mailbox">
                  <RefreshCw size={16} />
                </button>
              </div>
              <form className="mail-search" onSubmit={runAiSearch}>
                <Search size={17} />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="AI search: emails from John about the project meeting"
                />
                <button type="submit">Ask AI</button>
              </form>
              {mailbox.date && <p className="mail-date">Showing {mailbox.date}</p>}
              {visibleEmails.map((email) => (
                <button
                  className={`mail ${email.unread ? 'unread' : ''} ${
                    selectedEmail?.id === email.id ? 'selected' : ''
                  }`}
                  key={email.id}
                  onClick={() => openEmail(email)}
                  type="button"
                >
                  <span className="avatar">{senderInitial(email)}</span>
                  <div className="mail-copy">
                    <strong>{email.sender || email.to || 'Unknown sender'}</strong>
                    <span>{email.subject}</span>
                    <small>{email.snippet || email.body}</small>
                  </div>
                  <div className="mail-meta">
                    <time>{formatEmailTime(email)}</time>
                    <span>
                      <Star
                        size={15}
                        fill={isImportant(email) ? 'currentColor' : 'none'}
                      />
                      {hasAttachment(email) && <Paperclip size={15} />}
                    </span>
                    {email.unread ? <b>New</b> : <CheckCircle2 size={15} />}
                  </div>
                </button>
              ))}
              {visibleEmails.length === 0 && (
                <p className="empty-state">
                  {gmail.connected ? 'No matching mails.' : "Login to load today's mails."}
                </p>
              )}
            </div>

            <div className="reader-shell">
              {selectedEmail ? (
                <article className="email-reader">
                  <div className="email-reader-header">
                    <div>
                      <span className="eyebrow">From: {selectedEmail.from || selectedEmail.sender}</span>
                      <h3>{selectedEmail.subject}</h3>
                    </div>
                    <div className="reader-icons">
                      <button type="button" aria-label="Star message"><Star size={18} /></button>
                      <button type="button" aria-label="Archive message"><Archive size={18} /></button>
                    </div>
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
                  <section className="ai-email-card">
                    <h4>AI Summary</h4>
                    <p>{emailAiSummary(selectedEmail).summary}</p>
                    <h4>Action required</h4>
                    <p className={isImportant(selectedEmail) ? 'action-hot' : ''}>
                      {isImportant(selectedEmail) ? '🔴 ' : '🔵 '}
                      {emailAiSummary(selectedEmail).action}
                    </p>
                    <h4>Suggested response</h4>
                    <blockquote>{emailAiSummary(selectedEmail).response}</blockquote>
                    <button onClick={() => askForDraft(selectedEmail)} type="button">Draft Reply</button>
                  </section>
                  <div className="reader-actions">
                    <button onClick={() => askForDraft(selectedEmail)} type="button"><Reply size={16} /> Reply</button>
                    <button onClick={() => sendMessage(`Forward "${selectedEmail.subject}" with a short note.`)} type="button"><Forward size={16} /> Forward</button>
                    <button onClick={() => sendMessage(`Summarize this email: ${selectedEmail.subject}`)} type="button"><Sparkles size={16} /> AI Summarize</button>
                  </div>
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
                {messages.length === 0 && (
                  <section className="agent-actions">
                    <span>✨ AI Assistant</span>
                    <p>I can find unread mail, identify what needs a response, draft replies, and prepare cleanup actions for review.</p>
                    <div>
                      <button onClick={() => sendMessage('Show urgent emails')} type="button">Show Urgent Emails</button>
                      <button onClick={() => sendMessage('Draft all replies that need my approval')} type="button">Draft All Replies</button>
                      <button onClick={() => sendMessage('Summarize everything important')} type="button">Summarize Everything</button>
                    </div>
                  </section>
                )}
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
                      <Sparkles className="processing-sparkle" size={17} />
                    </div>
                    <div className="message-content">
                      <p className="message-line">
                        {streamingReply || 'Checking mailbox, reading relevant messages, and preparing a response...'}
                      </p>
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
                        <h3>I&apos;ve drafted this reply</h3>
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
                        ref={pendingBodyRef}
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
                        {sendingEmail ? 'Sending...' : 'Send Email'}
                      </button>
                      <button
                        className="cancel-approval"
                        disabled={loading}
                        onClick={() => pendingBodyRef.current?.focus()}
                        type="button"
                      >
                        Edit
                      </button>
                    </div>
                  </section>
                )}

                {messages.length === 0 && !loading && <div className="quick-prompts" aria-label="Suggested prompts">
                  {starterPrompts.map((prompt) => (
                    <button key={prompt} onClick={() => sendMessage(prompt)} type="button">
                      {prompt}
                    </button>
                  ))}
                </div>}

                <form className="composer" onSubmit={submit}>
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Ask PulseMail to summarize, draft, prioritize, or send..."
                  />
                  <button disabled={loading || !input.trim()} type="submit" aria-label="Send message">
                    {loading ? <span className="button-spinner" /> : <Send size={18} />}
                  </button>
                </form>
              </div>
            </div>
          </section>
        )}

        {error && <p className="error">{error}</p>}
        {toast && (
          <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
            <CheckCircle2 size={17} />
            <span>{toast.message}</span>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

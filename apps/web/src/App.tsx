import { FormEvent, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { clearStoredApiToken, getStoredApiToken, setStoredApiToken, subscribeToApiToken } from "./api/auth";
import { approveTaskChat, sendTaskChat, type ApiProposedContract, type ApiTaskChatApproveResponse } from "./api/control-plane";
import { ControlCenterPage } from "./pages/ControlCenterPage";
import { BoardPage } from "./pages/BoardPage";
import { ResearchReviewPage } from "./pages/ResearchReviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { SkillsPage } from "./pages/SkillsPage";

const chatSessionStorageKey = "salvo.dashboard.chat.session.v1";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  proposed_contract: ApiProposedContract | null;
};

type StoredChatSession = {
  session_id: string | null;
  messages: ChatMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStoredChatSession(): StoredChatSession {
  if (typeof window === "undefined" || !window.sessionStorage) {
    return {
      session_id: null,
      messages: []
    };
  }

  const raw = window.sessionStorage.getItem(chatSessionStorageKey);
  if (!raw) {
    return {
      session_id: null,
      messages: []
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        session_id: null,
        messages: []
      };
    }

    const sessionId =
      typeof parsed.session_id === "string" && parsed.session_id.trim().length > 0
        ? parsed.session_id.trim()
        : null;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

    const normalizedMessages: ChatMessage[] = messages.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const id = typeof entry.id === "string" ? entry.id : null;
      const role = entry.role === "user" || entry.role === "assistant" ? entry.role : null;
      const content = typeof entry.content === "string" ? entry.content : null;
      const createdAt = typeof entry.created_at === "string" ? entry.created_at : null;
      const proposedContract =
        entry.proposed_contract === null || entry.proposed_contract === undefined
          ? null
          : isRecord(entry.proposed_contract)
            ? entry.proposed_contract
            : null;

      if (!id || !role || content === null || !createdAt) {
        return [];
      }

      return [
        {
          id,
          role,
          content,
          created_at: createdAt,
          proposed_contract: proposedContract
        }
      ];
    });

    return {
      session_id: sessionId,
      messages: normalizedMessages
    };
  } catch {
    return {
      session_id: null,
      messages: []
    };
  }
}

function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  proposedContract: ApiProposedContract | null = null
): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    created_at: new Date().toISOString(),
    proposed_contract: proposedContract
  };
}

function formatChatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readProposalString(proposal: ApiProposedContract, keys: string[]): string | null {
  for (const key of keys) {
    const value = proposal[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readProposalBoolean(proposal: ApiProposedContract, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = proposal[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function extractApprovedTaskId(response: ApiTaskChatApproveResponse): string | null {
  const taskIdFromTopLevel =
    typeof response.task_id === "string" && response.task_id.trim().length > 0 ? response.task_id.trim() : null;
  if (taskIdFromTopLevel) {
    return taskIdFromTopLevel;
  }

  if (isRecord(response.task)) {
    const nestedId = response.task.id;
    if (typeof nestedId === "string" && nestedId.trim().length > 0) {
      return nestedId.trim();
    }
  }

  const taskIdFromCamelCase =
    typeof response.taskId === "string" && response.taskId.trim().length > 0 ? response.taskId.trim() : null;
  if (taskIdFromCamelCase) {
    return taskIdFromCamelCase;
  }

  return null;
}

export function AppShell() {
  const navigate = useNavigate();
  const [apiToken, setApiToken] = useState(() => getStoredApiToken());
  const [draftToken, setDraftToken] = useState(() => getStoredApiToken());
  const [tokenPromptOpen, setTokenPromptOpen] = useState(() => getStoredApiToken().length === 0);
  const initialChatSession = useRef<StoredChatSession>(readStoredChatSession());

  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatApproveBusyMessageId, setChatApproveBusyMessageId] = useState<string | null>(null);
  const [chatSessionId, setChatSessionId] = useState<string | null>(initialChatSession.current.session_id);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChatSession.current.messages);
  const [proposalDraftByMessageId, setProposalDraftByMessageId] = useState<Record<string, string>>({});
  const [proposalEditorOpenByMessageId, setProposalEditorOpenByMessageId] = useState<Record<string, boolean>>({});
  const [editedProposalByMessageId, setEditedProposalByMessageId] = useState<Record<string, boolean>>({});
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return subscribeToApiToken(() => {
      const nextToken = getStoredApiToken();
      setApiToken(nextToken);
      setDraftToken(nextToken);
      if (nextToken.length === 0) {
        setTokenPromptOpen(true);
      }
    });
  }, []);

  function onSubmitToken(event: FormEvent) {
    event.preventDefault();
    const savedToken = setStoredApiToken(draftToken);
    setApiToken(savedToken);
    setDraftToken(savedToken);
    setTokenPromptOpen(false);
  }

  const tokenConfigured = apiToken.length > 0;

  useEffect(() => {
    if (!tokenConfigured && chatModalOpen) {
      setChatModalOpen(false);
    }
  }, [chatModalOpen, tokenConfigured]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.sessionStorage) {
      return;
    }
    window.sessionStorage.setItem(
      chatSessionStorageKey,
      JSON.stringify({
        session_id: chatSessionId,
        messages: chatMessages
      })
    );
  }, [chatMessages, chatSessionId]);

  useEffect(() => {
    if (!chatModalOpen || !chatTranscriptRef.current) {
      return;
    }
    chatTranscriptRef.current.scrollTop = chatTranscriptRef.current.scrollHeight;
  }, [chatBusy, chatMessages, chatModalOpen]);

  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        const target = event.target;
        if (target instanceof HTMLElement) {
          const tagName = target.tagName.toLowerCase();
          if (tagName === "input" || tagName === "textarea" || target.isContentEditable) {
            return;
          }
        }
        event.preventDefault();
        if (tokenConfigured) {
          setChatError(null);
          setChatModalOpen((current) => !current);
        }
        return;
      }

      if (event.key === "Escape" && chatModalOpen) {
        setChatModalOpen(false);
      }
    }

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [chatModalOpen, tokenConfigured]);

  async function onSubmitChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message || chatBusy || !tokenConfigured) {
      return;
    }

    setChatError(null);
    setChatInput("");
    setChatBusy(true);
    setChatMessages((current) => [...current, createChatMessage("user", message)]);

    try {
      const reply = await sendTaskChat({
        message,
        sessionId: chatSessionId
      });
      setChatSessionId(reply.session_id);
      setChatMessages((current) => [
        ...current,
        createChatMessage("assistant", reply.response, reply.proposed_contract ?? null)
      ]);
    } catch (chatRequestError) {
      setChatInput(message);
      setChatError((chatRequestError as Error).message);
    } finally {
      setChatBusy(false);
    }
  }

  function onToggleProposalEditor(message: ChatMessage) {
    const isOpen = proposalEditorOpenByMessageId[message.id] === true;
    if (!isOpen && !proposalDraftByMessageId[message.id] && message.proposed_contract) {
      setProposalDraftByMessageId((current) => ({
        ...current,
        [message.id]: JSON.stringify(message.proposed_contract, null, 2)
      }));
    }

    setProposalEditorOpenByMessageId((current) => ({
      ...current,
      [message.id]: !isOpen
    }));
  }

  function onSaveProposalEdit(messageId: string) {
    const draft = proposalDraftByMessageId[messageId];
    if (!draft) {
      setChatError("Proposal edit cannot be empty.");
      return;
    }

    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!isRecord(parsed)) {
        setChatError("Proposal edit must be a JSON object.");
        return;
      }

      setChatMessages((current) =>
        current.map((item) => {
          if (item.id !== messageId) {
            return item;
          }
          return {
            ...item,
            proposed_contract: parsed
          };
        })
      );
      setProposalEditorOpenByMessageId((current) => ({
        ...current,
        [messageId]: false
      }));
      setEditedProposalByMessageId((current) => ({
        ...current,
        [messageId]: true
      }));
      setChatError(null);
    } catch {
      setChatError("Proposal edit must be valid JSON.");
    }
  }

  async function onApproveProposal(message: ChatMessage) {
    if (!chatSessionId) {
      setChatError("No chat session is active yet.");
      return;
    }
    if (!message.proposed_contract) {
      setChatError("This response has no proposal to approve.");
      return;
    }

    setChatError(null);
    setChatApproveBusyMessageId(message.id);

    try {
      const result = await approveTaskChat({
        sessionId: chatSessionId,
        proposedContract: editedProposalByMessageId[message.id] ? message.proposed_contract : undefined
      });
      const taskId = extractApprovedTaskId(result);
      setChatMessages((current) => [
        ...current,
        createChatMessage(
          "assistant",
          taskId
            ? `Approved and created task ${taskId}. Returning to board.`
            : "Approved and created a task. Returning to board."
        )
      ]);
      setChatModalOpen(false);
      navigate(taskId ? `/board?taskId=${encodeURIComponent(taskId)}&panel=contract` : "/board?panel=contract");
    } catch (approveError) {
      setChatError((approveError as Error).message);
    } finally {
      setChatApproveBusyMessageId(null);
    }
  }

  function onResetChatSession() {
    setChatSessionId(null);
    setChatMessages([]);
    setChatInput("");
    setChatError(null);
    setProposalDraftByMessageId({});
    setProposalEditorOpenByMessageId({});
    setEditedProposalByMessageId({});
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.removeItem(chatSessionStorageKey);
    }
  }

  return (
    <div className="app-frame">
      <main className="main-panel">
        <nav className="top-nav">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Control Center
          </NavLink>
          <NavLink
            to="/board"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Tasks & Runs Board
          </NavLink>
          <NavLink
            to="/research"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Research Review
          </NavLink>
          <NavLink
            to="/skills"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Skills
          </NavLink>
          <NavLink
            to="/integrations"
            className={({ isActive }) => `top-nav-link ${isActive ? "top-nav-link-active" : ""}`}
          >
            Integrations
          </NavLink>
          <button
            type="button"
            className="top-nav-chat"
            disabled={!tokenConfigured}
            title="Open orchestrator chat (Ctrl/Cmd + K)"
            onClick={() => {
              setChatError(null);
              setChatModalOpen(true);
            }}
          >
            Orchestrator Chat
          </button>
          <button
            type="button"
            className="top-nav-token"
            onClick={() => {
              setDraftToken(apiToken);
              setTokenPromptOpen(true);
            }}
          >
            API Token
          </button>
        </nav>

        {tokenConfigured ? (
          <Routes>
            <Route path="/" element={<ControlCenterPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/research" element={<ResearchReviewPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/runs/:runId" element={<RunDetailPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <section className="content clip-card auth-locked-state">
            <header className="content-header">
              <h1>Dashboard Locked</h1>
              <p className="muted">
                Enter the bearer token from <span className="mono">SALVO_API_TOKEN</span> to use the control plane.
              </p>
            </header>
          </section>
        )}
      </main>

      {tokenPromptOpen ? (
        <div className="auth-modal-backdrop" role="presentation">
          <div className="auth-modal clip-card">
            <form className="content auth-modal-content" onSubmit={onSubmitToken}>
              <header className="content-header">
                <h1>API Token</h1>
                <p className="muted">
                  Enter the bearer token configured on the API server. It is stored in local storage for this browser.
                </p>
              </header>

              <label>
                Bearer token
                <input
                  value={draftToken}
                  onChange={(event) => setDraftToken(event.target.value)}
                  type="password"
                  autoFocus
                  required
                />
              </label>

              <div className="auth-modal-actions">
                <button className="button-link" type="submit">
                  Save token
                </button>
                {tokenConfigured ? (
                  <>
                    <button
                      className="button-link"
                      type="button"
                      onClick={() => {
                        setDraftToken(apiToken);
                        setTokenPromptOpen(false);
                      }}
                    >
                      Close
                    </button>
                    <button
                      className="button-link"
                      type="button"
                      onClick={() => {
                        clearStoredApiToken();
                        setDraftToken("");
                        setApiToken("");
                        setTokenPromptOpen(true);
                      }}
                    >
                      Clear saved token
                    </button>
                  </>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {chatModalOpen ? (
        <div
          className="chat-modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setChatModalOpen(false);
            }
          }}
        >
          <section className="chat-modal clip-card" role="dialog" aria-modal="true" aria-label="Orchestrator task intake chat">
            <div className="content chat-modal-content">
              <header className="content-header chat-modal-header">
                <div>
                  <h1>Orchestrator Intake Chat</h1>
                  <p className="muted">
                    Multi-turn task intake with contract proposals. Session history is kept for this browser session.
                  </p>
                </div>
                <div className="chat-modal-header-actions">
                  <button type="button" className="button-link" onClick={onResetChatSession} disabled={chatBusy}>
                    Reset session
                  </button>
                  <button
                    type="button"
                    className="button-link"
                    onClick={() => {
                      setChatModalOpen(false);
                    }}
                  >
                    Close
                  </button>
                </div>
              </header>

              {chatError ? <p className="error-banner">{chatError}</p> : null}

              <div className="chat-transcript" ref={chatTranscriptRef}>
                {chatMessages.length === 0 ? (
                  <p className="muted">
                    Start by describing the task outcome you want. The orchestrator will ask clarifying questions when needed.
                  </p>
                ) : (
                  chatMessages.map((message) => {
                    const title = message.proposed_contract
                      ? readProposalString(message.proposed_contract, ["title", "task_title", "name"])
                      : null;
                    const request = message.proposed_contract
                      ? readProposalString(message.proposed_contract, ["request", "original_request", "description"])
                      : null;
                    const family = message.proposed_contract
                      ? readProposalString(message.proposed_contract, ["contract_family_key", "family_key"])
                      : null;
                    const category = message.proposed_contract
                      ? readProposalString(message.proposed_contract, ["contract_category", "category"])
                      : null;
                    const subcategory = message.proposed_contract
                      ? readProposalString(message.proposed_contract, ["contract_subcategory", "subcategory"])
                      : null;
                    const requiresApproval = message.proposed_contract
                      ? readProposalBoolean(message.proposed_contract, ["requires_approval", "requiresApproval"])
                      : null;
                    const editorOpen = proposalEditorOpenByMessageId[message.id] === true;
                    const proposalDraft =
                      proposalDraftByMessageId[message.id] ??
                      (message.proposed_contract ? JSON.stringify(message.proposed_contract, null, 2) : "");

                    return (
                      <article key={message.id} className={`chat-message chat-message-${message.role}`}>
                        <div className="chat-message-meta">
                          <span className="mono">{message.role === "assistant" ? "orchestrator" : "you"}</span>
                          <span className="muted">{formatChatTimestamp(message.created_at)}</span>
                        </div>
                        <p className="chat-message-content">{message.content}</p>

                        {message.proposed_contract ? (
                          <section className="chat-contract-card">
                            <h3>Proposed Contract</h3>
                            <div className="chat-contract-highlights">
                              <span className="status-pill board-chip-neutral">title {title ?? "-"}</span>
                              <span className="status-pill board-chip-neutral">category {category ?? "-"}</span>
                              <span className="status-pill board-chip-neutral">subcategory {subcategory ?? "-"}</span>
                              <span className="status-pill board-chip-neutral">family {family ?? "-"}</span>
                              <span className="status-pill board-chip-neutral">
                                approval {requiresApproval === null ? "-" : requiresApproval ? "required" : "not required"}
                              </span>
                            </div>
                            {request ? <p className="muted">{request}</p> : null}

                            <div className="chat-contract-actions">
                              <button
                                type="button"
                                className="button-link"
                                disabled={chatApproveBusyMessageId === message.id || chatBusy}
                                onClick={() => {
                                  void onApproveProposal(message);
                                }}
                              >
                                {chatApproveBusyMessageId === message.id ? "Approving..." : "Approve and Create Task"}
                              </button>
                              <button
                                type="button"
                                className="button-link"
                                disabled={chatApproveBusyMessageId === message.id || chatBusy}
                                onClick={() => {
                                  onToggleProposalEditor(message);
                                }}
                              >
                                {editorOpen ? "Close edit" : "Edit proposal JSON"}
                              </button>
                            </div>

                            {editorOpen ? (
                              <div className="chat-proposal-editor">
                                <textarea
                                  rows={10}
                                  value={proposalDraft}
                                  onChange={(event) => {
                                    const nextValue = event.target.value;
                                    setProposalDraftByMessageId((current) => ({
                                      ...current,
                                      [message.id]: nextValue
                                    }));
                                  }}
                                />
                                <div className="chat-proposal-editor-actions">
                                  <button
                                    type="button"
                                    className="button-link"
                                    onClick={() => {
                                      onSaveProposalEdit(message.id);
                                    }}
                                  >
                                    Save edit
                                  </button>
                                  <button
                                    type="button"
                                    className="button-link"
                                    onClick={() => {
                                      setProposalEditorOpenByMessageId((current) => ({
                                        ...current,
                                        [message.id]: false
                                      }));
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <pre className="json-block">{JSON.stringify(message.proposed_contract, null, 2)}</pre>
                            )}
                          </section>
                        ) : null}
                      </article>
                    );
                  })
                )}

                {chatBusy ? <p className="muted mono">orchestrator is thinking...</p> : null}
              </div>

              <form className="chat-input-row" onSubmit={onSubmitChatMessage}>
                <textarea
                  value={chatInput}
                  rows={3}
                  onChange={(event) => {
                    setChatInput(event.target.value);
                  }}
                  placeholder="Describe the task outcome you need..."
                  disabled={chatBusy}
                  autoFocus
                  required
                />
                <div className="chat-input-actions">
                  <span className="muted mono">session {chatSessionId ?? "new"}</span>
                  <button className="button-link" type="submit" disabled={chatBusy || chatInput.trim().length === 0}>
                    {chatBusy ? "Sending..." : "Send"}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

const adminLoginCard = document.getElementById("adminLoginCard");
const adminGameCard = document.getElementById("adminGameCard");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminCodeInput = document.getElementById("adminCode");
const adminLoginMessage = document.getElementById("adminLoginMessage");

const adminQuestionCounter = document.getElementById("adminQuestionCounter");
const adminTimerValue = document.getElementById("adminTimerValue");
const adminPlayersCount = document.getElementById("adminPlayersCount");
const adminQuestionTitle = document.getElementById("adminQuestionTitle");
const adminQuestionText = document.getElementById("adminQuestionText");
const adminAnswerBox = document.getElementById("adminAnswerBox");
const adminActionMessage = document.getElementById("adminActionMessage");

const startBtn = document.getElementById("startBtn");
const revealBtn = document.getElementById("revealBtn");
const nextBtn = document.getElementById("nextBtn");
const playersTableBody = document.getElementById("playersTableBody");

const STORAGE_ADMIN_TOKEN = "funquest_admin_token";

let latestState = null;
let adminToken = "";
let pollHandle = null;

function setMessage(element, text, type) {
  element.textContent = text || "";
  element.classList.remove("ok", "error");
  if (type) element.classList.add(type);
}

function normalizeError(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (value.error && typeof value.error === "string") return value.error;
    if (value.error && typeof value.error === "object") {
      if (typeof value.error.message === "string") return value.error.message;
      if (typeof value.error.code === "string") return value.error.code;
    }
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return fallback;
    }
  }
  return fallback;
}

function getErrorMessage(result, fallback) {
  if (!result) return fallback;
  return normalizeError(result.error ?? result, fallback);
}

async function readResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  let payload = null;

  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }
  } else {
    const text = await response.text();
    if (text) payload = { error: text };
  }

  if (!payload || typeof payload !== "object") payload = {};
  if (!Object.prototype.hasOwnProperty.call(payload, "ok")) {
    payload.ok = response.ok;
  }
  if (!response.ok && !payload.error) {
    payload.error = `Request failed (${response.status})`;
  }
  return payload;
}

function formatClock(seconds) {
  const safe = Math.max(0, seconds);
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function remainingSeconds() {
  if (!latestState || !latestState.questionStartedAt) return 5 * 60;
  const elapsed = Math.floor((Date.now() - latestState.questionStartedAt) / 1000);
  return Math.max(0, latestState.timerSeconds - elapsed);
}

async function getJSON(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  return readResponsePayload(response);
}

async function postJSON(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  return readResponsePayload(response);
}

async function markPlayer(playerId, points) {
  try {
    const result = await postJSON("/api/admin/mark", { token: adminToken, playerId, points });
    if (!result.ok) {
      setMessage(adminActionMessage, getErrorMessage(result, "Marking failed."), "error");
      return;
    }
    setMessage(adminActionMessage, `Marked ${points} point(s).`, "ok");
    fetchAdminState();
  } catch (_error) {
    setMessage(adminActionMessage, "Could not send mark.", "error");
  }
}

function buildMarkButtons(player) {
  const wrap = document.createElement("div");
  wrap.className = "mark-box";

  [0, 1, 2, 3, -1].forEach((points) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-accent btn-mark";
    btn.textContent = points >= 0 ? `+${points}` : String(points);
    btn.disabled = !player.submittedCurrent;
    btn.addEventListener("click", () => markPlayer(player.id, points));
    wrap.appendChild(btn);
  });

  const markInfo = document.createElement("span");
  markInfo.className = "mark-pill";
  markInfo.textContent =
    player.currentPoints === null || player.currentPoints === undefined
      ? "Current mark: not set"
      : `Current mark: ${player.currentPoints}`;
  wrap.appendChild(markInfo);

  return wrap;
}

function renderPlayersTable() {
  playersTableBody.innerHTML = "";
  if (!latestState || !latestState.players || latestState.players.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='4'>No players joined yet.</td>";
    playersTableBody.appendChild(tr);
    return;
  }

  latestState.players.forEach((player) => {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.setAttribute("data-label", "Player");
    nameCell.textContent = player.name;

    const scoreCell = document.createElement("td");
    scoreCell.setAttribute("data-label", "Score");
    scoreCell.textContent = String(player.score);

    const answerCell = document.createElement("td");
    answerCell.setAttribute("data-label", "Current Answer");
    answerCell.className = "answer-cell";
    answerCell.textContent = player.submittedCurrent ? player.currentAnswer : "Not submitted yet";

    const markCell = document.createElement("td");
    markCell.setAttribute("data-label", "Mark");
    markCell.appendChild(buildMarkButtons(player));

    tr.appendChild(nameCell);
    tr.appendChild(scoreCell);
    tr.appendChild(answerCell);
    tr.appendChild(markCell);
    playersTableBody.appendChild(tr);
  });
}

function render() {
  if (!latestState) return;

  adminQuestionCounter.textContent = `${latestState.questionNumber}/${latestState.totalQuestions}`;
  adminTimerValue.textContent = formatClock(remainingSeconds());
  adminPlayersCount.textContent = String(latestState.playersOnline);

  if (!latestState.gameStarted && !latestState.gameFinished) {
    adminQuestionTitle.textContent = "Waiting to start...";
    adminQuestionText.textContent = "Players can join now. Start when everyone is visible.";
  } else if (latestState.gameFinished) {
    adminQuestionTitle.textContent = "Game Finished";
    adminQuestionText.textContent = "Click Start New Game to reset scores and begin again.";
  } else {
    adminQuestionTitle.textContent = `Question ${latestState.questionNumber}`;
    adminQuestionText.textContent = latestState.questionText || "No clue right now.";
  }

  if (latestState.revealAnswer && latestState.answerForAdmin) {
    adminAnswerBox.classList.remove("hidden");
    adminAnswerBox.textContent = `Answer: ${latestState.answerForAdmin}`;
  } else if (latestState.answerForAdmin) {
    adminAnswerBox.classList.remove("hidden");
    adminAnswerBox.textContent = "Answer hidden. Click Reveal Answer when ready.";
  } else {
    adminAnswerBox.classList.add("hidden");
    adminAnswerBox.textContent = "";
  }

  renderPlayersTable();
}

function showAdminLoginUI() {
  adminGameCard.classList.add("hidden");
  adminLoginCard.classList.remove("hidden");
}

function showAdminGameUI() {
  adminLoginCard.classList.add("hidden");
  adminGameCard.classList.remove("hidden");
}

function saveAdminSession(token) {
  localStorage.setItem(STORAGE_ADMIN_TOKEN, token);
}

function clearAdminSession() {
  localStorage.removeItem(STORAGE_ADMIN_TOKEN);
}

async function fetchAdminState() {
  if (!adminToken) return;
  try {
    const result = await getJSON(`/api/admin/state?token=${encodeURIComponent(adminToken)}`);
    if (!result.ok) {
      clearAdminSession();
      clearInterval(pollHandle);
      pollHandle = null;
      adminToken = "";
      latestState = null;
      showAdminLoginUI();
      setMessage(adminLoginMessage, getErrorMessage(result, "Admin session expired. Login again."), "error");
      return;
    }
    latestState = result.state;
    render();
  } catch (_error) {
    setMessage(adminActionMessage, "Connection issue. Retrying...", "error");
  }
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(fetchAdminState, 1000);
  fetchAdminState();
}

adminLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = adminCodeInput.value.trim();
  if (!code) {
    setMessage(adminLoginMessage, "Please enter admin code.", "error");
    return;
  }

  try {
    const result = await postJSON("/api/admin/login", { code });
    if (!result.ok) {
      setMessage(adminLoginMessage, getErrorMessage(result, "Login failed."), "error");
      return;
    }
    adminToken = result.token;
    saveAdminSession(adminToken);
    showAdminGameUI();
    setMessage(adminLoginMessage, "", "");
    setMessage(adminActionMessage, "Admin connected. Start when players are ready.", "ok");
    startPolling();
  } catch (_error) {
    setMessage(adminLoginMessage, "Could not connect to server.", "error");
  }
});

startBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  try {
    const result = await postJSON("/api/admin/start", { token: adminToken });
    if (!result.ok) {
      setMessage(adminActionMessage, getErrorMessage(result, "Could not start game."), "error");
      return;
    }
    setMessage(adminActionMessage, "Game started. Question 1 is live.", "ok");
    fetchAdminState();
  } catch (_error) {
    setMessage(adminActionMessage, "Could not start game.", "error");
  }
});

revealBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  try {
    const result = await postJSON("/api/admin/reveal", { token: adminToken });
    if (!result.ok) {
      setMessage(adminActionMessage, getErrorMessage(result, "Could not reveal answer."), "error");
      return;
    }
    setMessage(adminActionMessage, "Answer revealed to everyone.", "ok");
    fetchAdminState();
  } catch (_error) {
    setMessage(adminActionMessage, "Could not reveal answer.", "error");
  }
});

nextBtn.addEventListener("click", async () => {
  if (!adminToken) return;
  try {
    const result = await postJSON("/api/admin/next", { token: adminToken });
    if (!result.ok) {
      setMessage(adminActionMessage, getErrorMessage(result, "Could not move next."), "error");
      return;
    }
    if (result.finished) {
      setMessage(adminActionMessage, "Reached the final question. Game finished.", "ok");
    } else {
      setMessage(adminActionMessage, "Moved to next question.", "ok");
    }
    fetchAdminState();
  } catch (_error) {
    setMessage(adminActionMessage, "Could not move next.", "error");
  }
});

setInterval(() => {
  if (!latestState) return;
  adminTimerValue.textContent = formatClock(remainingSeconds());
}, 1000);

function restoreAdminSession() {
  const savedToken = localStorage.getItem(STORAGE_ADMIN_TOKEN) || "";
  if (!savedToken) {
    showAdminLoginUI();
    return;
  }

  adminToken = savedToken;
  showAdminGameUI();
  setMessage(adminActionMessage, "Restoring admin session...", "");
  startPolling();
}

restoreAdminSession();

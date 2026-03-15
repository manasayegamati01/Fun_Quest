const joinCard = document.getElementById("joinCard");
const gameCard = document.getElementById("gameCard");
const joinForm = document.getElementById("joinForm");
const playerNameInput = document.getElementById("playerName");
const joinBtn = document.getElementById("joinBtn");
const joinLockNote = document.getElementById("joinLockNote");
const goToPlayBtn = document.getElementById("goToPlayBtn");
const joinMessage = document.getElementById("joinMessage");
const backHomeBtn = document.getElementById("backHomeBtn");

const questionCounter = document.getElementById("questionCounter");
const timerValue = document.getElementById("timerValue");
const myScore = document.getElementById("myScore");
const questionTitle = document.getElementById("questionTitle");
const questionText = document.getElementById("questionText");
const revealAnswer = document.getElementById("revealAnswer");
const answerForm = document.getElementById("answerForm");
const answerInput = document.getElementById("answerInput");
const submitBtn = document.getElementById("submitBtn");
const submitMessage = document.getElementById("submitMessage");
const leaderboardList = document.getElementById("leaderboardList");
const playerCount = document.getElementById("playerCount");

const STORAGE_PLAYER_ID = "funquest_player_id";
const STORAGE_PLAYER_NAME = "funquest_player_name";
const STORAGE_PLAYER_VIEW = "funquest_player_view";
const STORAGE_REVEAL_LOCK_Q = "funquest_reveal_lock_q";

let latestState = null;
let playerId = "";
let pollHandle = null;
let revealLockQuestion = null;

function setMessage(element, text, type) {
  element.textContent = text || "";
  element.classList.remove("ok", "error");
  if (type) element.classList.add(type);
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
  return response.json();
}

async function postJSON(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

function renderLeaderboard() {
  leaderboardList.innerHTML = "";
  if (!latestState || !latestState.leaderboard || latestState.leaderboard.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No scores yet.";
    leaderboardList.appendChild(li);
    return;
  }

  latestState.leaderboard.forEach((entry, index) => {
    const li = document.createElement("li");
    li.textContent = `${index + 1}. ${entry.name} - ${entry.score} pts`;
    leaderboardList.appendChild(li);
  });
}

function render() {
  if (!latestState) return;

  if (latestState.revealAnswer && Number.isInteger(latestState.questionIndex)) {
    revealLockQuestion = latestState.questionIndex;
    localStorage.setItem(STORAGE_REVEAL_LOCK_Q, String(revealLockQuestion));
  }
  if (Number.isInteger(revealLockQuestion) && latestState.questionIndex !== revealLockQuestion) {
    revealLockQuestion = null;
    localStorage.removeItem(STORAGE_REVEAL_LOCK_Q);
  }

  playerCount.textContent = `Players online: ${latestState.playersOnline}`;
  questionCounter.textContent = `${latestState.questionNumber}/${latestState.totalQuestions}`;
  timerValue.textContent = formatClock(remainingSeconds());
  myScore.textContent = latestState.you ? String(latestState.you.score) : "0";

  if (!latestState.gameStarted && !latestState.gameFinished) {
    questionTitle.textContent = "Waiting for admin to start...";
    questionText.textContent = "Stay ready. The clue will appear as soon as admin starts.";
  } else if (latestState.gameFinished) {
    questionTitle.textContent = "Game Finished";
    questionText.textContent = "Thanks for playing. Wait for admin to restart.";
  } else {
    questionTitle.textContent = `Question ${latestState.questionNumber}`;
    questionText.textContent = latestState.questionText || "Waiting for clue...";
  }

  const isLocallyLocked =
    Number.isInteger(revealLockQuestion) && latestState.questionIndex === revealLockQuestion;
  const canSubmit = Boolean(latestState.canSubmit) && !isLocallyLocked;
  answerInput.disabled = !canSubmit;
  submitBtn.disabled = !canSubmit;

  if (latestState.submittedCurrent) {
    setMessage(submitMessage, `Submitted: "${latestState.yourCurrentAnswer}" (no resubmission)`, "ok");
  } else if (latestState.revealAnswer) {
    setMessage(submitMessage, "Answer revealed. Submissions for this question are now closed.", "error");
  } else if (latestState.gameStarted) {
    setMessage(submitMessage, "Type your best guess and click submit.", "");
  } else {
    setMessage(submitMessage, "Answer box unlocks when admin starts the game.", "");
  }

  if (latestState.revealAnswer && latestState.revealedAnswer) {
    revealAnswer.classList.remove("hidden");
    revealAnswer.textContent = `Answer: ${latestState.revealedAnswer}`;
  } else {
    revealAnswer.classList.add("hidden");
    revealAnswer.textContent = "";
  }

  renderLeaderboard();
}

function lockJoinSection(displayName) {
  if (displayName) {
    playerNameInput.value = displayName;
  }
  playerNameInput.disabled = true;
  joinBtn.disabled = true;
  joinLockNote.classList.remove("hidden");
  goToPlayBtn.classList.remove("hidden");
}

function unlockJoinSection() {
  playerNameInput.disabled = false;
  joinBtn.disabled = false;
  joinLockNote.classList.add("hidden");
  goToPlayBtn.classList.add("hidden");
}

function setView(view) {
  if (view === "game" && playerId) {
    joinCard.classList.add("hidden");
    gameCard.classList.remove("hidden");
    localStorage.setItem(STORAGE_PLAYER_VIEW, "game");
    return;
  }

  joinCard.classList.remove("hidden");
  gameCard.classList.add("hidden");
  localStorage.setItem(STORAGE_PLAYER_VIEW, "home");
}

function savePlayerSession(id, name) {
  localStorage.setItem(STORAGE_PLAYER_ID, id);
  localStorage.setItem(STORAGE_PLAYER_NAME, name);
}

function clearPlayerSession() {
  localStorage.removeItem(STORAGE_PLAYER_ID);
  localStorage.removeItem(STORAGE_PLAYER_NAME);
  localStorage.removeItem(STORAGE_PLAYER_VIEW);
  localStorage.removeItem(STORAGE_REVEAL_LOCK_Q);
  revealLockQuestion = null;
}

async function fetchPlayerState() {
  if (!playerId) return;
  try {
    const result = await getJSON(`/api/player/state?playerId=${encodeURIComponent(playerId)}`);
    if (!result.ok) {
      clearPlayerSession();
      clearInterval(pollHandle);
      pollHandle = null;
      playerId = "";
      latestState = null;
      unlockJoinSection();
      setView("home");
      setMessage(joinMessage, result.error || "Session expired. Please rejoin.", "error");
      return;
    }

    latestState = result.state;
    if (latestState.you && latestState.you.name) {
      lockJoinSection(latestState.you.name);
    }
    render();
  } catch (_error) {
    setMessage(submitMessage, "Connection issue. Retrying...", "error");
  }
}

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(fetchPlayerState, 1000);
  fetchPlayerState();
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (joinBtn.disabled) return;

  const name = playerNameInput.value.trim();
  if (!name) {
    setMessage(joinMessage, "Please enter your name.", "error");
    return;
  }

  try {
    const result = await postJSON("/api/player/join", { name });
    if (!result.ok) {
      setMessage(joinMessage, result.error || "Could not join.", "error");
      return;
    }

    playerId = result.playerId;
    savePlayerSession(playerId, name);
    lockJoinSection(name);
    setView("game");
    setMessage(joinMessage, "", "");
    startPolling();
  } catch (_error) {
    setMessage(joinMessage, "Could not connect to server.", "error");
  }
});

goToPlayBtn.addEventListener("click", () => {
  setView("game");
});

backHomeBtn.addEventListener("click", () => {
  setView("home");
});

answerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!playerId) return;

  await fetchPlayerState();
  const isLocallyLocked =
    latestState &&
    Number.isInteger(revealLockQuestion) &&
    latestState.questionIndex === revealLockQuestion;
  if (!latestState || !latestState.canSubmit || isLocallyLocked) {
    if (latestState && latestState.revealAnswer) {
      setMessage(submitMessage, "Answer revealed. Submissions for this question are now closed.", "error");
    }
    return;
  }

  const answer = answerInput.value.trim();
  if (!answer) {
    setMessage(submitMessage, "Please type your answer first.", "error");
    return;
  }

  try {
    submitBtn.disabled = true;
    const result = await postJSON("/api/player/answer", { playerId, answer });
    if (!result.ok) {
      setMessage(submitMessage, result.error || "Submission failed.", "error");
      fetchPlayerState();
      return;
    }
    answerInput.value = "";
    setMessage(submitMessage, "Answer submitted. No resubmission allowed.", "ok");
    fetchPlayerState();
  } catch (_error) {
    setMessage(submitMessage, "Could not submit answer.", "error");
  }
});

setInterval(() => {
  if (!latestState) return;
  timerValue.textContent = formatClock(remainingSeconds());
}, 1000);

function restorePlayerSession() {
  const savedName = localStorage.getItem(STORAGE_PLAYER_NAME) || "";
  const savedId = localStorage.getItem(STORAGE_PLAYER_ID) || "";
  const savedView = localStorage.getItem(STORAGE_PLAYER_VIEW) || "game";
  const savedRevealLock = localStorage.getItem(STORAGE_REVEAL_LOCK_Q);
  revealLockQuestion = savedRevealLock === null ? null : Number(savedRevealLock);

  if (savedName && !playerNameInput.value) {
    playerNameInput.value = savedName;
  }

  if (!savedId) {
    unlockJoinSection();
    setView("home");
    return;
  }

  playerId = savedId;
  lockJoinSection(savedName);
  setView(savedView);
  setMessage(submitMessage, "Restoring your session...", "");
  startPolling();
}

restorePlayerSession();

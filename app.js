const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || window.mozSpeechRecognition;

const sample = `大家好，欢迎来到今天的分享。
这是一款中文跟读提词器。
你只需要按下开始，然后照着稿子朗读。
系统会识别你的中文语音，并自动移动到你读到的位置。
如果识别不准，可以放慢语速，或者轻点下一句进行手动校准。`;

const dom = {
  setupPanel: document.querySelector("#setupPanel"),
  prompterPanel: document.querySelector("#prompterPanel"),
  scriptInput: document.querySelector("#scriptInput"),
  sampleScript: document.querySelector("#sampleScript"),
  loadScript: document.querySelector("#loadScript"),
  engineStatus: document.querySelector("#engineStatus"),
  fontSize: document.querySelector("#fontSize"),
  lineHeight: document.querySelector("#lineHeight"),
  keepAwake: document.querySelector("#keepAwake"),
  mirrorMode: document.querySelector("#mirrorMode"),
  cueWindow: document.querySelector("#cueWindow"),
  cueList: document.querySelector("#cueList"),
  readProgress: document.querySelector("#readProgress"),
  liveTranscript: document.querySelector("#liveTranscript"),
  listenToggle: document.querySelector("#listenToggle"),
  listenText: document.querySelector("#listenText"),
  listenIcon: document.querySelector("#listenIcon"),
  prevCue: document.querySelector("#prevCue"),
  nextCue: document.querySelector("#nextCue"),
  backToEdit: document.querySelector("#backToEdit"),
  toggleFullscreen: document.querySelector("#toggleFullscreen"),
  toast: document.querySelector("#toast"),
};

let recognition = null;
let listening = false;
let scriptSegments = [];
let currentIndex = 0;
let transcriptBuffer = "";
let wakeLock = null;
let restartTimer = 0;
let toastTimer = 0;

init();

function init() {
  restoreDraft();
  bindEvents();
  updateEngineStatus();
  applyTypography();
  registerServiceWorker();
}

function bindEvents() {
  dom.scriptInput.addEventListener("input", persistDraft);
  dom.sampleScript.addEventListener("click", () => {
    dom.scriptInput.value = sample;
    persistDraft();
    showToast("已恢复示例稿");
  });
  dom.loadScript.addEventListener("click", enterPrompter);
  dom.backToEdit.addEventListener("click", leavePrompter);
  dom.listenToggle.addEventListener("click", toggleListening);
  dom.prevCue.addEventListener("click", () => moveCue(currentIndex - 1, true));
  dom.nextCue.addEventListener("click", () => moveCue(currentIndex + 1, true));
  dom.fontSize.addEventListener("input", applyTypography);
  dom.lineHeight.addEventListener("input", applyTypography);
  dom.mirrorMode.addEventListener("change", () => {
    dom.prompterPanel.classList.toggle("mirror", dom.mirrorMode.checked);
  });
  dom.toggleFullscreen.addEventListener("click", toggleFullscreen);
}

function restoreDraft() {
  const saved = localStorage.getItem("teleprompter.script");
  const fontSize = localStorage.getItem("teleprompter.fontSize");
  const lineHeight = localStorage.getItem("teleprompter.lineHeight");
  if (saved) dom.scriptInput.value = saved;
  if (fontSize) dom.fontSize.value = fontSize;
  if (lineHeight) dom.lineHeight.value = lineHeight;
}

function persistDraft() {
  localStorage.setItem("teleprompter.script", dom.scriptInput.value);
}

function updateEngineStatus() {
  if (SpeechRecognition) {
    dom.engineStatus.textContent = "中文识别可用";
    return;
  }
  dom.engineStatus.textContent = "当前浏览器不支持语音识别";
}

function enterPrompter() {
  const raw = dom.scriptInput.value.trim();
  if (!raw) {
    showToast("先粘贴或输入中文稿件");
    return;
  }

  scriptSegments = segmentChineseScript(raw);
  if (!scriptSegments.length) {
    showToast("没有找到可跟读的中文内容");
    return;
  }

  currentIndex = 0;
  transcriptBuffer = "";
  renderCues();
  updateProgress();
  dom.setupPanel.classList.add("is-hidden");
  dom.prompterPanel.classList.remove("is-hidden");
  dom.prompterPanel.classList.toggle("mirror", dom.mirrorMode.checked);
  requestAnimationFrame(() => scrollToCurrent(false));
}

function leavePrompter() {
  stopListening();
  dom.prompterPanel.classList.add("is-hidden");
  dom.setupPanel.classList.remove("is-hidden");
}

function segmentChineseScript(text) {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: index,
      text,
      normalized: normalizeChinese(text),
    }))
    .filter((segment) => segment.normalized.length > 0);
}

function normalizeChinese(value) {
  return value
    .replace(/[^\u4e00-\u9fa5零一二三四五六七八九十百千万亿两〇]/g, "")
    .replace(/台/g, "臺")
    .replace(/里/g, "裏");
}

function renderCues() {
  dom.cueList.replaceChildren();
  const fragment = document.createDocumentFragment();
  scriptSegments.forEach((segment, index) => {
    const cue = document.createElement("li");
    cue.className = "cue";
    cue.dataset.index = String(index);
    cue.textContent = segment.text;
    cue.addEventListener("click", () => moveCue(index, true));
    fragment.appendChild(cue);
  });
  dom.cueList.appendChild(fragment);
  paintCues();
}

function paintCues() {
  dom.cueList.querySelectorAll(".cue").forEach((cue, index) => {
    cue.classList.toggle("is-read", index < currentIndex);
    cue.classList.toggle("is-current", index === currentIndex);
  });
}

async function toggleListening() {
  if (listening) {
    stopListening();
    return;
  }
  await startListening();
}

async function startListening() {
  if (!SpeechRecognition) {
    showToast("请在支持语音识别的 Chrome 或 Edge 手机浏览器中打开");
    return;
  }

  try {
    await acquireWakeLock();
    recognition = buildRecognition();
    recognition.start();
    listening = true;
    updateListeningUi();
  } catch (error) {
    listening = false;
    releaseWakeLock();
    updateListeningUi();
    showToast(error?.message || "语音识别启动失败");
  }
}

function buildRecognition() {
  const instance = new SpeechRecognition();
  instance.lang = "zh-CN";
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;

  instance.onstart = () => {
    dom.liveTranscript.textContent = "正在听中文...";
  };

  instance.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) final += text;
      else interim += text;
    }

    const heard = (final || interim).trim();
    if (heard) {
      dom.liveTranscript.textContent = heard;
      advanceBySpeech(heard, Boolean(final));
    }

    if (final) {
      transcriptBuffer = trimBuffer(transcriptBuffer + final);
    }
  };

  instance.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("需要允许麦克风权限才能跟读");
      stopListening();
      return;
    }
    showToast("识别有点卡，正在尝试继续");
  };

  instance.onend = () => {
    if (!listening) return;
    clearTimeout(restartTimer);
    restartTimer = window.setTimeout(() => {
      try {
        recognition?.start();
      } catch {
        stopListening();
      }
    }, 260);
  };

  return instance;
}

function advanceBySpeech(text, isFinal) {
  const normalized = normalizeChinese(text);
  if (!normalized) return;

  const searchText = trimBuffer(transcriptBuffer + normalized);
  const match = findBestSegment(searchText, currentIndex);
  if (match.index !== currentIndex && match.score >= 0.48) {
    moveCue(match.index, false);
  }

  const current = scriptSegments[currentIndex];
  if (!current) return;

  const currentScore = similarity(searchText, current.normalized);
  const shouldAdvance =
    isFinal &&
    (currentScore >= 0.7 ||
      searchText.includes(current.normalized.slice(0, Math.min(8, current.normalized.length))));

  if (shouldAdvance && currentIndex < scriptSegments.length - 1) {
    moveCue(currentIndex + 1, false);
  }
}

function findBestSegment(text, fromIndex) {
  const start = Math.max(0, fromIndex - 1);
  const end = Math.min(scriptSegments.length - 1, fromIndex + 4);
  let best = { index: fromIndex, score: 0 };

  for (let index = start; index <= end; index += 1) {
    const score = similarity(text, scriptSegments[index].normalized);
    if (score > best.score) best = { index, score };
  }

  return best;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }

  const aSet = new Set([...a]);
  let overlap = 0;
  for (const char of b) {
    if (aSet.has(char)) overlap += 1;
  }

  const ordered = longestCommonSubsequence(a, b);
  return Math.max(overlap / b.length, ordered / Math.max(a.length, b.length));
}

function longestCommonSubsequence(a, b) {
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }

  return previous[b.length];
}

function trimBuffer(value) {
  return normalizeChinese(value).slice(-80);
}

function moveCue(nextIndex, manual) {
  const bounded = Math.max(0, Math.min(scriptSegments.length - 1, nextIndex));
  if (bounded === currentIndex && !manual) return;

  currentIndex = bounded;
  paintCues();
  updateProgress();
  scrollToCurrent(true);

  if (manual) {
    transcriptBuffer = scriptSegments[currentIndex]?.normalized || "";
  }
}

function updateProgress() {
  dom.readProgress.textContent = `${Math.min(currentIndex + 1, scriptSegments.length)} / ${scriptSegments.length}`;
}

function scrollToCurrent(smooth) {
  const current = dom.cueList.querySelector(".cue.is-current");
  if (!current) return;

  const target =
    current.offsetTop - dom.cueWindow.clientHeight * 0.36 + current.clientHeight / 2;
  dom.cueWindow.scrollTo({
    top: Math.max(0, target),
    behavior: smooth ? "smooth" : "auto",
  });
}

function applyTypography() {
  localStorage.setItem("teleprompter.fontSize", dom.fontSize.value);
  localStorage.setItem("teleprompter.lineHeight", dom.lineHeight.value);
  document.documentElement.style.setProperty("--cue-font-size", `${dom.fontSize.value}px`);
  document.documentElement.style.setProperty("--cue-line-height", `${Number(dom.lineHeight.value) / 100}`);
}

function updateListeningUi() {
  dom.listenToggle.classList.toggle("is-listening", listening);
  dom.listenText.textContent = listening ? "停止跟读" : "开始跟读";
  dom.listenIcon.textContent = listening ? "■" : "●";
  if (!listening) dom.liveTranscript.textContent = "已停止";
}

function stopListening() {
  listening = false;
  clearTimeout(restartTimer);
  if (recognition) {
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      recognition.abort?.();
    }
  }
  recognition = null;
  releaseWakeLock();
  updateListeningUi();
}

async function acquireWakeLock() {
  if (!dom.keepAwake.checked || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    showToast("当前浏览器不允许全屏");
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, 2600);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

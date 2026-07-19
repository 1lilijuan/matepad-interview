"use strict";

const $ = (id) => document.getElementById(id);
const KB = window.INTERVIEW_KB || [];
const TECHNICAL_TERMS = window.TECHNICAL_TERMS || [];
const APP_VERSION = window.APP_BUILD || "V8.0.0";

const CN_MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-cn-0.3.tar.gz";
const EN_MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";
const SILENCE_TO_ANSWER_MS = 2500;
const RESULT_WAIT_MS = 950;
const MIN_SPEECH_MS = 650;

let cnModel = null;
let enModel = null;
let cnRecognizer = null;
let enRecognizer = null;

let stream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let analyser = null;
let silentGain = null;
let meterFrame = null;
let wakeLock = null;

let listening = false;
let loading = false;
let finalizing = false;
let speechStarted = false;
let speechStartAt = 0;
let lastVoiceAt = 0;
let lastFinalizeAt = 0;
let audioChunkCount = 0;
let finalizeTimer = null;
let modelTimer = null;

let cnPartial = "";
let enPartial = "";
let cnFinalParts = [];
let enFinalParts = [];

function setStatus(text, mode = "") {
  $("status").textContent = text;
  $("lamp").className = "lamp" + (mode ? " " + mode : "");
}

function setDiagnostic(text) {
  $("partial").textContent = `${APP_VERSION}｜${text}`;
}

function collapseSpaces(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

const REPLACEMENTS = [
  [/a\s*x\s*i/gi, " axi "],
  [/a\s*p\s*b/gi, " apb "],
  [/p\s*t\s*p\s*x/gi, " ptpx "],
  [/g\s*p\s*g\s*p\s*u/gi, " gpgpu "],
  [/r\s*m\s*w/gi, " rmw "],
  [/s\s*d\s*c/gi, " sdc "],
  [/u\s*p\s*f/gi, " upf "],
  [/c\s*d\s*c/gi, " cdc "],
  [/n\s*p\s*u/gi, " npu "],
  [/d\s*r\s*a\s*m/gi, " dram "],
  [/f\s*s\s*d\s*b/gi, " fsdb "],
  [/班克|板克|办克|banker/gi, " bank "],
  [/艾克西|爱克斯爱|埃克西|阿克西/gi, " axi "],
  [/阿帕比|爱皮比|a皮b/gi, " apb "],
  [/皮提皮艾克斯|皮提皮叉|p t p x/gi, " ptpx "],
  [/格雷码|灰码/gi, " gray code "],
  [/异步发热|异步发福|异步 fifo/gi, " asynchronous fifo "],
  [/读改写|read modify right|read modified write/gi, " read modify write "],
  [/五十吉赫兹|五十g|fifty g/gi, " 50 ghz "],
  [/形式检验|form verification/gi, " formal verification "],
  [/可比点|compare points/gi, " compare point "],
  [/ready and valid|ready valid signal/gi, " ready valid "],
  [/memory control/gi, " memory controller "],
  [/compute call/gi, " compute core "],
  [/prime time p x/gi, " primetime px "]
];

function normalize(text) {
  let value = collapseSpaces(text).toLowerCase();
  for (const [pattern, replacement] of REPLACEMENTS) {
    value = value.replace(pattern, replacement);
  }
  return collapseSpaces(
    value
      .replace(/[，。！？、,.!?;；:：()（）【】\[\]{}"'`~]/g, " ")
      .replace(/[_/\\-]/g, " ")
  );
}

function englishTokens(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !["the","a","an","is","are","of","to","in","and","your","you","me","my","please","can","do","does","how","what"].includes(token));
}

function chineseBigrams(text) {
  const chars = normalize(text).replace(/[a-z0-9\s]/g, "");
  const result = [];
  for (let i = 0; i < chars.length - 1; i += 1) result.push(chars.slice(i, i + 2));
  return result;
}

function diceCoefficient(aValues, bValues) {
  if (!aValues.length || !bValues.length) return 0;
  const counts = new Map();
  for (const item of aValues) counts.set(item, (counts.get(item) || 0) + 1);
  let intersection = 0;
  for (const item of bValues) {
    const count = counts.get(item) || 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  }
  return (2 * intersection) / (aValues.length + bValues.length);
}

function levenshteinSimilarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 120 || b.length > 120) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  const distance = previous[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function scoreEntry(rawText, entry) {
  const q = normalize(rawText);
  const phrases = [
    entry.name,
    entry.canonicalZh,
    entry.canonicalEn,
    ...(entry.patterns || []),
    ...(entry.enPatterns || []),
    entry.keywords
  ].filter(Boolean);

  let score = 0;
  const qTokens = englishTokens(q);
  const qBigrams = chineseBigrams(q);

  for (const phrase of phrases) {
    const p = normalize(phrase);
    if (!p) continue;

    if (q.includes(p) || p.includes(q)) {
      score = Math.max(score, 72 + Math.min(25, Math.min(q.length, p.length)));
    }

    const pTokens = englishTokens(p);
    if (qTokens.length && pTokens.length) {
      const tokenScore = diceCoefficient(qTokens, pTokens);
      score = Math.max(score, tokenScore * 86);
    }

    const pBigrams = chineseBigrams(p);
    if (qBigrams.length && pBigrams.length) {
      const chineseScore = diceCoefficient(qBigrams, pBigrams);
      score = Math.max(score, chineseScore * 92);
    }

    const editScore = levenshteinSimilarity(q, p);
    score = Math.max(score, editScore * 78);
  }

  const technicalText = `${entry.name} ${entry.keywords} ${(entry.enPatterns || []).join(" ")}`.toLowerCase();
  for (const term of TECHNICAL_TERMS) {
    const t = normalize(term);
    if (t && q.includes(t) && normalize(technicalText).includes(t)) score += 11;
  }

  return Math.min(100, score);
}

function chooseSemanticMatch(rawCn, rawEn) {
  const candidates = [
    rawCn,
    rawEn,
    `${rawCn} ${rawEn}`,
    normalize(`${rawCn} ${rawEn}`)
  ].filter((value) => collapseSpaces(value));

  let best = null;
  let bestScore = -1;
  let secondScore = -1;

  for (const entry of KB) {
    let entryScore = 0;
    for (const candidate of candidates) {
      entryScore = Math.max(entryScore, scoreEntry(candidate, entry));
    }
    if (entryScore > bestScore) {
      secondScore = bestScore;
      bestScore = entryScore;
      best = entry;
    } else if (entryScore > secondScore) {
      secondScore = entryScore;
    }
  }

  const margin = Math.max(0, bestScore - secondScore);
  const confidence = Math.round(Math.min(99, bestScore * 0.82 + margin * 0.35));
  return { entry: best, score: bestScore, confidence, margin };
}

function genericAnswer(rawText) {
  const q = normalize(rawText);
  if (q.includes("axi") || q.includes("apb") || q.includes("bus") || q.includes("总线")) {
    return {
      name: "总线与接口类通用问题",
      canonicalZh: "请介绍一下相关总线或接口模块的设计。",
      keywords: "接口作用｜握手｜状态机｜CDC｜异常处理",
      answer: "这个问题我会从接口作用、数据和控制流程、握手机制以及异常处理四个层面回答。模块首先接收并锁存上游请求，再通过仲裁、跨时钟或协议转换送到下游，最后等待响应并返回状态。设计时重点关注VALID/READY、请求不能丢失、多笔事务对应、复位以及边界场景。"
    };
  }
  return {
    name: "通用项目问题",
    canonicalZh: collapseSpaces(rawText) || "请介绍一下这个项目问题。",
    keywords: "背景｜任务｜实现｜难点｜验证结果",
    answer: "这个问题在当前本地题库中没有高置信度的精确答案。我会先说明项目背景和目标，再明确我负责的任务；然后介绍数据流、控制流或状态机实现；接着说明关键难点及定位方法；最后给出仿真、综合、波形或芯片测试结果。"
  };
}

function renderAnswerFromRecognition(rawCn, rawEn) {
  const combined = collapseSpaces(`${rawCn} ${rawEn}`);
  if (!combined) {
    setDiagnostic("两个模型都没有得到有效文字。请靠近平板，连续说完整句子。");
    setStatus("本题未识别出有效文字", "error");
    return;
  }

  $("rawCn").textContent = rawCn || "未得到中文结果";
  $("rawEn").textContent = rawEn || "未得到英文结果";

  const match = chooseSemanticMatch(rawCn, rawEn);
  const result = match.entry && match.score >= 24 ? match.entry : genericAnswer(combined);
  const corrected = result.canonicalZh || combined;

  $("question").value = corrected;
  $("matched").textContent = `自动语义匹配：${result.name}`;
  $("keywords").textContent = result.keywords;
  $("answer").textContent = result.answer;

  const level = match.score >= 70 ? "高" : match.score >= 46 ? "中" : "低";
  $("confidence").textContent =
    `语义匹配置信度：${level}（${Math.round(match.score)}分）｜已自动把模糊识别更正为标准问题`;

  setDiagnostic(`已自动校正并生成回答：${corrected}`);
  setStatus(listening ? "回答已生成，继续等待下一题" : "回答已生成", listening ? "on" : "");
}

function resetQuestionBuffers() {
  cnPartial = "";
  enPartial = "";
  cnFinalParts = [];
  enFinalParts = [];
  speechStarted = false;
  speechStartAt = 0;
  lastVoiceAt = 0;
  finalizing = false;
}

function updatePartialDisplay() {
  const cnText = collapseSpaces([...cnFinalParts, cnPartial].join(" "));
  const enText = collapseSpaces([...enFinalParts, enPartial].join(" "));
  $("rawCn").textContent = cnText || "—";
  $("rawEn").textContent = enText || "—";

  if (cnPartial || enPartial) {
    setDiagnostic(`实时识别｜中文：${cnPartial || "…"}｜English: ${enPartial || "…"}`);
    setStatus("正在进行中英双语识别", "on");
  }
}

function createRecognizers(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("无法取得有效采样率：" + sampleRate);
  }

  cnRecognizer = new cnModel.KaldiRecognizer(sampleRate);
  enRecognizer = new enModel.KaldiRecognizer(sampleRate);

  cnRecognizer.on("partialresult", (message) => {
    cnPartial = collapseSpaces(message?.result?.partial || "");
    updatePartialDisplay();
  });

  enRecognizer.on("partialresult", (message) => {
    enPartial = collapseSpaces(message?.result?.partial || "");
    updatePartialDisplay();
  });

  cnRecognizer.on("result", (message) => {
    const text = collapseSpaces(message?.result?.text || "");
    cnPartial = "";
    if (text) cnFinalParts.push(text);
    updatePartialDisplay();
  });

  enRecognizer.on("result", (message) => {
    const text = collapseSpaces(message?.result?.text || "");
    enPartial = "";
    if (text) enFinalParts.push(text);
    updatePartialDisplay();
  });

  const errorHandler = (language) => (message) => {
    console.error(`${language} recognizer error`, message);
    setDiagnostic(`${language}识别器错误：${message?.error || "未知错误"}`);
    setStatus(`${language}识别器错误`, "error");
  };
  cnRecognizer.on("error", errorHandler("中文"));
  enRecognizer.on("error", errorHandler("英文"));
}

async function loadModels() {
  if (loading || (cnModel && enModel)) return;
  loading = true;
  $("loadModels").disabled = true;
  $("progressBar").className = "loading";
  const startedAt = Date.now();

  modelTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $("modelInfo").textContent = `正在加载中英双语模型，已等待${seconds}秒。请保持页面前台并不要锁屏。`;
  }, 1000);

  try {
    if (!window.Vosk?.createModel) throw new Error("Vosk程序未加载，请检查网络。");

    setStatus("第1步/2：正在加载中文模型", "busy");
    $("modelInfo").textContent = "正在下载并解压中文模型……";
    cnModel = await window.Vosk.createModel(CN_MODEL_URL);
    $("progressBar").className = "";
    $("progressBar").style.width = "52%";

    setStatus("第2步/2：正在加载英文模型", "busy");
    $("modelInfo").textContent = "中文模型完成，正在下载并解压英文模型……";
    enModel = await window.Vosk.createModel(EN_MODEL_URL);

    clearInterval(modelTimer);
    $("progressBar").style.width = "100%";
    $("modelInfo").textContent =
      "中文和英文模型均已加载完成。开始后会同时识别两种语言并自动做语义纠错。";
    $("start").disabled = false;
    setStatus("中英双语模型已就绪", "on");
  } catch (error) {
    clearInterval(modelTimer);
    console.error(error);
    $("progressBar").className = "";
    $("loadModels").disabled = false;
    $("modelInfo").textContent = "模型加载失败：" + (error?.message || String(error));
    setStatus("双语模型加载失败，请重试", "error");
  } finally {
    loading = false;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.warn("Wake lock unavailable", error);
  }
}

function finalizeCurrentQuestion(reason = "检测到停顿") {
  if (!listening || finalizing || !cnRecognizer || !enRecognizer) return;
  if (!cnFinalParts.length && !enFinalParts.length && !cnPartial && !enPartial) return;

  finalizing = true;
  lastFinalizeAt = Date.now();
  setStatus(`${reason}，正在整理完整问题`, "busy");
  setDiagnostic(`${reason}，等待中文和英文模型输出最终结果……`);

  try { cnRecognizer.retrieveFinalResult(); } catch (error) { console.warn(error); }
  try { enRecognizer.retrieveFinalResult(); } catch (error) { console.warn(error); }

  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(() => {
    const rawCn = collapseSpaces([...cnFinalParts, cnPartial].join(" "));
    const rawEn = collapseSpaces([...enFinalParts, enPartial].join(" "));

    renderAnswerFromRecognition(rawCn, rawEn);
    resetQuestionBuffers();
    $("rawCn").textContent = rawCn || "未得到中文结果";
    $("rawEn").textContent = rawEn || "未得到英文结果";
  }, RESULT_WAIT_MS);
}

function updateMeter() {
  if (!listening || !analyser) return;

  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / data.length);
  const percent = Math.min(100, Math.max(1, rms * 650));
  $("meterFill").style.width = `${percent}%`;

  const now = Date.now();
  if (rms >= 0.014) {
    if (!speechStarted) {
      speechStarted = true;
      speechStartAt = now;
    }
    lastVoiceAt = now;
    if (rms < 0.035) $("levelText").textContent = "收到较小声音";
    else if (rms < 0.09) $("levelText").textContent = "正在收到清晰人声";
    else $("levelText").textContent = "声音较大";
  } else {
    $("levelText").textContent = "环境较安静";
    const spokeLongEnough = speechStarted && now - speechStartAt >= MIN_SPEECH_MS;
    const silenceLongEnough = lastVoiceAt && now - lastVoiceAt >= SILENCE_TO_ANSWER_MS;
    const notRecentlyFinalized = now - lastFinalizeAt >= SILENCE_TO_ANSWER_MS;
    if (spokeLongEnough && silenceLongEnough && notRecentlyFinalized && !finalizing) {
      finalizeCurrentQuestion("已等待约2.5秒");
    }
  }

  meterFrame = requestAnimationFrame(updateMeter);
}

async function startListening() {
  if (!cnModel || !enModel) {
    setStatus("请先加载中英双语模型", "error");
    return;
  }
  if (listening) return;

  try {
    setStatus("正在申请麦克风权限", "busy");
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    createRecognizers(audioContext.sampleRate);

    sourceNode = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    audioChunkCount = 0;
    processorNode.onaudioprocess = (event) => {
      if (!listening || !cnRecognizer || !enRecognizer) return;
      try {
        audioChunkCount += 1;
        cnRecognizer.acceptWaveform(event.inputBuffer);
        enRecognizer.acceptWaveform(event.inputBuffer);
        event.outputBuffer.getChannelData(0).fill(0);
      } catch (error) {
        console.error("Audio recognition failed", error);
        setDiagnostic("音频送入双语识别器失败：" + (error?.message || String(error)));
        setStatus("双语识别处理失败", "error");
      }
    };

    sourceNode.connect(analyser);
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    listening = true;
    resetQuestionBuffers();
    $("start").disabled = true;
    $("stop").disabled = false;
    $("forceResult").disabled = false;
    setDiagnostic(`中英双识别器已创建，实际采样率${audioContext.sampleRate}Hz。请说完整问题。`);
    setStatus(`${APP_VERSION} 正在持续监听`, "on");
    $("levelText").textContent = "麦克风已打开";
    await requestWakeLock();
    updateMeter();
  } catch (error) {
    console.error(error);
    setDiagnostic("麦克风启动失败：" + (error?.message || String(error)));
    setStatus("麦克风启动失败", "error");
    await stopListening();
  }
}

async function stopListening() {
  listening = false;
  clearTimeout(finalizeTimer);
  clearInterval(modelTimer);

  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = null;

  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch {}
  }
  try { sourceNode?.disconnect(); } catch {}
  try { analyser?.disconnect(); } catch {}
  try { silentGain?.disconnect(); } catch {}
  stream?.getTracks().forEach((track) => track.stop());

  try { cnRecognizer?.remove(); } catch {}
  try { enRecognizer?.remove(); } catch {}
  try { await audioContext?.close(); } catch {}
  try { await wakeLock?.release(); } catch {}

  cnRecognizer = null;
  enRecognizer = null;
  stream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  analyser = null;
  silentGain = null;
  wakeLock = null;
  resetQuestionBuffers();

  $("meterFill").style.width = "0";
  $("levelText").textContent = "麦克风已关闭";
  $("start").disabled = !(cnModel && enModel);
  $("stop").disabled = true;
  $("forceResult").disabled = true;
  setDiagnostic("监听已停止。");
  setStatus("监听已停止，双语模型仍可继续使用");
}

function matchManualQuestion() {
  const text = collapseSpaces($("question").value);
  if (!text) return;
  renderAnswerFromRecognition(text, text);
}

$("loadModels").addEventListener("click", loadModels);
$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("forceResult").addEventListener("click", () => finalizeCurrentQuestion("手动结束本题"));
$("manualAnswer").addEventListener("click", matchManualQuestion);
$("manualInput").addEventListener("click", () => {
  const value = prompt("请输入老师的问题：", $("question").value);
  if (value !== null) {
    $("question").value = value.trim();
    matchManualQuestion();
  }
});
$("clear").addEventListener("click", () => {
  resetQuestionBuffers();
  $("rawCn").textContent = "—";
  $("rawEn").textContent = "—";
  $("question").value = "";
  $("confidence").textContent = "等待语义匹配";
  $("matched").textContent = "等待完整问题";
  $("keywords").textContent = "关键词提示会显示在这里";
  $("answer").textContent = "老师说完问题并停顿约2.5秒后，程序会自动显示回答。";
  setDiagnostic(listening ? "等待老师说话……" : "等待开始监听……");
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("answer").textContent);
    setStatus("回答已复制", listening ? "on" : "");
  } catch {
    setStatus("复制失败，请长按文字复制", "error");
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && listening && !wakeLock) await requestWakeLock();
});

if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  $("start").disabled = true;
  setStatus("当前浏览器不支持麦克风或Web Audio", "error");
}

setStatus(`${APP_VERSION} 已加载，请先加载中英双语模型`, "on");
